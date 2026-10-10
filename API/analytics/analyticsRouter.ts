import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import { requireDashboardAuth } from "../dashboard/dashboardRouter.ts";
import getAll from "../../db/getAll.ts";
import log from "../../helper/log.ts";

/**
 * Staff cohort/funnel analytics. The dashboard traces:
 * acquisition source -> profile -> engagement -> consultation -> outcome.
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
};