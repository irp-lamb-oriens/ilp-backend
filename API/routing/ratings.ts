/**
 * API/routing/ratings.ts — hidden lawyer ratings (ROUTING).
 * ──────────────────────────────────────────────────────────────────────────
 * A member rates a completed call 1-5 (with an optional comment) in /status
 * (POST /api/retention/me/feedback/call). That writes reviews/rev_<callId>
 * and recomputes lawyer_ratings/<providerId> with `lawyerRating` (contracts):
 * 100 with no reviews, blended with the 100 prior until 5 reviews, then the
 * plain average. Staff and the router read it; member and lawyer responses
 * never carry it (CLIENT_HIDDEN_FIELDS / LAWYER_HIDDEN_FIELDS).
 */

import get from "../../db/get.ts";
import put from "../../db/put.ts";
import query from "../../db/query.ts";
import getAll from "../../db/getAll.ts";
import log from "../../helper/log.ts";
import { isPlaceholderId } from "../../helper/placeholder.ts";
import {
  COLLECTIONS,
  type Consultation,
  type LawyerRatingSummary,
  type LawyerReview,
  lawyerRating,
  RATING_PRIOR,
  SALES_TEAM_ID,
  starsTo100,
} from "../../schemas/contracts.ts";

type Doc = Record<string, unknown>;

/** One review per call; a seed (ph_) call keeps the ph_ prefix for the placeholder cleanup. */
export const reviewIdFor = (consultationId: string) =>
  (consultationId.startsWith("ph_") ? `ph_rev_${consultationId.slice(3)}` : `rev_${consultationId}`).replace(/[^A-Za-z0-9_-]/g, "_");

/** The rating summary staff see for a lawyer with no summary yet. */
export const noReviewsSummary = (providerId: string): LawyerRatingSummary => ({
  providerId,
  ratingScore: RATING_PRIOR,
  reviewCount: 0,
  ratingStatus: "no_reviews",
  updatedAt: new Date(0).toISOString(),
});

/** Recompute and store one lawyer's rating from their reviews. */
export async function recomputeRating(providerId: string): Promise<LawyerRatingSummary> {
  const rows = (await query(COLLECTIONS.reviews, [{ field: "providerId", op: "EQUAL", value: providerId }]).catch(() => [])) as unknown as LawyerReview[];
  const r = lawyerRating(rows.map((x) => Number(x.score100)).filter((n) => Number.isFinite(n)));
  const summary: LawyerRatingSummary = { providerId, ratingScore: r.score, reviewCount: r.reviewCount, ratingStatus: r.status, updatedAt: new Date().toISOString() };
  await put(COLLECTIONS.lawyerRatings, providerId, summary as unknown as Doc);
  return summary;
}

/**
 * Store the member's review of a call (once per call) and refresh the
 * lawyer's rating. Sales calls are not reviews of a lawyer. Never throws.
 */
export async function recordReview(c: Pick<Consultation, "id" | "clientId" | "providerId" | "kind">, stars: number, comment?: string): Promise<LawyerRatingSummary | null> {
  if (!c.providerId || c.providerId === SALES_TEAM_ID || c.kind === "sales") return null;
  try {
    const id = reviewIdFor(c.id);
    const review: LawyerReview = {
      id,
      providerId: c.providerId,
      clientId: c.clientId,
      consultationId: c.id,
      stars: Math.max(1, Math.min(5, Math.round(stars))) as LawyerReview["stars"],
      score100: starsTo100(stars),
      ...(comment ? { comment: comment.slice(0, 1000) } : {}),
      at: new Date().toISOString(),
      ...(isPlaceholderId(c.id) || isPlaceholderId(c.clientId) ? { placeholder: true } : {}),
    };
    await put(COLLECTIONS.reviews, id, review as unknown as Doc);
    return await recomputeRating(c.providerId);
  } catch (err) {
    log(`[routing] review for ${c.id} failed: ${err instanceof Error ? err.message : err}`, "error");
    return null;
  }
}

/** Every stored rating summary by providerId (lawyers without one read as "no reviews"). */
export async function ratingsByProvider(): Promise<Map<string, LawyerRatingSummary>> {
  const rows = (await getAll(COLLECTIONS.lawyerRatings).catch(() => [])) as Doc[];
  const out = new Map<string, LawyerRatingSummary>();
  for (const r of rows) {
    const id = String(r.providerId ?? r.id ?? "");
    if (id) out.set(id, r as unknown as LawyerRatingSummary);
  }
  return out;
}

/** One lawyer's summary (staff lawyer page). */
export async function ratingFor(providerId: string): Promise<LawyerRatingSummary> {
  const doc = (await get(COLLECTIONS.lawyerRatings, providerId).catch(() => null)) as LawyerRatingSummary | null;
  return doc ?? noReviewsSummary(providerId);
}

/** Staff label: "No reviews yet" or "87.5 (6 reviews)". */
export function ratingLabel(r: Pick<LawyerRatingSummary, "ratingScore" | "reviewCount">): string {
  if (!r.reviewCount) return "No reviews yet";
  return `${r.ratingScore} (${r.reviewCount} review${r.reviewCount === 1 ? "" : "s"})`;
}
