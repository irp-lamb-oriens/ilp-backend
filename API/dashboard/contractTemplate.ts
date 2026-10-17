/**
 * contractTemplate.ts — the proposal text the client actually saw, resolved for
 * one specific quote and rendered into plain text for the contract.
 *
 * The status page renders `quote.blocks` (the per-quote copy of the chosen
 * template) through BlockRenderer, substituting `{{merge.fields}}` against the
 * client doc. The contract has to carry those same words, so this module
 * repeats that resolution server-side:
 *
 *   1. `quote.blocks` when present — the snapshot the client was shown.
 *   2. otherwise the template chosen for this client (see
 *      resolveQuoteTemplateBlocks), including any per-client rewrite of it.
 *
 * Text-carrying blocks (html, heading, banner, accordion) become plain text
 * with emoji stripped: decoration reads as noise in a legal document.
 * Layout and marketing blocks (image, quoteTable, accept, testimonials,
 * reviews, partners) are skipped: pricing and the signature render elsewhere in
 * the contract, and logos do not belong in a legal document.
 */

import get from "../../db/get.ts";
import { decodeEntities, sanitizeContractHtml, stripEmoji } from "./contractHtml.ts";

export interface ContractTemplateTextBlock {
  kind: "heading" | "body";
  text: string;
  /**
   * The same content with its structure intact (headings, emphasis, lists,
   * tables) and every style dropped. The PDF renders this when present and
   * falls back to `text` for snapshots stored before it existed.
   */
  html?: string;
  /** The template section this block belongs to, when the template uses them. */
  section?: string | null;
}

// ── Merge fields ─────────────────────────────────────────────────────────────
// Mirrors the frontend mergeFields, retargeted to ILP's legal taxonomy. Keep the
// two in sync.

const MERGE_TOKEN_PATHS: Array<[token: string, path: string]> = [
  ["{{client.fullName}}", "fullName"],
  ["{{client.name}}", "name"],
  ["{{client.surname}}", "surname"],
  ["{{client.email}}", "email"],
  ["{{matter.legalArea}}", "legalArea"],
  ["{{matter.legalMatter}}", "legalMatter"],
  ["{{matter.jurisdiction}}", "jurisdiction"],
  ["{{matter.documents}}", "documents"],
];

/** Flatten a client doc into the merge context. */
export function buildMergeContext(project: any): Record<string, string> {
  if (!project || typeof project !== "object") return {};
  const entries = Array.isArray(project.consultations) ? project.consultations : [];
  const latest = entries[entries.length - 1] ?? {};

  const pick = (key: string) => String(project[key] ?? latest[key] ?? "").trim();

  let documentsStr = "";
  const rawDocs = project.documents ?? latest.documents;
  if (Array.isArray(rawDocs) && rawDocs.length > 0) {
    documentsStr = rawDocs
      .map((d: any) =>
        d && typeof d === "object"
          ? String(d.name ?? d.title ?? "").trim()
          : String(d ?? "").trim()
      )
      .filter(Boolean)
      .join(", ");
  } else if (typeof rawDocs === "string") {
    documentsStr = rawDocs;
  }

  return {
    fullName: [pick("name"), pick("surname")].filter(Boolean).join(" "),
    name: pick("name"),
    surname: pick("surname"),
    email: pick("email"),
    legalArea: pick("legalArea"),
    legalMatter: pick("legalMatter"),
    jurisdiction: pick("jurisdiction"),
    documents: documentsStr,
  };
}

/** Substitute merge tokens, then strip any token that had no value. */
export function renderMergeFields(html: string, ctx: Record<string, string>): string {
  if (!html) return html ?? "";
  let out = String(html);
  for (const [token, path] of MERGE_TOKEN_PATHS) {
    const value = ctx[path];
    if (value) out = out.split(token).join(value);
  }
  return out.replace(/\{\{[^}]+\}\}/g, "");
}

// ── HTML → text ──────────────────────────────────────────────────────────────
// Entity decoding and emoji stripping live in contractHtml.ts, which both the
// text path below and the formatted PDF path share.

/** Strip HTML to readable text, preserving block-level line breaks. */
export function htmlToText(html: string): string {
  if (!html) return "";
  let s = String(html);
  // Bullets survive as "- item" so a list still reads as a list.
  s = s.replace(/<li[^>]*>/gi, "\n- ");
  // Keep <summary> (accordion title) on its own line.
  s = s.replace(/<summary[^>]*>([\s\S]*?)<\/summary>/gi, (_m, c) => `\n${c}\n`);
  s = s.replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li|tr|section|blockquote)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/?(ul|ol|table|thead|tbody|details)([^>]*)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  return stripEmoji(decodeEntities(s))
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Blocks whose content is narrative text worth putting in a contract. */
const TEXT_BLOCK_TYPES = new Set(["html", "heading", "banner", "accordion"]);

/**
 * Emit a block carrying both representations: `text` for older readers and the
 * style-free `html` the PDF renders. A block whose markup sanitizes down to
 * nothing is skipped entirely.
 */
function push(
  kind: "heading" | "body",
  html: string,
  section: string | null,
  out: ContractTemplateTextBlock[],
) {
  const text = htmlToText(html);
  if (!text) return;
  const clean = sanitizeContractHtml(html);
  out.push(clean ? { kind, text, html: clean, section } : { kind, text, section });
}

function pushRichBlock(
  html: string,
  section: string | null,
  out: ContractTemplateTextBlock[],
) {
  const headingMatch = /<(h1|h2|h3)[^>]*>([\s\S]*?)<\/\1>/i.exec(html);
  if (headingMatch) {
    push("heading", headingMatch[2], section, out);
    push("body", html.replace(/<(h1|h2|h3)[^>]*>[\s\S]*?<\/\1>/i, " "), section, out);
    return;
  }
  push("body", html, section, out);
}

/**
 * Turn template blocks into ordered contract text, substituting merge fields
 * against `clientDoc` exactly as the status page does.
 */
export function extractTemplateText(
  blocks: any[],
  clientDoc: any,
): ContractTemplateTextBlock[] {
  const ctx = buildMergeContext(clientDoc);
  const out: ContractTemplateTextBlock[] = [];

  for (const block of Array.isArray(blocks) ? blocks : []) {
    const type = String(block?.type ?? "");
    if (!TEXT_BLOCK_TYPES.has(type)) continue;

    const section = typeof block?.section === "string" && block.section ? block.section : null;
    const html = renderMergeFields(String(block?.html ?? ""), ctx);
    if (!html.trim()) continue;

    if (type === "heading") {
      push("heading", html, section, out);
    } else if (type === "accordion") {
      // The summary is the accordion's title, so it becomes a heading and the
      // panel below it becomes the body.
      const summaryMatch = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(html);
      if (summaryMatch) push("heading", summaryMatch[1], section, out);
      push("body", html.replace(/<summary[^>]*>[\s\S]*?<\/summary>/gi, " "), section, out);
    } else {
      pushRichBlock(html, section, out);
    }
  }

  return out;
}

/**
 * The blocks this client actually saw on the status page, resolved in the same
 * order the page itself resolves them:
 *
 *   1. `quote.blocks` — a proposal document authored directly on the quote.
 *   2. The chosen template, which is `quote.templateId` when the quote pins one
 *      and otherwise `clientDoc.selectedQuoteTemplateId`.
 *   3. Within that template, a per-client rewrite in
 *      `clientDoc.proposalOverrides[templateId].blocks` wins over the shared
 *      `quote_templates/{templateId}.blocks`.
 *
 * Never throws: an unreadable template just means the contract omits the
 * narrative rather than failing the client's acceptance.
 */
export async function resolveQuoteTemplateBlocks(
  quote: any,
  clientDoc?: any,
): Promise<any[]> {
  if (Array.isArray(quote?.blocks) && quote.blocks.length > 0) return quote.blocks;

  const pinned = typeof quote?.templateId === "string" ? quote.templateId.trim() : "";
  const chosen = typeof clientDoc?.selectedQuoteTemplateId === "string"
    ? clientDoc.selectedQuoteTemplateId.trim()
    : "";
  const templateId = pinned || chosen;
  if (!templateId) return [];

  // A staff rewrite for THIS client replaces the shared template, exactly as on
  // the status page. No DB read is needed: it lives on the client doc.
  const override = clientDoc?.proposalOverrides?.[templateId];
  if (Array.isArray(override?.blocks) && override.blocks.length > 0) return override.blocks;

  try {
    const template = await get("quote_templates", templateId);
    return Array.isArray(template?.blocks) ? template.blocks : [];
  } catch {
    return [];
  }
}