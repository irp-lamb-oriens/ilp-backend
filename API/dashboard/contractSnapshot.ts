/**
 * contractSnapshot.ts — the serializable record of what a client agreed to.
 *
 * Stored on the quote as `contractSnapshot` when the client accepts, and fed to
 * the PDF renderer. Keeping the data (rather than a binary blob) in Firestore
 * means the contract can be regenerated at any time, and a later edit to the
 * quote never rewrites history: the snapshot is what was signed.
 *
 * It captures three things the client actually saw on the status page:
 *   • the proposal text of THIS quote's template, merge fields resolved,
 *   • the exact options they selected (and the ones always included),
 *   • the legal-matter facts that are terms of the engagement.
 */

import { extractContractFields, type ContractField } from "./contractFields.ts";
import { extractTemplateText, type ContractTemplateTextBlock } from "./contractTemplate.ts";
import { lineClientPrice } from "./quotePricing.ts";

/** How a service came to be on the contract. */
export type ContractServiceRole = "required" | "optional" | "fixed" | "line";

export interface ContractService {
  /** Group or line id the service came from. */
  id: string;
  title: string;
  /** Client-visible description of the group, when the quote carries one. */
  description: string | null;
  /** What the client pays for this service. */
  price: number;
  /**
   * `required` — the package the client chose between alternatives.
   * `optional` — an add-on the client ticked.
   * `fixed`    — always billed, never offered as a choice.
   * `line`     — a legacy flat quote's line item.
   */
  role: ContractServiceRole;
}

export interface ContractSnapshot {
  /** Human-readable contract reference (the quote id). */
  contractRef: string;
  quoteId: string;
  clientId: string;
  /** Quote title, shown as the subject of the agreement. */
  quoteTitle: string;
  /** ISO timestamp of the client's acceptance. */
  acceptedAt: string;
  /** The full legal name the client typed to accept. This is the signature. */
  signatureName: string;
  clientEmail: string;
  /** Legal-matter facts that are terms of the agreement (whitelisted, non-PII). */
  fields: ContractField[];
  /** The proposal text of this quote's template, merge fields resolved. */
  templateText: ContractTemplateTextBlock[];
  /** Which template the text came from, when the quote references one. */
  templateId: string | null;
  services: ContractService[];
  total: number;
  currency: string;
  /** Broad scope description shown above the service table. */
  overallDescription: string | null;
  /** When the snapshot itself was built. */
  generatedAt: string;
  /**
   * Ordered installment schedule in percent of the agreed total (e.g. 35, 65).
   * Only set for accepted quotes; absent for legacy contracts snapshotted before
   * this existed. The FIRST segment is the reservation / initial payment shown
   * in the client email and the PDF's payment section.
   */
  paymentSchedule: number[] | null;
  /**
   * Static bank-account details (decided as an image, not text) rendered in the
   * client email body. Null until the config holds an image asset.
   */
  bankInfoImageUrl: string | null;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function groupPrice(group: any): number {
  const items = Array.isArray(group?.lineItems) ? group.lineItems : [];
  return round2(items.reduce((sum: number, li: any) => sum + lineClientPrice(li), 0));
}

function groupRole(group: any): ContractServiceRole {
  const role = group?.role;
  if (role === "fixed") return "fixed";
  if (role === "optional") return "optional";
  return "required";
}

/**
 * The services the client actually agreed to.
 *
 * Grouped quotes are authoritative: every `fixed` group plus the groups named
 * in `selectedGroupIds`. A legacy flat quote falls back to its selected line
 * items, and a quote with no recorded selection bills in full.
 */
export function acceptedServices(quote: any): ContractService[] {
  const groups = Array.isArray(quote?.lineGroups) ? quote.lineGroups : [];
  const selectedGroupIds: string[] = Array.isArray(quote?.selectedGroupIds)
    ? quote.selectedGroupIds
    : [];

  if (groups.length > 0) {
    const chosen = new Set(selectedGroupIds);
    const billed = groups.filter(
      (g: any) => g?.role === "fixed" || chosen.has(g?.groupId) || selectedGroupIds.length === 0,
    );
    return billed.map((g: any) => ({
      id: String(g?.groupId ?? ""),
      title: String(g?.title || "Legal services"),
      description: typeof g?.description === "string" && g.description.trim()
        ? g.description.trim()
        : null,
      price: groupPrice(g),
      role: groupRole(g),
    }));
  }

  const lineItems = Array.isArray(quote?.lineItems) ? quote.lineItems : [];
  const selectedLineItemIds: string[] = Array.isArray(quote?.selectedLineItemIds)
    ? quote.selectedLineItemIds
    : [];
  const billedItems = selectedLineItemIds.length > 0
    ? lineItems.filter((li: any) => selectedLineItemIds.includes(li?.lineId))
    : lineItems;

  return billedItems.map((li: any) => ({
    id: String(li?.lineId ?? ""),
    title: String(li?.label || "Legal services"),
    description: typeof li?.notes === "string" && li.notes.trim() ? li.notes.trim() : null,
    price: lineClientPrice(li),
    role: "line" as const,
  }));
}

export interface BuildContractSnapshotOptions {
  acceptedAt?: string;
  signatureName?: string;
  /**
   * The template blocks this quote renders on the status page. Resolved by the
   * caller (see `resolveQuoteTemplateBlocks`) because reading a referenced
   * template document is async, while this builder stays pure and synchronous.
   * Defaults to the quote's own `blocks`.
   */
  templateBlocks?: any[] | null;
}

/**
 * Build the contract snapshot from the accepted quote and its client doc.
 *
 * `acceptedAt` and `signatureName` default to the values the accept endpoint
 * stamped on the quote, so regenerating the PDF later produces the same
 * document.
 */
export function buildContractSnapshot(
  quote: any,
  clientDoc: any,
  overrides: BuildContractSnapshotOptions = {},
): ContractSnapshot {
  const services = acceptedServices(quote);
  const servicesTotal = round2(services.reduce((sum, s) => sum + s.price, 0));
  const finalBilled = typeof quote?.finalBilledTotal === "number" ? quote.finalBilledTotal : null;
  const quoteTotal = typeof quote?.total === "number" ? quote.total : 0;
  // The accept endpoint's finalBilledTotal is authoritative when present; the
  // summed services are the fallback for a quote accepted before that existed.
  const total = finalBilled ?? (services.length > 0 ? servicesTotal : quoteTotal);

  const quoteId = String(quote?.quoteId ?? quote?.id ?? "");
  const blocks = overrides.templateBlocks ?? (Array.isArray(quote?.blocks) ? quote.blocks : []);

  return {
    contractRef: quoteId,
    quoteId,
    clientId: String(quote?.clientId ?? clientDoc?.id ?? ""),
    quoteTitle: String(quote?.title || "Legal services"),
    acceptedAt: overrides.acceptedAt
      ?? (typeof quote?.acceptedAt === "string" ? quote.acceptedAt : new Date().toISOString()),
    signatureName: String(
      overrides.signatureName
        ?? quote?.typedFullName
        ?? [clientDoc?.name, clientDoc?.surname].filter(Boolean).join(" ")
        ?? "",
    ).trim(),
    clientEmail: String(clientDoc?.email ?? "").trim(),
    fields: extractContractFields(clientDoc),
    templateText: extractTemplateText(blocks, clientDoc),
    templateId: typeof quote?.templateId === "string" && quote.templateId ? quote.templateId : null,
    services,
    total,
    currency: String(quote?.currency || "USD").toUpperCase(),
    overallDescription: typeof quote?.clientDescription === "string" && quote.clientDescription.trim()
      ? quote.clientDescription.trim()
      : null,
    paymentSchedule: Array.isArray(quote?.paymentSchedule)
      ? quote.paymentSchedule
          .map((p: any) => (typeof p === "number" ? p : Number(p)))
          .filter((p: number) => Number.isFinite(p))
      : null,
    bankInfoImageUrl: typeof quote?.bankInfoImageUrl === "string" && quote.bankInfoImageUrl.trim()
      ? quote.bankInfoImageUrl.trim()
      : null,
    generatedAt: new Date().toISOString(),
  };
}