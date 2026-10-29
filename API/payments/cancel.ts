/**
 * API/payments/cancel.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Member self-serve membership screen + cancel (P2). All routes act on the
 * session's own membership (staff previewing a member pass ?clientId=, and the
 * audit entry records the staff actor).
 *
 *   GET  /api/payments/me/membership       status, period, cancel state, grace access
 *   POST /api/payments/me/cancel           { reason?, comment? } → cancel at period end
 *   POST /api/payments/me/cancel/undo      keep the membership (before periodEnd)
 *   POST /api/payments/me/billing-portal   Stripe mode: URL to update the card
 *
 * Cancelling never ends access early: the member keeps everything until
 * periodEnd. The current month is not refunded unless staff decide otherwise.
 * A CSM "save" call task opens due within 24 h.
 */

import type { Express, Request, Response } from "express";
import { isPlaceholderDoc } from "../../helper/placeholder.ts";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import patch from "../../db/patch.ts";
import put from "../../db/put.ts";
import auditLog from "../../helper/auditLog.ts";
import { type AuthedRequest, requireClientAuth } from "../../helper/auth/session.ts";
import { sanitizeStr } from "../../helper/sanitize.ts";
import { updateRecord } from "../../db/records.ts";
import { COLLECTIONS, type MemberFeedback, type Membership } from "../../schemas/contracts.ts";
import { paymentsMode, stripeApi } from "./membership.ts";
import { accessFor, currentMembership, lifecycleTask, type MembershipDoc, runHook } from "./lifecycle.ts";
import { taskIdFor } from "../members/events.ts";

type Doc = Record<string, unknown>;

/** Reasons offered on the cancel screen (value → label kept on the record). */
export const CANCEL_REASONS: Record<string, string> = {
  not_worth_cost: "It costs more than it is worth to me",
  got_what_needed: "I got the help I needed",
  leaving_country: "I am leaving the country",
  not_used: "I did not use it enough",
  service_issue: "Something did not work well",
  other: "Another reason",
};

/** Pure: the text stored in membership.cancelReason. Exported for tests. */
export function cancelReasonText(reason: unknown, comment: unknown): string {
  const label = typeof reason === "string" ? CANCEL_REASONS[reason] : undefined;
  const c = typeof comment === "string" ? comment.trim().slice(0, 1000) : "";
  return [label, c].filter(Boolean).join(" — ") || "No reason given";
}

// Placeholder (seed) memberships never reach Stripe, whatever their paymentRef.
const isStripeSub = (m: Pick<Membership, "paymentRef">) =>
  !isPlaceholderDoc(m) && /^sub_[A-Za-z0-9]+$/.test(String(m.paymentRef ?? ""));

/** Deterministic id of the save-call task for one cancel request. */
export const saveTaskKey = (m: Pick<Membership, "id" | "periodEnd">) => `${m.id}_${String(m.periodEnd).slice(0, 10)}`;
const SAVE_EVENT = "membership.cancel_requested" as const;

function actorOf(req: Request) {
  const r = req as AuthedRequest;
  const email = String(r.clientUser ?? "");
  return { uid: r.isIrpStaff ? email : String(r.clientId ?? email), email, role: r.isIrpStaff ? "staff" : "client" };
}

/** Member-safe view of the membership (no payment refs). */
export function membershipView(m: MembershipDoc | null, now: Date = new Date()) {
  if (!m) return { membership: null, access: accessFor(null, now), mode: paymentsMode() };
  return {
    membership: {
      id: m.id,
      status: m.status,
      periodStart: m.periodStart,
      periodEnd: m.periodEnd,
      activatedAt: m.activatedAt ?? null,
      cancelAtPeriodEnd: !!m.cancelAtPeriodEnd,
      cancelledAt: m.cancelledAt ?? null,
      pastDueSince: m.pastDueSince ?? null,
      minutesIncluded: m.minutesIncluded,
      minutesUsed: m.minutesUsed,
      callsIncluded: m.callsIncluded,
      callsUsed: m.callsUsed,
      paidBy: isStripeSub(m) ? "card" : "manual",
    },
    access: accessFor(m, now),
    mode: paymentsMode(),
  };
}

export function registerCancelRoutes(app: Express) {
  const clientIdOf = (req: Request, res: Response): string | null => {
    const id = (req as AuthedRequest).clientId;
    if (!id) {
      res.status(400).json({ error: "No member selected for this session." });
      return null;
    }
    return id;
  };

  app.get(
    "/api/payments/me/membership",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = clientIdOf(req, res);
      if (!id) return;
      res.json({ ...membershipView(await currentMembership(id)), reasons: CANCEL_REASONS });
    }),
  );

  app.post(
    "/api/payments/me/cancel",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = clientIdOf(req, res);
      if (!id) return;
      const m = await currentMembership(id);
      if (!m || m.status === "pending") return res.status(409).json({ error: "There is no running membership to cancel." });
      if (m.status === "cancelled") return res.status(409).json({ error: "This membership has already ended." });
      if (m.cancelAtPeriodEnd) return res.json(membershipView(m)); // already requested: same answer

      const reasonKey = sanitizeStr(req.body?.reason).slice(0, 40);
      const comment = sanitizeStr(req.body?.comment).slice(0, 1000);
      const reason = cancelReasonText(reasonKey, comment);

      if (paymentsMode() === "stripe" && isStripeSub(m)) {
        try {
          const f = new URLSearchParams();
          f.set("cancel_at_period_end", "true");
          await stripeApi(`/subscriptions/${m.paymentRef}`, "POST", f);
        } catch (err) {
          log(`[cancel] stripe cancel_at_period_end failed for ${m.id}: ${err instanceof Error ? err.message : err}`, "error");
          return res.status(502).json({ error: "We could not reach our payment provider. Nothing has changed. Please try again in a few minutes." });
        }
      }

      const now = new Date().toISOString();
      await patch(COLLECTIONS.memberships, m.id, {
        cancelAtPeriodEnd: true,
        cancelReason: reason,
        cancelRequestedAt: now,
        updatedAt: now,
      });
      const fb: MemberFeedback = {
        id: `fb_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
        clientId: id,
        kind: "cancel",
        comment: reason,
        at: now,
      };
      await put(COLLECTIONS.feedback, fb.id, { ...fb, reasonKey: reasonKey || null, membershipId: m.id });
      const actor = actorOf(req);
      await auditLog({ actor, action: "membership.cancel_requested", target: `memberships/${m.id}`, meta: { reason, periodEnd: m.periodEnd } });
      await lifecycleTask(SAVE_EVENT, {
        clientId: id,
        key: saveTaskKey(m),
        csmEmail: m.csmEmail,
        detail: reason.length > 80 ? `${reason.slice(0, 77)}…` : reason,
        sourceId: m.id,
      });
      const after = { ...m, cancelAtPeriodEnd: true, cancelReason: reason, cancelRequestedAt: now } as MembershipDoc;
      await runHook("onCancelRequested", after);
      res.json(membershipView(after));
    }),
  );

  app.post(
    "/api/payments/me/cancel/undo",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = clientIdOf(req, res);
      if (!id) return;
      const m = await currentMembership(id);
      if (!m || m.status === "cancelled") return res.status(409).json({ error: "This membership has already ended. Join again from the pricing page." });
      if (!m.cancelAtPeriodEnd) return res.json(membershipView(m));

      if (paymentsMode() === "stripe" && isStripeSub(m)) {
        try {
          const f = new URLSearchParams();
          f.set("cancel_at_period_end", "false");
          await stripeApi(`/subscriptions/${m.paymentRef}`, "POST", f);
        } catch (err) {
          log(`[cancel] stripe undo failed for ${m.id}: ${err instanceof Error ? err.message : err}`, "error");
          return res.status(502).json({ error: "We could not reach our payment provider. Your membership is still set to end. Please try again in a few minutes." });
        }
      }
      const now = new Date().toISOString();
      await patch(COLLECTIONS.memberships, m.id, { cancelAtPeriodEnd: false, cancelReason: null, cancelRequestedAt: null, updatedAt: now });
      await auditLog({ actor: actorOf(req), action: "membership.cancel_undone", target: `memberships/${m.id}` });
      // COMMS-P4: "your membership continues" email (once per undone request).
      await runHook("onCancelUndone", { ...m, cancelAtPeriodEnd: false } as MembershipDoc);
      // The save call is no longer needed.
      const taskId = taskIdFor(SAVE_EVENT, { clientId: id, dedupeKey: saveTaskKey(m) });
      await updateRecord(COLLECTIONS.csmTasks, taskId, { status: "cancelled", outcome: "Member kept the membership", closedAt: now })
        .catch(() => null);
      res.json(membershipView({ ...m, cancelAtPeriodEnd: false } as MembershipDoc));
    }),
  );

  app.post(
    "/api/payments/me/billing-portal",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = clientIdOf(req, res);
      if (!id) return;
      const m = await currentMembership(id);
      if (paymentsMode() !== "stripe" || !m || !isStripeSub(m)) {
        return res.status(409).json({ error: "Your ILP team handles your payments. Send them a message and they will help." });
      }
      try {
        const sub = await stripeApi(`/subscriptions/${m.paymentRef}`, "GET");
        const customer = typeof sub.customer === "string" ? sub.customer : String((sub.customer as Doc | undefined)?.id ?? "");
        const f = new URLSearchParams();
        f.set("customer", customer);
        const site = (Deno.env.get("PUBLIC_SITE_URL") || "http://localhost:3000").replace(/\/$/, "");
        f.set("return_url", `${site}/status/money`);
        const session = await stripeApi("/billing_portal/sessions", "POST", f);
        res.json({ url: String(session.url) });
      } catch (err) {
        log(`[cancel] billing portal failed for ${m.id}: ${err instanceof Error ? err.message : err}`, "error");
        res.status(502).json({ error: "We could not open the payment page. Please try again, or message your team." });
      }
    }),
  );
}
