import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import validateUser from "../../helper/auth/validateUser.ts";
import log from "../../helper/log.ts";
import { createCheckoutSession } from "../../config/integrations.ts";
import type { SessionUser } from "../../helper/auth/types.ts";
import rateLimit from "express-rate-limit";
import { requireDashboardAuth } from "../../helper/auth/session.ts";
import { setSessionCookie } from "../../helper/auth/cookies.ts";
import { sanitizeStr } from "../../helper/sanitize.ts";
import { PLAN_STANDARD } from "../../schemas/contracts.ts";
import {
  activateMembership,
  autopayInManualMode,
  createStripeCheckout,
  getMembership,
  handleStripeEvent,
  issuePortalSession,
  JoinError,
  paymentsMode,
  readJoinSession,
  startJoin,
} from "./membership.ts";
import { markRenewalPaid, membershipById } from "./lifecycle.ts";
import { registerCancelRoutes } from "./cancel.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const joinLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts from this connection. Try again in a few minutes." },
  validate: { trustProxy: false },
});

/**
 * ILP payments.
 *
 * Ported from IRP-funnel's paymentsRouter, tailored to ILP:
 * - IRP's mark-paid / payment-metrics endpoints are relocation-specific
 *   (consultation stages + batch counters) and are SKIPPED.
 * - The portable core is checkout-session creation, wired to ILP's
 *   centralized `createCheckoutSession` integration placeholder.
 * - Auth uses ILP's validateUser("customer") instead of IRP's
 *   x-dashboard-token session check.
 *
 * Routes:
 *   POST /api/payments/checkout — create a payment checkout session
 *
 * Join funnel (W3, see membership.ts):
 *   GET  /api/payments/plan                       — plan + payments mode
 *   POST /api/payments/join                       — client + pending membership (+ Stripe Checkout URL)
 *   GET  /api/payments/join/:token                — membership status for the join page
 *   POST /api/payments/join/:token/portal-session — first portal session for a brand-new member
 *   POST /api/payments/stripe/webhook             — Stripe events (verified by fetching them back)
 *   POST /api/payments/memberships/:id/mark-paid  — staff: manual mode payment received
 *                                                   (pending → activate; active/past_due → renewal, lifecycle.ts)
 *
 * Member membership + cancel (P2, see cancel.ts): /api/payments/me/{membership,cancel,cancel/undo,billing-portal}
 */
export default function paymentsRouter(app: Express) {
  log("Payments router initialized.");
  registerCancelRoutes(app);

  app.post(
    "/api/payments/checkout",
    validateUser("customer"),
    asyncHandler(async (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: SessionUser }).sessionUser!;
      const body = req.body as {
        amount?: number;
        currency?: string;
      };

      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: "A positive amount is required" });
      }

      const session = await createCheckoutSession({
        amount,
        currency: typeof body.currency === "string" && body.currency
          ? body.currency
          : "USD",
        customerId: user.uid,
      });

      res.status(201).json(session);
    })
  );

  app.get("/api/payments/plan", (_req: Request, res: Response) => {
    res.status(200).json({ plan: PLAN_STANDARD, mode: paymentsMode() });
  });

  app.post(
    "/api/payments/join",
    joinLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const email = sanitizeStr(body.email).toLowerCase();
      const fullName = sanitizeStr(body.fullName).slice(0, 120);
      const phone = sanitizeStr(body.phone).slice(0, 40);
      const leadId = sanitizeStr(body.leadId).slice(0, 100);
      if (!email || !EMAIL_RE.test(email) || email.length > 254) {
        return res.status(400).json({ error: "Enter a valid email address." });
      }
      if (!fullName) return res.status(400).json({ error: "Enter your full name." });
      if (body.acceptTerms !== true) {
        return res.status(400).json({ error: "Please confirm you have read the membership terms." });
      }

      try {
        const { session, token, membership } = await startJoin({ email, fullName, phone, leadId });
        const mode = paymentsMode();
        if (mode === "stripe") {
          const checkoutUrl = await createStripeCheckout(session, token);
          return res.status(201).json({ mode, token, status: membership.status, checkoutUrl });
        }
        let status = membership.status;
        if (autopayInManualMode()) {
          const m = await activateMembership(membership.id, "manual:demo-autopay", {
            uid: "system", email: "system", role: "system",
          });
          status = m?.status ?? status;
        }
        res.status(201).json({ mode, token, status });
      } catch (err) {
        if (err instanceof JoinError) return res.status(err.status).json({ error: err.message });
        throw err;
      }
    }),
  );

  app.get(
    "/api/payments/join/:token",
    asyncHandler(async (req: Request, res: Response) => {
      const s = await readJoinSession(req.params.token);
      if (!s) return res.status(404).json({ error: "This join link has expired. Sign in with your email instead." });
      const m = await getMembership(s.membershipId);
      res.status(200).json({
        status: m?.status ?? "pending",
        mode: paymentsMode(),
        email: s.email,
        projectId: s.clientId,
        newClient: s.newClient,
        minutesIncluded: m?.minutesIncluded ?? PLAN_STANDARD.minutesIncluded,
        callsIncluded: m?.callsIncluded ?? PLAN_STANDARD.callsIncluded,
        periodEnd: m?.periodEnd,
      });
    }),
  );

  app.post(
    "/api/payments/join/:token/portal-session",
    joinLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const s = await readJoinSession(req.params.token);
      if (!s) return res.status(404).json({ error: "This join link has expired. Sign in with your email instead." });
      const m = await getMembership(s.membershipId);
      if (m?.status !== "active") return res.status(409).json({ error: "Your membership is not active yet." });
      const issued = await issuePortalSession(req.params.token, s);
      if (!issued) return res.status(200).json({ loginRequired: true, projectId: s.clientId, email: s.email });
      // HttpOnly cookie (W1 sessions); the token is also returned for header-token clients.
      setSessionCookie(res, "client", issued.token, issued.expiresAt);
      res.status(200).json({ token: issued.token, projectId: s.clientId, email: s.email });
    }),
  );

  app.post(
    "/api/payments/stripe/webhook",
    asyncHandler(async (req: Request, res: Response) => {
      if (paymentsMode() !== "stripe") return res.status(404).json({ error: "Stripe is not enabled." });
      try {
        const type = await handleStripeEvent((req.body ?? {}) as Record<string, unknown>);
        res.status(200).json({ received: true, type });
      } catch (err) {
        const status = err instanceof JoinError ? err.status : 400;
        log(`[payments] webhook rejected: ${err instanceof Error ? err.message : err}`, "payments");
        res.status(status).json({ error: "Event could not be verified." });
      }
    }),
  );

  app.post(
    "/api/payments/memberships/:id/mark-paid",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const staff = (req as Request & { dashboardUser?: string }).dashboardUser ?? "staff";
      const reference = sanitizeStr(req.body?.reference).slice(0, 120);
      const ref = `manual:${reference || "marked-paid"}`;
      const actor = { uid: staff, email: staff, role: "staff" };
      const current = await membershipById(req.params.id);
      if (!current) return res.status(404).json({ error: "Membership not found." });
      if (current.status === "cancelled") return res.status(409).json({ error: "This membership is cancelled." });
      // Pending → first payment (activation). Active or past due → renewal.
      if (current.status !== "pending") {
        const daysLeft = (Date.parse(current.periodEnd) - Date.now()) / 86_400_000;
        if (current.status === "active" && daysLeft > 10) {
          return res.status(409).json({
            error: `This membership is paid until ${current.periodEnd.slice(0, 10)}. Record the next payment within 10 days of that date.`,
          });
        }
        const { membership, rolled } = await markRenewalPaid(current, ref, actor);
        return res.status(200).json({ ...membership, renewal: rolled ? "started" : "recorded" });
      }
      const m = await activateMembership(req.params.id, ref, actor);
      if (!m) return res.status(404).json({ error: "Membership not found." });
      res.status(200).json(m);
    }),
  );
}
