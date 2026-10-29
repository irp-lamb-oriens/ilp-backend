/**
 * API/lawyerComms/feedback.ts — the lawyer feedback program, I/O (COMMS-P2).
 * ──────────────────────────────────────────────────────────────────────────
 *   loadFeedbackConfig / saveFeedbackConfig   lawyer_feedback_config/default (staff Settings)
 *   lawyerFeedbackFor(providerId)             the lawyer's own view (portal Feedback page)
 *   monthlyFeedback(now, month?)              1st of the month: last month's reviews, recognition note when earned
 *   coachingCheck(now)                        daily: constructive email + call offer, staff alerted, cooldown
 *   lawyerFeedbackSweep(now)                  the job: coaching check every day, monthly emails on the 1st (CR)
 *
 * The hidden 0-100 rating decides coaching and recognition but is never sent
 * to the lawyer. Comments are anonymized (feedbackLogic.ts) and shown only
 * over at least minReviewsToShowDetail reviews. lawyer_feedback rows keep
 * what was sent (counts, variant, theme ids, staff reasons), never comments.
 */

import get from "../../db/get.ts";
import put from "../../db/put.ts";
import getAll from "../../db/getAll.ts";
import query from "../../db/query.ts";
import log from "../../helper/log.ts";
import auditLog from "../../helper/auditLog.ts";
import { createRecord, getRecord } from "../../db/records.ts";
import {
  COLLECTIONS,
  type CsmTask,
  LAWYER_FEEDBACK_DEFAULTS,
  type LawyerFeedbackConfig,
  type LawyerFeedbackView,
  type LawyerReview,
} from "../../schemas/contracts.ts";
import { isProviderBookable } from "../providers/applyLogic.ts";
import { ratingFor } from "../routing/ratings.ts";
import { notifyStaff } from "../routing/notifications.ts";
import { coachingEmail, monthlyFeedbackEmail } from "./emails.ts";
import {
  evaluateLawyer,
  feedbackConfigErrors,
  type FeedbackReview,
  feedbackView,
  monthBounds,
  monthOf,
  normalizeFeedbackConfig,
  previousMonth,
  themesFrom,
} from "./feedbackLogic.ts";
import { type LawyerContact, lawyerContact, lawyerTeamEmail, lawyerUrl, sendLawyerOnce } from "./notify.ts";

type Doc = Record<string, unknown>;
const DAY = 86_400_000;
const CONFIG_ID = "default";
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

// ─── Config ────────────────────────────────────────────────────────────────

export async function loadFeedbackConfig(): Promise<LawyerFeedbackConfig> {
  const doc = await get(COLLECTIONS.lawyerFeedbackConfig, CONFIG_ID).catch(() => null);
  return normalizeFeedbackConfig(doc ?? LAWYER_FEEDBACK_DEFAULTS);
}

export async function saveFeedbackConfig(body: unknown, actor: string): Promise<{ status: number; body: Doc }> {
  const errors = feedbackConfigErrors(body);
  if (Object.keys(errors).length) return { status: 400, body: { error: "Some values need a fix. Each one is marked on the form.", errors } };
  const before = await loadFeedbackConfig();
  const next = normalizeFeedbackConfig({ ...before, ...((body && typeof body === "object") ? body as Doc : {}) });
  await put(COLLECTIONS.lawyerFeedbackConfig, CONFIG_ID, { ...next, updatedAt: new Date().toISOString(), updatedBy: actor });
  await auditLog({ actor: { uid: actor, email: actor, role: "staff" }, action: "lawyer_feedback.config_updated", target: `${COLLECTIONS.lawyerFeedbackConfig}/${CONFIG_ID}`, meta: { before, after: next } }).catch(() => undefined);
  return { status: 200, body: { config: next } };
}

// ─── Reviews and names ─────────────────────────────────────────────────────

async function reviewsOf(providerId: string): Promise<LawyerReview[]> {
  return ((await query(COLLECTIONS.reviews, [{ field: "providerId", op: "EQUAL", value: providerId }]).catch(() => [])) as unknown as LawyerReview[])
    .filter((r) => Number.isFinite(Number(r.stars)) && typeof r.at === "string");
}

const nameParts = (d: Doc | null | undefined): string[] => {
  if (!d) return [];
  const p = { ...((d.profile as Doc) ?? {}), ...d };
  return [p.fullName, p.name, p.surname, p.preferredName, p.firstName, p.lastName].map(str).filter((x): x is string => !!x);
};

/** Names to keep out of comments: each reviewer's own names, and every other lawyer's. */
async function namesFor(providerId: string, reviews: LawyerReview[]): Promise<{ byClient: Map<string, string[]>; others: string[] }> {
  const byClient = new Map<string, string[]>();
  for (const id of [...new Set(reviews.map((r) => r.clientId).filter(Boolean))]) {
    byClient.set(id, nameParts((await get(COLLECTIONS.clients, id).catch(() => null)) as Doc | null));
  }
  const others = ((await getAll("providers").catch(() => [])) as Doc[]).filter((p) => String(p.id) !== providerId).flatMap(nameParts);
  return { byClient, others };
}

const asFeedback = (r: LawyerReview): FeedbackReview => ({ stars: r.stars, at: r.at, ...(r.comment ? { comment: r.comment } : {}), clientId: r.clientId });

// ─── The lawyer's own view ─────────────────────────────────────────────────

export interface LawyerFeedbackPage {
  recent: LawyerFeedbackView;
  months: Array<{ month: string; label: string; reviews: number; averageStars: number | null }>;
}

/** Last 90 days with comments, plus the last six months (averages only where there are enough reviews). */
export async function lawyerFeedbackFor(providerId: string, now = new Date()): Promise<LawyerFeedbackPage> {
  const [cfg, contact] = await Promise.all([loadFeedbackConfig(), lawyerContact(providerId)]);
  const reviews = await reviewsOf(providerId);
  const names = await namesFor(providerId, reviews);
  const own = contact ? nameParts(contact.doc) : [];
  const recent = feedbackView(reviews.map(asFeedback), {
    from: now.getTime() - 90 * DAY,
    to: now.getTime() + 1,
    periodLabel: "the last 90 days",
    minReviewsToShowDetail: cfg.minReviewsToShowDetail,
    ownNames: own,
    namesByClient: names.byClient,
    otherNames: names.others,
  });
  const months: LawyerFeedbackPage["months"] = [];
  let m = monthOf(now);
  for (let i = 0; i < 6; i++) {
    const b = monthBounds(m);
    const v = feedbackView(reviews.map(asFeedback), { from: b.from, to: b.to, periodLabel: b.label, minReviewsToShowDetail: cfg.minReviewsToShowDetail, ownNames: own });
    months.push({ month: m, label: b.label, reviews: v.reviewsInPeriod, averageStars: v.averageStars });
    m = previousMonth(new Date(b.from));
  }
  return { recent, months };
}

// ─── Monthly email ─────────────────────────────────────────────────────────

async function feedbackLawyers(): Promise<LawyerContact[]> {
  const out: LawyerContact[] = [];
  for (const p of (await getAll("providers").catch(() => [])) as Doc[]) {
    const id = String(p.id ?? "");
    if (!id || !isProviderBookable(p)) continue;
    const c = await lawyerContact(id, p);
    if (c && !c.placeholder) out.push(c);
  }
  return out;
}

async function lastCoachingAt(providerId: string): Promise<number | null> {
  const rows = ((await query(COLLECTIONS.lawyerFeedback, [{ field: "providerId", op: "EQUAL", value: providerId }]).catch(() => [])) as Doc[])
    .filter((r) => r.kind === "coaching" && typeof r.sentAt === "string")
    .map((r) => Date.parse(String(r.sentAt)));
  return rows.length ? Math.max(...rows) : null;
}

/** Last month's feedback email to every active lawyer with at least one review in that month. */
export async function monthlyFeedback(now = new Date(), month = previousMonth(now)): Promise<{ sent: number; recognition: number }> {
  const cfg = await loadFeedbackConfig();
  if (!cfg.enabled) return { sent: 0, recognition: 0 };
  const b = monthBounds(month);
  let sent = 0;
  let recognition = 0;
  for (const l of await feedbackLawyers()) {
    try {
      const reviews = await reviewsOf(l.providerId);
      const fr = reviews.map(asFeedback);
      const inMonth = fr.filter((r) => Date.parse(r.at) >= b.from && Date.parse(r.at) < b.to).length;
      if (!inMonth) continue;
      const names = await namesFor(l.providerId, reviews);
      const own = nameParts(l.doc);
      const opts = { minReviewsToShowDetail: cfg.minReviewsToShowDetail, ownNames: own, namesByClient: names.byClient, otherNames: names.others };
      let view = feedbackView(fr, { ...opts, from: b.from, to: b.to, periodLabel: b.label });
      if (view.tooFewToShow) {
        const wide = feedbackView(fr, { ...opts, from: b.to - 90 * DAY, to: b.to, periodLabel: "the last 90 days" });
        if (!wide.tooFewToShow) view = wide;
      }
      const rating = await ratingFor(l.providerId);
      const ev = evaluateLawyer(rating, fr, cfg, now);
      const coachedAt = await lastCoachingAt(l.providerId);
      const recentlyCoached = coachedAt !== null && now.getTime() - coachedAt < cfg.coachingCooldownDays * DAY;
      const recog = ev.recognition && !recentlyCoached;
      const mail = monthlyFeedbackEmail({
        firstName: l.firstName,
        monthLabel: b.label,
        recognition: recog,
        reviewsInMonth: inMonth,
        periodLabel: view.periodLabel,
        averageStars: view.averageStars,
        comments: view.comments.slice(0, 8),
        tooFewToShow: view.tooFewToShow,
        minReviewsToShowDetail: cfg.minReviewsToShowDetail,
        feedbackUrl: lawyerUrl("/feedback"),
      });
      if (await sendLawyerOnce(`feedback_${l.providerId}_${month}`, l, mail)) {
        sent++;
        if (recog) recognition++;
        await put(COLLECTIONS.lawyerFeedback, `lfb_${l.providerId}_${month}`.replace(/[^A-Za-z0-9_-]/g, "_"), {
          providerId: l.providerId, kind: "monthly", period: month, variant: recog ? "recognition" : "standard",
          reviewsInPeriod: inMonth, averageStars: view.averageStars, shownOver: view.periodLabel, commentsShown: view.comments.length,
          sentAt: now.toISOString(),
        });
      }
    } catch (err) {
      log(`[lawyerFeedback] monthly ${l.providerId} failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }
  return { sent, recognition };
}

// ─── Coaching ──────────────────────────────────────────────────────────────

export const coachingTaskId = (providerId: string, day: string) => `task_lawyer_feedback__${providerId.replace(/[^A-Za-z0-9_-]/g, "_")}_${day}`;

/** Lawyers below the thresholds: one constructive email (and a staff alert and task) per cooldown. */
export async function coachingCheck(now = new Date()): Promise<{ coached: string[] }> {
  const cfg = await loadFeedbackConfig();
  const coached: string[] = [];
  if (!cfg.enabled) return { coached };
  const day = new Date(now.getTime() - 6 * 3600_000).toISOString().slice(0, 10);
  for (const l of await feedbackLawyers()) {
    try {
      const reviews = await reviewsOf(l.providerId);
      if (!reviews.length) continue;
      const rating = await ratingFor(l.providerId);
      const fr = reviews.map(asFeedback);
      const ev = evaluateLawyer(rating, fr, cfg, now);
      if (!ev.coaching) continue;
      const last = await lastCoachingAt(l.providerId);
      if (last !== null && now.getTime() - last < cfg.coachingCooldownDays * DAY) continue;
      // Themes from the low and middling reviews of the window (comments never quoted here).
      const windowFrom = now.getTime() - Math.max(cfg.lowScoresWindowDays, 90) * DAY;
      const weak = fr.filter((r) => r.stars <= 3 && Date.parse(r.at) >= windowFrom);
      const themes = themesFrom(weak.map((r) => r.comment));
      const v90 = feedbackView(fr, { from: now.getTime() - 90 * DAY, to: now.getTime() + 1, periodLabel: "the last 90 days", minReviewsToShowDetail: cfg.minReviewsToShowDetail, ownNames: [] });
      const mail = coachingEmail({ firstName: l.firstName, themes, averageStars: v90.averageStars, periodLabel: v90.periodLabel, teamEmail: lawyerTeamEmail(), feedbackUrl: lawyerUrl("/feedback") });
      if (!(await sendLawyerOnce(`coaching_${l.providerId}_${day}`, l, mail))) continue;
      coached.push(l.providerId);
      await put(COLLECTIONS.lawyerFeedback, `lfc_${l.providerId}_${day}`.replace(/[^A-Za-z0-9_-]/g, "_"), {
        providerId: l.providerId, kind: "coaching", period: day, variant: "coaching", themes: themes.map((t) => t.id), reasons: ev.reasons, sentAt: now.toISOString(),
      });
      const body = `${ev.reasons.join(" ")} Themes in the comments: ${themes.map((t) => t.label.toLowerCase()).join(", ")}. The email offered a call with the ILP team; reach out if they do not write within a week.`;
      await notifyStaff({ key: `lawyer_coaching_${l.providerId}_${day}`, kind: "lawyer.coaching", title: `Constructive feedback sent to ${l.name}`, body, link: "/dashboard/lawyers" });
      const taskId = coachingTaskId(l.providerId, day);
      if (!(await getRecord(COLLECTIONS.csmTasks, taskId))) {
        const owner = str(Deno.env.get("LAWYER_TEAM_OWNER_EMAIL")) ?? str(Deno.env.get("DEFAULT_CSM_EMAIL"));
        const task: CsmTask & Doc = {
          id: taskId,
          clientId: l.providerId,
          type: "follow_up",
          title: `Offer a feedback call to ${l.name}`,
          dueAt: new Date(now.getTime() + 3 * DAY).toISOString(),
          status: "open",
          source: { kind: "manual", id: l.providerId },
          subject: { kind: "lawyer_feedback", providerId: l.providerId },
          link: "/dashboard/lawyers",
          createdAt: now.toISOString(),
          ...(owner ? { ownerEmail: owner } : {}),
        };
        await createRecord(COLLECTIONS.csmTasks, task);
      }
      await auditLog({ actor: { uid: "system", email: "system", role: "system" }, action: "lawyer_feedback.coaching_sent", target: `providers/${l.providerId}`, meta: { reasons: ev.reasons, themes: themes.map((t) => t.id) } }).catch(() => undefined);
    } catch (err) {
      log(`[lawyerFeedback] coaching ${l.providerId} failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }
  return { coached };
}

/** The daily job: coaching check; on the 1st (Costa Rica date) also last month's emails. */
export async function lawyerFeedbackSweep(now = new Date()): Promise<{ coached: number; monthly: number }> {
  const c = await coachingCheck(now);
  const crDate = new Date(now.getTime() - 6 * 3600_000).getUTCDate();
  const m = crDate === 1 ? await monthlyFeedback(now) : { sent: 0 };
  return { coached: c.coached.length, monthly: m.sent };
}
