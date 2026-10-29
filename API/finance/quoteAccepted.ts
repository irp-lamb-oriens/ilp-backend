/**
 * API/finance/quoteAccepted.ts — what follows a member's "Accept" (REL).
 * ──────────────────────────────────────────────────────────────────────────
 * Both accept routes (/api/client-status/me/quotes/:id/accept and the older
 * /api/client-status/project/:id/accept-quote) call `onQuoteAccepted`:
 *
 *   1. open the settlement `quoteSettlements/{quoteId}` once, with one
 *      pending provider payment per lawyer for their fee (the cost lines,
 *      never the client price), and `providerIds` so the lawyer's Finance
 *      finds it whoever the member is assigned to later;
 *   2. audit `quote.accepted`;
 *   3. move linked opportunities to won (syncOpportunitiesForQuote).
 *
 * Staff then record the member's payment and the payout in the settlement
 * editor (PUT /api/dashboard/finance/settlements/:quoteId, admin only).
 * Never throws: the acceptance itself is already saved.
 */

import get from "../../db/get.ts";
import put from "../../db/put.ts";
import log from "../../helper/log.ts";
import auditLog from "../../helper/auditLog.ts";
import { quoteKey } from "../../schemas/quoteStatus.ts";
import { syncOpportunitiesForQuote } from "../opportunities/opportunitiesRouter.ts";
import { trackServerStep } from "../journeys/track.ts"; // JOURNEYS

type Doc = Record<string, unknown>;
export const SETTLEMENTS = "quoteSettlements";

const num = (v: unknown) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Each lawyer's fee on a quote: the line amounts (cost) per line provider;
 * lines without one belong to the quote's lawyer (providerIds[0]), else the
 * member's assigned lawyer. Seed quotes use `lines` with `amountMinor`. Pure.
 */
export function lawyerFeesOf(quote: Doc, fallbackProviderId?: string | null): Array<{ providerId: string; amount: number }> {
  const owner = (Array.isArray(quote.providerIds) && typeof quote.providerIds[0] === "string" ? quote.providerIds[0] : null) ?? fallbackProviderId ?? null;
  const lines: Doc[] = Array.isArray(quote.lineItems)
    ? quote.lineItems as Doc[]
    : (Array.isArray(quote.lines) ? (quote.lines as Doc[]).map((l): Doc => ({ ...l, amount: l.amount ?? num(l.amountMinor) / 100 })) : []);
  const by = new Map<string, number>();
  for (const l of lines) {
    if (!l || l.isOptional === true && l.selected === false) continue;
    const pid = typeof l.providerId === "string" && l.providerId ? l.providerId : owner;
    if (!pid) continue;
    by.set(pid, (by.get(pid) ?? 0) + num(l.amount));
  }
  return [...by.entries()].filter(([, a]) => a > 0).map(([providerId, amount]) => ({ providerId, amount: round2(amount) }));
}

/** Distinct provider ids of a settlement's payout rows (for the lawyer Finance query). Pure. */
export function providerIdsOf(providerPayments: unknown): string[] {
  const rows = Array.isArray(providerPayments) ? providerPayments as Doc[] : [];
  return [...new Set(rows.map((p) => p?.providerId).filter((x): x is string => typeof x === "string" && !!x))];
}

/** The settlement skeleton for an accepted quote. Pure. */
export function settlementFor(clientId: string, quote: Doc, names: Map<string, string>, fallbackProviderId: string | null, nowIso: string): Doc {
  const quoteId = quoteKey(quote);
  const fees = lawyerFeesOf(quote, fallbackProviderId);
  const providerPayments = fees.map((f) => ({
    id: `pp-${quoteId}-${f.providerId}`.slice(0, 120),
    providerId: f.providerId,
    providerName: names.get(f.providerId) ?? null,
    date: null,
    amount: f.amount,
    paid: false,
    note: "Fee for the accepted quote",
  }));
  return {
    quoteId,
    clientId,
    clientPayments: [],
    providerPayments,
    extraCharges: [],
    providerIds: providerIdsOf(providerPayments),
    openedAt: nowIso,
    updatedAt: nowIso,
    updatedBy: "system",
  };
}

export async function onQuoteAccepted(clientId: string, quote: Doc, actor: { email: string; role: string }): Promise<void> {
  const quoteId = quoteKey(quote);
  await trackServerStep("paid_work_accepted", { clientId }); // JOURNEYS (first accepted quote)
  try {
    const existing = (await get(SETTLEMENTS, quoteId).catch(() => null)) as Doc | null;
    if (!existing) {
      const client = (await get("clients", clientId).catch(() => null)) as Doc | null;
      const fallback = typeof client?.assignedProviderId === "string" ? client.assignedProviderId : null;
      const ids = lawyerFeesOf(quote, fallback).map((f) => f.providerId);
      const names = new Map<string, string>();
      for (const id of ids) {
        const p = (await get("providers", id).catch(() => null)) as Doc | null;
        if (typeof p?.name === "string") names.set(id, p.name);
      }
      await put(SETTLEMENTS, quoteId, settlementFor(clientId, quote, names, fallback, new Date().toISOString()));
    } else if (!Array.isArray(existing.providerIds)) {
      await put(SETTLEMENTS, quoteId, { providerIds: providerIdsOf(existing.providerPayments) });
    }
  } catch (err) {
    log(`[finance] settlement for quote ${quoteId} not opened: ${err instanceof Error ? err.message : err}`, "error");
  }
  await auditLog({
    actor: { uid: actor.email, email: actor.email, role: actor.role },
    action: "quote.accepted",
    target: `clients/${clientId}`,
    meta: { quoteId, total: quote.total ?? null, currency: quote.currency ?? "USD" },
  }).catch(() => undefined);
  await syncOpportunitiesForQuote(clientId, quoteId);
}
