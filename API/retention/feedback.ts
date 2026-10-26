/**
 * API/retention/feedback.ts — member feedback (P2, PMF measurement).
 *
 *   GET  /api/retention/me/feedback/pending   most recent completed, unrated call (≤ 30 days)
 *   POST /api/retention/me/feedback/call      { consultationId, score 1-5, comment? }
 *   GET  /api/retention/me/feedback/monthly?m=YYYY-MM
 *   POST /api/retention/me/feedback/monthly   { score 0-10, comment?, month? }
 *
 * Writes Consultation.rating and member_feedback. Low scores (post-call ≤ 2,
 * monthly ≤ 6) open a CSM follow_up task.
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import auditLog from "../../helper/auditLog.ts";
import { type AuthedRequest, requireClientAuth } from "../../helper/auth/session.ts";
import { sanitizeStr } from "../../helper/sanitize.ts";
import { findRecords, getRecord, updateRecord } from "../../db/records.ts";
import { COLLECTIONS, type Consultation, type MemberFeedback } from "../../schemas/contracts.ts";
import { lifecycleTask } from "../payments/lifecycle.ts";
import { crDay } from "./mailer.ts";

const DAY_MS = 86_400_000;
export const LOW_POST_CALL = 2;
export const LOW_MONTHLY = 6;

// ─── Pure (exported for tests) ────────────────────────────────────────────

/** The call the member should rate: latest completed, unrated, ended ≤ 30 days ago. */
export function pendingRating(cons: Consultation[], now: Date): Consultation | null {
  return cons
    .filter((c) => c.status === "completed" && !c.rating)
    .filter((c) => now.getTime() - Date.parse(c.endedAt ?? c.scheduledAt) <= 30 * DAY_MS)
    .sort((a, b) => String(b.endedAt ?? b.scheduledAt).localeCompare(String(a.endedAt ?? a.scheduledAt)))[0] ?? null;
}

export function parseScore(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export const isMonthKey = (v: unknown): v is string => typeof v === "string" && /^20\d\d-(0[1-9]|1[0-2])$/.test(v);

// ─── Routes ───────────────────────────────────────────────────────────────

function who(req: Request) {
  const r = req as AuthedRequest;
  return { clientId: r.clientId ?? "", staff: !!r.isIrpStaff, email: String(r.clientUser ?? "") };
}

const fbId = () => `fb_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

export function registerFeedbackRoutes(app: Express) {
  app.get(
    "/api/retention/me/feedback/pending",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { clientId } = who(req);
      if (!clientId) return res.status(400).json({ error: "No member selected for this session." });
      const cons = await findRecords<Consultation>(COLLECTIONS.consultations, { clientId, status: "completed" });
      const c = pendingRating(cons, new Date());
      if (!c) return res.json({ consultation: null });
      const p = (await get("providers", c.providerId).catch(() => null)) as Record<string, unknown> | null;
      res.json({
        consultation: { id: c.id, scheduledAt: c.scheduledAt, lawyerName: typeof p?.name === "string" ? p.name : null },
      });
    }),
  );

  app.post(
    "/api/retention/me/feedback/call",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { clientId, staff, email } = who(req);
      if (!clientId) return res.status(400).json({ error: "No member selected for this session." });
      if (staff) return res.status(403).json({ error: "Only the member can rate their call." });
      const score = parseScore(req.body?.score, 1, 5);
      if (score === null) return res.status(400).json({ error: "Pick a score from 1 to 5." });
      const comment = sanitizeStr(req.body?.comment).slice(0, 1000);
      const c = await getRecord<Consultation>(COLLECTIONS.consultations, sanitizeStr(req.body?.consultationId).slice(0, 120));
      if (!c || c.clientId !== clientId) return res.status(404).json({ error: "We could not find that call." });
      if (c.status !== "completed") return res.status(409).json({ error: "You can rate a call once it has taken place." });
      if (c.rating) return res.json({ ok: true, already: true });

      const at = new Date().toISOString();
      const rating = { score: score as 1 | 2 | 3 | 4 | 5, ...(comment ? { comment } : {}), at };
      await updateRecord(COLLECTIONS.consultations, c.id, { rating });
      const fb: MemberFeedback = { id: fbId(), clientId, kind: "post_call", consultationId: c.id, score, ...(comment ? { comment } : {}), at };
      await put(COLLECTIONS.feedback, fb.id, { ...fb, providerId: c.providerId });
      await auditLog({ actor: { uid: clientId, email, role: "client" }, action: "feedback.post_call", target: `consultations/${c.id}`, meta: { score } });
      if (score <= LOW_POST_CALL) {
        await lifecycleTask("feedback.low_score", {
          clientId,
          key: `post_call_${c.id}`,
          detail: `rated a call ${score}/5${comment ? `: ${comment.slice(0, 60)}` : ""}`,
          sourceKind: "consultation",
          sourceId: c.id,
        });
      }
      res.json({ ok: true });
    }),
  );

  app.get(
    "/api/retention/me/feedback/monthly",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { clientId } = who(req);
      if (!clientId) return res.status(400).json({ error: "No member selected for this session." });
      const month = isMonthKey(req.query.m) ? req.query.m : crDay(new Date()).slice(0, 7);
      const doc = (await get(COLLECTIONS.feedback, `fb_monthly_${clientId}_${month}`).catch(() => null)) as MemberFeedback | null;
      res.json({ month, score: doc?.score ?? null, comment: doc?.comment ?? null });
    }),
  );

  app.post(
    "/api/retention/me/feedback/monthly",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { clientId, staff, email } = who(req);
      if (!clientId) return res.status(400).json({ error: "No member selected for this session." });
      if (staff) return res.status(403).json({ error: "Only the member can answer this." });
      const score = parseScore(req.body?.score, 0, 10);
      if (score === null) return res.status(400).json({ error: "Pick a number from 0 to 10." });
      const comment = sanitizeStr(req.body?.comment).slice(0, 1000);
      const month = isMonthKey(req.body?.month) ? req.body.month as string : crDay(new Date()).slice(0, 7);
      // One answer per member per month; answering again (e.g. adding a comment) updates it.
      const id = `fb_monthly_${clientId}_${month}`;
      const fb: MemberFeedback = { id, clientId, kind: "monthly", score, ...(comment ? { comment } : {}), at: new Date().toISOString() };
      await put(COLLECTIONS.feedback, id, { ...fb, month });
      await auditLog({ actor: { uid: clientId, email, role: "client" }, action: "feedback.monthly", target: `member_feedback/${id}`, meta: { score } });
      if (score <= LOW_MONTHLY) {
        await lifecycleTask("feedback.low_score", {
          clientId,
          key: `monthly_${clientId}_${month}`,
          detail: `would recommend ${score}/10${comment ? `: ${comment.slice(0, 60)}` : ""}`,
          sourceKind: "manual",
          sourceId: id,
        });
      }
      res.json({ ok: true, month, score });
    }),
  );
}
