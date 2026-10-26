import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import { requireDashboardAuth } from "../dashboard/dashboardRouter.ts";
import getAll from "../../db/getAll.ts";
import log from "../../helper/log.ts";
import rateLimit from "express-rate-limit";
import { parseFunnelEvent, pmfSummary, recordFunnelEvent } from "./funnel.ts";

// Public funnel beacons: generous for real visitors, useless for flooding.
const funnelLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many events." },
  validate: { trustProxy: false },
});

/**
 * Staff cohort/funnel analytics. The dashboard traces:
 * acquisition source -> profile -> engagement -> consultation -> outcome.
 *
 * P2 (PMF measurement, see funnel.ts):
 *   POST /api/analytics/funnel   public beacon { step, anonId, leadId?, source? } (rate-limited, no PII)
 *   GET  /api/analytics/pmf?days=30  staff: funnel counts + conversion, post-call rating, NPS, cancel reasons
 */
export default (app: Express) => {
  log("Analytics router initialized.");

  // Staff: aggregated funnel metrics across the MVP's weekly signals.
  app.get(
    "/api/analytics/funnel",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      const [profiles, consultations, downloads, alerts] = await Promise.all([
        getAll("profiles"),
        getAll("consultations"),
        getAll("template_downloads"),
        getAll("alerts"),
      ]);

      const respondedAlerts = alerts.filter((a) => a.status === "responded");
      const needsHelp = alerts.filter((a) => a.status === "needs_help");
      const confirmed = consultations.filter((c) => c.status === "confirmed");

      res.status(200).json({
        qualifiedProfiles: profiles.length,
        templateDownloads: downloads.length,
        alertsDispatched: alerts.length,
        alertResponses: respondedAlerts.length + needsHelp.length,
        needsHelpRate: alerts.length
          ? (needsHelp.length / alerts.length) * 100
          : 0,
        bookedConsultations: consultations.length,
        confirmedConsultations: confirmed.length,
      });
    })
  );

  app.post(
    "/api/analytics/funnel",
    funnelLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const ev = parseFunnelEvent((req.body ?? {}) as Record<string, unknown>);
      if ("error" in ev) return res.status(400).json({ error: ev.error });
      const stored = await recordFunnelEvent(ev);
      res.status(stored ? 201 : 200).json({ ok: true });
    }),
  );

  app.get(
    "/api/analytics/pmf",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const d = Number(req.query.days);
      const days = Number.isInteger(d) && d >= 1 && d <= 365 ? d : 30;
      res.status(200).json(await pmfSummary(days));
    }),
  );
};
