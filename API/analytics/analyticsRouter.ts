import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import { requireDashboardAuth } from "../dashboard/dashboardRouter.ts";
import { countDocuments } from "../../helper/firestore/firestoreService.ts";
import { placeholderExcluded } from "../../helper/placeholderScope.ts";
import { summary } from "../../helper/summaries.ts";
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
      // Counts only: Firestore COUNT aggregations (one read per 1000 documents), not every document.
      const status = (value: string) => [{ field: "status", op: "EQUAL" as const, value }];
      const [profiles, consultations, confirmed, downloads, alerts, responded, needsHelp] = await Promise.all([
        countDocuments("profiles"),
        countDocuments("consultations"),
        countDocuments("consultations", status("confirmed")),
        countDocuments("template_downloads"),
        countDocuments("alerts"),
        countDocuments("alerts", status("responded")),
        countDocuments("alerts", status("needs_help")),
      ]);

      res.status(200).json({
        qualifiedProfiles: profiles,
        templateDownloads: downloads,
        alertsDispatched: alerts,
        alertResponses: responded + needsHelp,
        needsHelpRate: alerts ? (needsHelp / alerts) * 100 : 0,
        bookedConsultations: consultations,
        confirmedConsultations: confirmed,
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
      // Company-wide: computed at most once per SUMMARY_TTL_MIN for everyone (helper/summaries.ts).
      const snap = await summary(`pmf:${days}:${placeholderExcluded() ? "real" : "all"}`, () => pmfSummary(days), { refresh: req.query.refresh === "1" });
      res.status(200).json({ ...snap.data, asOf: snap.asOf });
    }),
  );
};
