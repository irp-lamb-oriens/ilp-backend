/**
 * API/analytics/funnel.ts — PMF measurement (P2).
 *
 * Funnel events: one document per (step, anonId) in `funnel_events`, so a
 * count of documents is a count of people. No PII: a random browser id, an
 * optional leadId and a first-touch source (utm_source or referrer host).
 * `first_call_booked` is recorded server-side when a consultation is booked
 * (hooked from members/events.ts), once per member.
 *
 * Staff summary (`pmfSummary`): funnel counts + step conversion over a window,
 * average post-call rating, NPS from the monthly question, cancel reasons.
 */

import get from "../../db/get.ts";
import put from "../../db/put.ts";
import query from "../../db/query.ts";
import log from "../../helper/log.ts";
import { COLLECTIONS, type FunnelEvent, type FunnelStep, type MemberFeedback } from "../../schemas/contracts.ts";

export const FUNNEL_STEPS: FunnelStep[] = [
  "check_started",
  "check_completed",
  "check_email_given",
  "join_started",
  "join_paid",
  "first_call_booked",
];

const ANON_RE = /^[A-Za-z0-9_-]{8,64}$/;
const LEAD_RE = /^[A-Za-z0-9_-]{1,100}$/;
const SOURCE_RE = /^[a-z0-9][a-z0-9._-]{0,59}$/;

/** Pure: validate a browser-sent event. Returns the clean event or an error. */
export function parseFunnelEvent(body: Record<string, unknown>, now: Date = new Date()): FunnelEvent | { error: string } {
  const step = body.step as FunnelStep;
  if (!FUNNEL_STEPS.includes(step) || step === "first_call_booked") return { error: "Unknown step." };
  const anonId = typeof body.anonId === "string" ? body.anonId : "";
  if (!ANON_RE.test(anonId)) return { error: "Bad id." };
  const ev: FunnelEvent = { id: `${step}_${anonId}`, step, anonId, at: now.toISOString() };
  if (typeof body.leadId === "string" && LEAD_RE.test(body.leadId)) ev.leadId = body.leadId;
  const src = typeof body.source === "string" ? body.source.trim().toLowerCase().slice(0, 60) : "";
  if (SOURCE_RE.test(src)) ev.source = src;
  return ev;
}

/** Store an event once per (step, anonId). Returns false when already recorded. */
export async function recordFunnelEvent(ev: FunnelEvent): Promise<boolean> {
  const existing = await get(COLLECTIONS.funnelEvents, ev.id).catch(() => null);
  if (existing) return false;
  await put(COLLECTIONS.funnelEvents, ev.id, ev as unknown as Record<string, unknown>);
  return true;
}

/** Server-side: first booked call for a member (idempotent per member). Never throws. */
export async function recordFirstCallBooked(clientId: string): Promise<void> {
  try {
    if (!clientId) return;
    const id = `first_call_booked_${clientId}`.replace(/[^A-Za-z0-9_-]/g, "_");
    if (await get(COLLECTIONS.funnelEvents, id).catch(() => null)) return;
    const c = (await get("clients", clientId).catch(() => null)) as Record<string, unknown> | null;
    const anon = typeof c?.funnelAnonId === "string" && ANON_RE.test(c.funnelAnonId) ? c.funnelAnonId : `member_${id.slice(18, 60)}`;
    const ev: FunnelEvent = { id, step: "first_call_booked", anonId: anon, clientId, at: new Date().toISOString() };
    if (typeof c?.funnelSource === "string") ev.source = c.funnelSource;
    await put(COLLECTIONS.funnelEvents, id, ev as unknown as Record<string, unknown>);
  } catch (err) {
    log(`[funnel] first_call_booked failed: ${err instanceof Error ? err.message : err}`, "error");
  }
}

// ─── Staff summary ────────────────────────────────────────────────────────

export interface PmfSummary {
  days: number;
  since: string;
  funnel: Array<{ step: FunnelStep; count: number; fromPrevious: number | null }>;
  sources: Array<{ source: string; checks: number; paid: number }>;
  postCall: { average: number | null; count: number; low: number };
  nps: { score: number | null; count: number; promoters: number; passives: number; detractors: number; average: number | null };
  cancels: { count: number; reasons: Array<{ reason: string; count: number }> };
}

/** Pure: the staff summary from raw rows. Exported for tests. */
export function summarize(
  events: FunnelEvent[],
  feedback: Array<MemberFeedback & { reasonKey?: string | null }>,
  now: Date,
  days: number,
): PmfSummary {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const ev = events.filter((e) => e.at >= since);
  const fb = feedback.filter((f) => f.at >= since);
  let prev: number | null = null;
  const funnel = FUNNEL_STEPS.map((step) => {
    const count = ev.filter((e) => e.step === step).length;
    const fromPrevious = prev === null ? null : prev > 0 ? count / prev : null;
    prev = count;
    return { step, count, fromPrevious };
  });
  const bySource = new Map<string, { checks: number; paid: number }>();
  for (const e of ev) {
    if (e.step !== "check_started" && e.step !== "join_paid") continue;
    const k = e.source || "direct";
    const row = bySource.get(k) ?? { checks: 0, paid: 0 };
    if (e.step === "check_started") row.checks++;
    else row.paid++;
    bySource.set(k, row);
  }
  const post = fb.filter((f) => f.kind === "post_call" && typeof f.score === "number");
  const monthly = fb.filter((f) => f.kind === "monthly" && typeof f.score === "number");
  const promoters = monthly.filter((f) => f.score! >= 9).length;
  const detractors = monthly.filter((f) => f.score! <= 6).length;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const cancels = fb.filter((f) => f.kind === "cancel");
  const reasons = new Map<string, number>();
  for (const c of cancels) {
    const r = (c.comment ?? "No reason given").split(" — ")[0];
    reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }
  return {
    days,
    since,
    funnel,
    sources: [...bySource.entries()].map(([source, v]) => ({ source, ...v })).sort((a, b) => b.checks - a.checks).slice(0, 8),
    postCall: { average: avg(post.map((f) => f.score!)), count: post.length, low: post.filter((f) => f.score! <= 2).length },
    nps: {
      score: monthly.length ? Math.round(((promoters - detractors) / monthly.length) * 100) : null,
      count: monthly.length,
      promoters,
      passives: monthly.length - promoters - detractors,
      detractors,
      average: avg(monthly.map((f) => f.score!)),
    },
    cancels: { count: cancels.length, reasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count) },
  };
}

export async function pmfSummary(days: number, now: Date = new Date()): Promise<PmfSummary> {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const [events, feedback] = await Promise.all([
    query(COLLECTIONS.funnelEvents, [{ field: "at", op: "GREATER_THAN_OR_EQUAL", value: since }]).catch(() => []),
    query(COLLECTIONS.feedback, [{ field: "at", op: "GREATER_THAN_OR_EQUAL", value: since }]).catch(() => []),
  ]);
  return summarize(events as unknown as FunnelEvent[], feedback as unknown as MemberFeedback[], now, days);
}
