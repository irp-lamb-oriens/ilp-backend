/**
 * API/lawyerComms/feedbackLogic.ts — the lawyer feedback program, pure rules (COMMS-P2).
 * ──────────────────────────────────────────────────────────────────────────
 * Owner intent: members stay satisfied and good lawyers feel valued; lawyers
 * with weaker results get constructive feedback by email; members never see
 * ratings. A lawyer only ever sees their own star average and anonymized
 * comments: never the hidden 0-100 score, another lawyer's data or a ranking.
 *
 *   normalizeFeedbackConfig  thresholds from the stored doc, clamped, defaults filled
 *   anonymizeComment         drop sentences with names, contact details or ID numbers
 *   themesFrom               concrete themes (with a constructive tip) from comments
 *   evaluateLawyer           coaching / recognition / standard from rating and recent low scores
 *   feedbackView             what the lawyer sees for a period (k-anonymity: minReviewsToShowDetail)
 */

import {
  LAWYER_FEEDBACK_DEFAULTS,
  LAWYER_FEEDBACK_LIMITS,
  type LawyerFeedbackConfig,
  type LawyerFeedbackView,
  type LawyerReview,
} from "../../schemas/contracts.ts";

const DAY = 86_400_000;

/** Stored or posted config, clamped to LAWYER_FEEDBACK_LIMITS; missing keys take the defaults. */
export function normalizeFeedbackConfig(raw: unknown): LawyerFeedbackConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: LawyerFeedbackConfig = { ...LAWYER_FEEDBACK_DEFAULTS };
  if (typeof o.enabled === "boolean") out.enabled = o.enabled;
  for (const [k, [lo, hi]] of Object.entries(LAWYER_FEEDBACK_LIMITS) as Array<[Exclude<keyof LawyerFeedbackConfig, "enabled">, [number, number]]>) {
    const n = typeof o[k] === "number" ? o[k] as number : typeof o[k] === "string" && o[k] !== "" ? Number(o[k]) : NaN;
    if (Number.isFinite(n)) out[k] = Math.min(hi, Math.max(lo, Math.round(n)));
  }
  return out;
}

/** Field errors for a staff PUT (values out of range or not numbers). Empty when valid. */
export function feedbackConfigErrors(raw: unknown): Record<string, string> {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const e: Record<string, string> = {};
  if ("enabled" in o && typeof o.enabled !== "boolean") e.enabled = "Choose on or off.";
  for (const [k, [lo, hi]] of Object.entries(LAWYER_FEEDBACK_LIMITS)) {
    if (!(k in o)) continue;
    const n = typeof o[k] === "number" ? o[k] as number : Number(o[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) e[k] = `Enter a whole number from ${lo} to ${hi}.`;
  }
  return e;
}

// ─── Anonymization ─────────────────────────────────────────────────────────

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const URL_RE = /https?:\/\/|www\./i;
const PHONE = /\+?\d[\d\s().-]{6,}\d/;
const LONG_NUMBER = /\d{5,}/;
const HONORIFIC = /\b(?:Mr|Mrs|Ms|Miss|Dr|Lic|Licda|Sr|Sra|Srta|Don|Doña)\.?\s+[A-ZÁÉÍÓÚÑ]/;

/**
 * Capitalized words that are not names. A capitalized word in the middle of a
 * sentence that is not here is treated as a possible name or place (which can
 * identify a member), and its sentence is dropped.
 */
const COMMON_CAPS = new Set([
  "I", "I'm", "I've", "I'd", "I'll", "ILP", "ILP's", "CSM", "AI", "OK", "US", "USA", "PDF",
  "English", "Spanish", "Portuguese", "Costa", "Rica", "Rican", "Panama", "Mexico", "Mexican", "Colombia", "Spain", "Portugal",
  "Canada", "Canadian", "American", "Google", "Meet", "Zoom", "WhatsApp", "DIMEX", "CCSS", "S.A.", "S.R.L.",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
]);

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameTokens = (names: Array<string | null | undefined>) =>
  [...new Set(names.flatMap((n) => String(n ?? "").split(/[\s,]+/)).map((t) => t.replace(/[^\p{L}'-]/gu, "")).filter((t) => t.length >= 3))];

function hasWord(sentence: string, word: string): boolean {
  return new RegExp(`(^|[^\\p{L}])${reEscape(word)}($|[^\\p{L}])`, "iu").test(sentence);
}

function hasUnknownCapital(sentence: string): boolean {
  const words = sentence.split(/\s+/).map((w) => w.replace(/^[^\p{L}]+|[^\p{L}.'’]+$/gu, "")).filter(Boolean);
  return words.slice(1).some((w) => /^\p{Lu}\p{Ll}/u.test(w) && !COMMON_CAPS.has(w) && !COMMON_CAPS.has(w.replace(/[.'’]s?$/, "")));
}

export interface AnonymizeContext {
  /** Names that must never appear (the member, other people on file). Sentences holding them are dropped. */
  dropNames?: Array<string | null | undefined>;
  /** The reviewed lawyer's own names: replaced with "the lawyer". */
  ownNames?: Array<string | null | undefined>;
  maxLength?: number;
}

/**
 * A member comment made safe to show the lawyer, or null when nothing safe is
 * left. Sentences with an email, phone, link, long number (ID, passport,
 * account), an honorific with a name, a known name, or any other capitalized
 * word that may be a name or place are dropped whole; the lawyer's own name
 * becomes "the lawyer"; the rest is cut to `maxLength` at a sentence or word
 * boundary.
 */
export function anonymizeComment(raw: string | null | undefined, ctx: AnonymizeContext = {}): string | null {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const drop = nameTokens(ctx.dropNames ?? []);
  const own = nameTokens(ctx.ownNames ?? []).filter((t) => !drop.some((d) => d.toLowerCase() === t.toLowerCase()));
  // Keep "Mrs. Lopez" in one sentence: protect honorific dots while splitting.
  const sentences = text
    .replace(/\b(Mr|Mrs|Ms|Dr|Sr|Sra|Srta|Lic|Licda)\.\s/g, "$1\u0000 ")
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.replace(/\u0000/g, "."));
  const kept: string[] = [];
  for (let s of sentences) {
    for (const t of own) s = s.replace(new RegExp(`(^|[^\\p{L}])${reEscape(t)}(?=$|[^\\p{L}])`, "giu"), "$1the lawyer");
    s = s.replace(/the lawyer(\s+the lawyer)+/gi, "the lawyer").replace(/^the lawyer/, "The lawyer");
    if (EMAIL.test(s) || URL_RE.test(s) || PHONE.test(s) || LONG_NUMBER.test(s) || HONORIFIC.test(s)) continue;
    if (drop.some((d) => hasWord(s, d))) continue;
    if (hasUnknownCapital(s)) continue;
    kept.push(s);
  }
  if (!kept.length) return null;
  const max = ctx.maxLength ?? 280;
  let out = kept.join(" ");
  if (out.length > max) {
    const cut = out.slice(0, max);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    out = end >= 40 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : max).replace(/[\s,;:]+$/, "")}...`;
  }
  return out;
}

// ─── Themes ────────────────────────────────────────────────────────────────

export interface Theme {
  id: string;
  label: string;
  tip: string;
  match: RegExp;
}

export const THEMES: readonly Theme[] = [
  { id: "time", label: "Starting on time", match: /\b(late|on time|punctual|kept me waiting|waited|delay|didn'?t show|no.?show)/i, tip: "Join a minute or two early. If you are held up, write to the ILP team so the member's CSM can tell them." },
  { id: "clarity", label: "Clear explanations", match: /\b(confus|unclear|jargon|hard to (understand|follow)|didn'?t understand|did not understand|too technical|complicated)/i, tip: "Explain each step in plain words and check the member followed before moving on. Most members are new to the local legal system." },
  { id: "listening", label: "Time to listen", match: /\b(rush|hurr|interrupt|didn'?t listen|did not listen|not listen|dismissive|impatient|cut me off)/i, tip: "Let the member finish their question before answering, and keep a few minutes at the end for theirs." },
  { id: "answer", label: "A clear answer", match: /\b(no (clear )?answer|vague|didn'?t (help|answer)|did not (help|answer)|not helpful|unhelpful|generic|no real advice)/i, tip: "End the call with a short answer to the question, even when it is that more review is needed, and say what happens next." },
  { id: "follow_up", label: "Next steps after the call", match: /\b(follow.?up|never heard|no (reply|response)|didn'?t (send|reply|respond|get back)|still waiting|next steps)/i, tip: "Confirm the summary and next steps soon after the call, so the member has a written answer the same day." },
  { id: "preparation", label: "Preparation", match: /\b(prepar|didn'?t read|did not read|didn'?t know (my|about)|asked (the same|again)|repeat myself)/i, tip: "Read the brief before the call. The question, profile facts and deadlines are on one screen." },
  { id: "language", label: "Language", match: /\b(english|spanish|portuguese|language|translat|accent)/i, tip: "Keep your call languages up to date on your Profile, so members are matched to a language you both speak comfortably." },
  { id: "connection", label: "Audio and connection", match: /\b(audio|sound|connection|internet|couldn'?t hear|could not hear|dropped|echo|video froze)/i, tip: "Test your audio and connection before the call, and use a headset where you can." },
];

const GENERAL: Pick<Theme, "id" | "label" | "tip"> = {
  id: "general",
  label: "Shape of the call",
  tip: "Open with the member's question in their own words, and close with the answer, the next steps and who does each one.",
};

/** Themes found in the comments (raw text is never shown; only labels and tips). Most mentioned first; at least the general one. */
export function themesFrom(comments: Array<string | null | undefined>): Array<Pick<Theme, "id" | "label" | "tip">> {
  const count = new Map<string, number>();
  for (const c of comments) {
    if (!c) continue;
    for (const t of THEMES) if (t.match.test(c)) count.set(t.id, (count.get(t.id) ?? 0) + 1);
  }
  const found = THEMES.filter((t) => count.has(t.id))
    .sort((a, b) => (count.get(b.id)! - count.get(a.id)!) || THEMES.indexOf(a) - THEMES.indexOf(b))
    .slice(0, 4)
    .map(({ id, label, tip }) => ({ id, label, tip }));
  return found.length ? found : [GENERAL];
}

// ─── Evaluation ────────────────────────────────────────────────────────────

export type FeedbackReview = Pick<LawyerReview, "stars" | "at"> & { comment?: string; clientId?: string };

export interface Evaluation {
  coaching: boolean;
  recognition: boolean;
  lowRecent: number;
  /** Staff-facing reasons (they hold the hidden score; never sent to the lawyer). */
  reasons: string[];
}

/** Coaching, recognition or neither, from the hidden rating and recent low scores. */
export function evaluateLawyer(
  rating: { ratingScore: number; reviewCount: number },
  reviews: FeedbackReview[],
  cfg: LawyerFeedbackConfig,
  now: Date,
): Evaluation {
  const since = now.getTime() - cfg.lowScoresWindowDays * DAY;
  const lowRecent = reviews.filter((r) => r.stars <= cfg.lowStars && Date.parse(r.at) >= since && Date.parse(r.at) <= now.getTime()).length;
  const reasons: string[] = [];
  const lowRating = rating.reviewCount >= cfg.coachingMinReviews && rating.ratingScore < cfg.coachingBelowScore;
  if (lowRating) reasons.push(`Rating ${rating.ratingScore} over ${rating.reviewCount} reviews (below ${cfg.coachingBelowScore}).`);
  const manyLow = lowRecent >= cfg.lowScoresCount;
  if (manyLow) reasons.push(`${lowRecent} reviews of ${cfg.lowStars} stars or fewer in ${cfg.lowScoresWindowDays} days.`);
  const coaching = lowRating || manyLow;
  const recognition = !coaching && rating.reviewCount >= cfg.recognitionMinReviews && rating.ratingScore >= cfg.recognitionAtLeastScore && lowRecent === 0;
  return { coaching, recognition, lowRecent, reasons };
}

// ─── What the lawyer sees ──────────────────────────────────────────────────

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The lawyer's view of their reviews in [from, to). Average and comments only
 * when the period holds at least `minReviewsToShowDetail` reviews; otherwise
 * `tooFewToShow`. Comments are anonymized per member (their own names are
 * dropped) and sorted alphabetically, so their order says nothing about when
 * or from whom they came.
 */
export function feedbackView(
  reviews: FeedbackReview[],
  o: { from: number; to: number; periodLabel: string; minReviewsToShowDetail: number; ownNames: Array<string | null | undefined>; namesByClient?: Map<string, string[]>; otherNames?: string[]; totalReviews?: number },
): LawyerFeedbackView {
  const inPeriod = reviews.filter((r) => {
    const t = Date.parse(r.at);
    return t >= o.from && t < o.to;
  });
  const tooFew = inPeriod.length < o.minReviewsToShowDetail;
  const comments = tooFew ? [] : inPeriod
    .map((r) => anonymizeComment(r.comment, { ownNames: o.ownNames, dropNames: [...(o.otherNames ?? []), ...((r.clientId && o.namesByClient?.get(r.clientId)) || [])] }))
    .filter((c): c is string => !!c)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 20);
  return {
    periodLabel: o.periodLabel,
    reviewsInPeriod: inPeriod.length,
    averageStars: tooFew || !inPeriod.length ? null : round1(inPeriod.reduce((s, r) => s + r.stars, 0) / inPeriod.length),
    comments,
    tooFewToShow: tooFew,
    minReviewsToShowDetail: o.minReviewsToShowDetail,
    totalReviews: o.totalReviews ?? reviews.length,
  };
}

/** Month bounds in Costa Rica time (UTC-6, no DST) for "YYYY-MM". */
export function monthBounds(month: string): { from: number; to: number; label: string } {
  const [y, m] = month.split("-").map(Number);
  const from = Date.UTC(y, m - 1, 1, 6);
  const to = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, 6);
  const label = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return { from, to, label };
}

/** The month before `now` in Costa Rica, "YYYY-MM". */
export function previousMonth(now: Date): string {
  const cr = new Date(now.getTime() - 6 * 3600_000);
  const y = cr.getUTCFullYear();
  const m = cr.getUTCMonth(); // 0-based current month = previous month 1-based
  return m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, "0")}`;
}

/** The month of `now` in Costa Rica, "YYYY-MM". */
export function monthOf(now: Date): string {
  return new Date(now.getTime() - 6 * 3600_000).toISOString().slice(0, 7);
}
