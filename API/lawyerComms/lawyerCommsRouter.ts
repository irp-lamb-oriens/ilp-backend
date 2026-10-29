/**
 * API/lawyerComms/lawyerCommsRouter.ts — routes for COMMS-P2.
 * ──────────────────────────────────────────────────────────────────────────
 * Lawyer (requireProviderAuth; /api/provider responses pass stripProviderResponses):
 *   GET  /api/provider/feedback                  own anonymized comments and star average (no score, no ranking)
 *   GET  /api/provider/work-offers               work offered to me
 *   POST /api/provider/work-offers/:id/respond   { action: "accept" | "decline", reason? }
 *
 * Staff (requireDashboardAuth; writes audited):
 *   GET  /api/dashboard/lawyer-feedback/config   thresholds (defaults filled)
 *   PUT  /api/dashboard/lawyer-feedback/config   save thresholds (admin)
 *   GET  /api/dashboard/opportunities/:id/offers offers with lawyer names, and lawyers who fit
 *   POST /api/dashboard/opportunities/:id/offer  { providerIds?, description?, respondInDays? }
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import { type AuthedRequest, requireDashboardAuth, requireProviderAuth } from "../../helper/auth/session.ts";
import { requireStaffRole } from "../../helper/auth/roles.ts";
import { LAWYER_FEEDBACK_DEFAULTS, LAWYER_FEEDBACK_LIMITS } from "../../schemas/contracts.ts";
import { lawyerFeedbackFor, loadFeedbackConfig, saveFeedbackConfig } from "./feedback.ts";
import { OfferError, offerOpportunity, offersForLawyer, respondToOffer, staffOffers } from "./offers.ts";

const providerIdOf = (req: Request) => String((req as AuthedRequest).providerId ?? "");
const staffEmail = (req: Request) => String((req as AuthedRequest).dashboardUser ?? "staff");

function sendOfferError(res: Response, err: unknown) {
  if (err instanceof OfferError) return res.status(err.status).json({ error: err.message });
  throw err;
}

export default function lawyerCommsRouter(app: Express) {
  app.get(
    "/api/provider/feedback",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const pid = providerIdOf(req);
      if (!pid) return res.status(401).json({ error: "No lawyer identity on this session." });
      res.json(await lawyerFeedbackFor(pid));
    }),
  );

  app.get(
    "/api/provider/work-offers",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const pid = providerIdOf(req);
      if (!pid) return res.status(401).json({ error: "No lawyer identity on this session." });
      res.json({ offers: await offersForLawyer(pid) });
    }),
  );

  app.post(
    "/api/provider/work-offers/:id/respond",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const pid = providerIdOf(req);
      if (!pid) return res.status(401).json({ error: "No lawyer identity on this session." });
      try {
        res.json({ offer: await respondToOffer(String(req.params.id), pid, req.body?.action, req.body?.reason) });
      } catch (err) {
        sendOfferError(res, err);
      }
    }),
  );

  app.get(
    "/api/dashboard/lawyer-feedback/config",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      res.json({ config: await loadFeedbackConfig(), defaults: LAWYER_FEEDBACK_DEFAULTS, limits: LAWYER_FEEDBACK_LIMITS });
    }),
  );

  app.put(
    "/api/dashboard/lawyer-feedback/config",
    requireDashboardAuth,
    requireStaffRole("admin"),
    asyncHandler(async (req: Request, res: Response) => {
      const r = await saveFeedbackConfig(req.body, staffEmail(req));
      res.status(r.status).json(r.body);
    }),
  );

  app.get(
    "/api/dashboard/opportunities/:id/offers",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      try {
        res.json(await staffOffers(String(req.params.id)));
      } catch (err) {
        sendOfferError(res, err);
      }
    }),
  );

  app.post(
    "/api/dashboard/opportunities/:id/offer",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      try {
        const out = await offerOpportunity(String(req.params.id), staffEmail(req), req.body ?? {});
        res.json({ offered: out.offers.length, skipped: out.skipped.length, ...(await staffOffers(String(req.params.id))) });
      } catch (err) {
        sendOfferError(res, err);
      }
    }),
  );
}
