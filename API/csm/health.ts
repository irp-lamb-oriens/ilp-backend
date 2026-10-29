/**
 * API/csm/health.ts — member health score for the CSM portal (COMMS-P3).
 * ──────────────────────────────────────────────────────────────────────────
 * Pure. One number from 0 to 100 per member, with the reasons behind it, so
 * a CSM sees at a glance who needs them and why. The score starts at 100 and
 * each signal below takes points off. The bands (contracts HEALTH_BANDS) are
 * Healthy 75 and up, Watch 50 to 74, At risk under 50. A cancelled
 * membership has no score ("Ended").
 *
 * Signal (input)                        Points off
 * ─────────────────────────────────────  ─────────────────────────────────
 * Payment failed (status past_due)      35
 * Asked to cancel (cancelAtPeriodEnd)   30
 * Payment pending (status pending)      10
 * Profile completeness < 40%            20   (< 70% not consultation-ready: 12)
 * Days since last CSM contact           > 30 days: 15, > 14 days: 8,
 *                                       never contacted after 2 days: 12
 * Calls used                            no call used and 21+ days into the
 *                                       period: 10 (paying without using it)
 * Last post-call rating <= 2 of 5       20   (3 of 5: 6)
 * Last monthly score (NPS) <= 6 of 10   15   (7 or 8: 5)
 * Deadlines in the next 14 days         5 each, at most 10
 * Deadlines already past, not handled   10
 * Open quotes waiting 5+ days           5 each, at most 10
 * No member activity in 30 days         10   (no call, message, upload or rating)
 *
 * Tests: test/commsP3_test.ts.
 */

import { HEALTH_BANDS, type HealthReason, type HealthScore, type MembershipStatus } from "../../schemas/contracts.ts";

export const DAY_MS = 86_400_000;

export interface HealthInput {
  membershipStatus: MembershipStatus;
  cancelAtPeriodEnd?: boolean;
  /** Profile completeness, 0 to 1 (contracts profileCompleteness). */
  completeness: number;
  /** Last logged CSM contact (ISO) or null. */
  lastContactAt: string | null;
  /** When the membership activated (ISO), for "never contacted" and tenure. */
  activatedAt: string | null;
  periodStart: string | null;
  callsUsed: number;
  /** Last post-call rating 1 to 5. */
  lastRating?: number | null;
  /** Last monthly score 0 to 10 (likelihood to recommend). */
  lastNps?: number | null;
  /** Upcoming deadlines (open obligations) due within 14 days. */
  deadlinesWithin14d: number;
  /** Open obligations whose date already passed. */
  deadlinesPast: number;
  /** Quotes with the member and unanswered for 5 or more days. */
  quotesWaiting5d: number;
  /** Last thing the member did (call, message, upload, rating), ISO or null. */
  lastActivityAt: string | null;
}

const ms = (iso: string | null | undefined): number => {
  const t = Date.parse(String(iso ?? ""));
  return Number.isNaN(t) ? NaN : t;
};

const daysSince = (iso: string | null | undefined, now: number): number | null => {
  const t = ms(iso);
  return Number.isNaN(t) ? null : Math.floor((now - t) / DAY_MS);
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Pure: the band for a score. */
export function bandFor(score: number): { band: HealthScore["band"]; label: string } {
  const b = HEALTH_BANDS.find((x) => score >= x.min) ?? HEALTH_BANDS[HEALTH_BANDS.length - 1];
  return { band: b.id, label: b.label };
}

/** Pure: the health score and its reasons (biggest first). */
export function healthScore(input: HealthInput, now: Date = new Date()): HealthScore {
  if (input.membershipStatus === "cancelled") return { score: null, band: "ended", label: "Ended", reasons: [] };
  const t = now.getTime();
  const reasons: HealthReason[] = [];
  const take = (code: string, points: number, text: string) => {
    if (points > 0) reasons.push({ code, points, text });
  };

  // Payment state.
  if (input.membershipStatus === "past_due") take("payment_failed", 35, "Payment failed");
  if (input.membershipStatus === "pending") take("payment_pending", 10, "First payment not received yet");
  if (input.cancelAtPeriodEnd) take("cancel_requested", 30, "Asked to cancel at the end of the period");

  // Profile completeness.
  const pct = Math.round(Math.max(0, Math.min(1, input.completeness)) * 100);
  if (input.completeness < 0.4) take("profile_low", 20, `Profile ${pct}% complete`);
  else if (input.completeness < 0.7) take("profile_not_ready", 12, `Profile ${pct}% complete, not consultation-ready`);

  // Contact.
  const sinceContact = daysSince(input.lastContactAt, t);
  const tenure = daysSince(input.activatedAt, t);
  if (sinceContact === null) {
    if (tenure !== null && tenure >= 2) take("never_contacted", 12, "No contact logged since joining");
  } else if (sinceContact > 30) take("contact_30d", 15, `Last contact ${sinceContact} days ago`);
  else if (sinceContact > 14) take("contact_14d", 8, `Last contact ${sinceContact} days ago`);

  // Calls used this period.
  const intoPeriod = daysSince(input.periodStart, t);
  if (input.membershipStatus === "active" && input.callsUsed === 0 && intoPeriod !== null && intoPeriod >= 21) {
    take("no_calls", 10, `No call used, ${intoPeriod} days into the period`);
  }

  // Ratings.
  if (typeof input.lastRating === "number") {
    if (input.lastRating <= 2) take("rating_low", 20, `Last call rated ${input.lastRating} of 5`);
    else if (input.lastRating === 3) take("rating_mid", 6, "Last call rated 3 of 5");
  }
  if (typeof input.lastNps === "number") {
    if (input.lastNps <= 6) take("nps_low", 15, `Monthly score ${input.lastNps} of 10`);
    else if (input.lastNps <= 8) take("nps_mid", 5, `Monthly score ${input.lastNps} of 10`);
  }

  // Deadlines.
  if (input.deadlinesWithin14d > 0) {
    take("deadlines_14d", Math.min(10, input.deadlinesWithin14d * 5), `${plural(input.deadlinesWithin14d, "deadline")} in the next 14 days`);
  }
  if (input.deadlinesPast > 0) take("deadlines_past", 10, `${plural(input.deadlinesPast, "deadline")} already past and not handled`);

  // Quotes.
  if (input.quotesWaiting5d > 0) {
    take("quotes_waiting", Math.min(10, input.quotesWaiting5d * 5), `${plural(input.quotesWaiting5d, "quote")} unanswered for 5 days or more`);
  }

  // Inactivity.
  const sinceActivity = daysSince(input.lastActivityAt, t);
  const quietFor = sinceActivity ?? tenure;
  if (quietFor !== null && quietFor >= 30) take("inactive_30d", 10, sinceActivity === null ? "No activity since joining" : `No activity for ${sinceActivity} days`);

  reasons.sort((a, b) => b.points - a.points);
  const score = Math.max(0, 100 - reasons.reduce((n, r) => n + r.points, 0));
  return { score, ...bandFor(score), reasons };
}
