/**
 * scripts/placeholderOps.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Shared pieces of the placeholder seed and cleanup scripts: the deletion
 * rule (placeholder: true AND a ph_ id), the collection list, a small
 * concurrency pool and a table printer. Pure, so tests can import it.
 */

import { isPlaceholderId } from "../helper/placeholder.ts";

type Doc = Record<string, unknown>;

/** Every collection the seed (or the app, for seed members) can write placeholder docs to. */
export const PLACEHOLDER_COLLECTIONS = [
  "providers", "lawyer_availability", "leads", "memberships", "matters", "consultations", "handoffs", "csm_tasks",
  "obligations", "opportunities", "funnel_events", "member_feedback", "consents", "privacy_requests",
  "member_documents", "audit_log", "quoteSettlements", "financeLedger", "invoices",
  "journey_events", "journey_daily", "journey_exposures", "experiments", "outreach", // JOURNEYS
  "reviews", "lawyer_ratings", "routing_gaps", "staff_notifications", // ROUTING
  "work_offers", // COMMS-P2
  "quote_service_types", "quote_labels", "quote_line_templates", "quote_templates", "vendors", "posts", "updates",
  "clients", // last: subcollections and records first
] as const;
export const CLIENT_SUBCOLLECTIONS = ["pricing_requests", "quoteRequests"] as const;

export interface SelectOptions {
  batch?: string;
  includeAlias?: boolean;
  /** Client ids of login-alias placeholder members (clients docs with placeholderAlias: true). */
  aliasClientIds?: ReadonlySet<string>;
}

/**
 * Pure: which of these documents may be deleted. A document must carry
 * `placeholder: true` AND have a ph_ id; the alias exceptions apply only with
 * includeAlias. Exported for tests.
 */
export function selectForDeletion(collection: string, docs: Doc[], o: SelectOptions = {}): { remove: Doc[]; kept: Doc[] } {
  const out = { remove: [] as Doc[], kept: [] as Doc[] };
  for (const d of docs) {
    if (d.placeholder !== true) continue; // not ours: not even counted
    if (o.batch && d.placeholderBatch !== o.batch) continue;
    const id = String(d.id ?? "");
    const ok = isPlaceholderId(id) ||
      (!!o.includeAlias && collection === "clients" && d.placeholderAlias === true) ||
      (!!o.includeAlias && collection !== "clients" && typeof d.clientId === "string" && !!o.aliasClientIds?.has(d.clientId));
    (ok ? out.remove : out.kept).push(d);
  }
  return out;
}

/**
 * Pure: the account-seed cleanup rule (removePlaceholders.ts --accounts).
 * Removes placeholder docs of `batch` with a ph_ id, the missing-account docs
 * that batch created (`placeholderAccount: true`, e.g. lawyer_availability at
 * the real lawyer's id), and app-derived placeholder records (batch "derived")
 * about the batch's members or the member account. Real docs (no
 * `placeholder: true`) are never selected; they are restored instead.
 */
export function selectAccountDeletion(collection: string, docs: Doc[], batch: string, clientIds: ReadonlySet<string>): { remove: Doc[]; kept: Doc[] } {
  const out = { remove: [] as Doc[], kept: [] as Doc[] };
  for (const d of docs) {
    if (d.placeholder !== true) continue;
    const id = String(d.id ?? "");
    const mine = d.placeholderBatch === batch && (isPlaceholderId(id) || d.placeholderAccount === true);
    const derived = d.placeholderBatch === "derived" && isPlaceholderId(id) && typeof d.clientId === "string" && clientIds.has(d.clientId);
    if (mine || derived) out.remove.push(d);
    else if (d.placeholderBatch === batch) out.kept.push(d);
  }
  return out;
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function printTable(rows: Array<[string, number | string, ...Array<number | string>]>, head: string[]): void {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const line = (cells: Array<string | number>) => "| " + cells.map((c, i) => String(c).padEnd(widths[i])).join(" | ") + " |";
  console.log(line(head));
  console.log("| " + widths.map((w) => "-".repeat(w)).join(" | ") + " |");
  for (const r of rows) console.log(line(r));
}
