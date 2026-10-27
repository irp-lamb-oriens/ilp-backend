/**
 * quoteStatus.ts — one reading of a quote's status for every view.
 * ──────────────────────────────────────────────────────────────────────────
 * Two identical copies live in the repo (keep them byte-identical):
 *   server/schemas/quoteStatus.ts      (Deno)
 *   frontend/src/lib/quoteStatus.ts    (Next.js)
 *
 * Quotes are stored with two vocabularies: the staff/lawyer flow writes
 * `sent_to_client` / `client_accepted` (+ `clientAcceptedAt`), the member
 * accept routes and older data write `sent` / `accepted` (+ `acceptedAt`).
 * Every reader maps the stored status to a phase here, so a quote staff sent
 * shows up for the member, and a quote the member accepted counts as won for
 * staff, finance and the lawyer. Stored values are never rewritten.
 */

export type QuotePhase = "draft" | "internal_review" | "awaiting_client" | "accepted" | "declined";

/** Every stored spelling → its phase. */
export const QUOTE_STATUS_PHASE: Record<string, QuotePhase> = {
  draft: "draft",
  pending_approval: "internal_review",
  changes_requested: "internal_review",
  approved: "internal_review",
  sent: "awaiting_client",
  sent_to_client: "awaiting_client",
  received: "awaiting_client",
  accepted: "accepted",
  client_accepted: "accepted",
  paid: "accepted",
  declined: "declined",
  rejected: "declined",
  client_declined: "declined",
};

export const QUOTE_PHASE_LABEL: Record<QuotePhase, string> = {
  draft: "Draft",
  internal_review: "In review",
  awaiting_client: "Sent, awaiting answer",
  accepted: "Accepted",
  declined: "Declined",
};

type QuoteLike = { status?: unknown; clientAcceptedAt?: unknown; acceptedAt?: unknown; declinedAt?: unknown } | null | undefined;

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The quote's phase; an acceptance timestamp wins over the status text. Null when unknown. */
export function quotePhase(q: QuoteLike): QuotePhase | null {
  if (!q) return null;
  if (text(q.clientAcceptedAt) || text(q.acceptedAt)) return "accepted";
  const phase = QUOTE_STATUS_PHASE[text(q.status).trim().toLowerCase()];
  if (phase) return phase;
  return text(q.declinedAt) ? "declined" : null;
}

export const isQuoteAwaitingClient = (q: QuoteLike) => quotePhase(q) === "awaiting_client";
export const isQuoteAccepted = (q: QuoteLike) => quotePhase(q) === "accepted";
export const isQuoteDeclined = (q: QuoteLike) => quotePhase(q) === "declined";
/** Sent to the member at some point (awaiting, accepted or declined). */
export const isQuoteClientFacing = (q: QuoteLike) => {
  const p = quotePhase(q);
  return p === "awaiting_client" || p === "accepted" || p === "declined";
};

/** The quote's id: `quoteId` (staff flow) or `id` (member flow, older data). */
export function quoteKey(q: { quoteId?: unknown; id?: unknown } | null | undefined): string {
  return text(q?.quoteId) || text(q?.id);
}

export function quoteSentAt(q: { sentToClientAt?: unknown; sentAt?: unknown; createdAt?: unknown } | null | undefined): string {
  return text(q?.sentToClientAt) || text(q?.sentAt) || text(q?.createdAt);
}

export function quoteAcceptedAt(q: { clientAcceptedAt?: unknown; acceptedAt?: unknown } | null | undefined): string {
  return text(q?.clientAcceptedAt) || text(q?.acceptedAt);
}
