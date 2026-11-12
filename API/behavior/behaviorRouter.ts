/**
 * API/behavior/behaviorRouter.ts — BEHAVIOR: heat maps and on-page behavior.
 *
 * Public (no login, own limiter 90/min per address, 32 KB):
 *   POST /api/journey/behavior                     one summary per page view (model.ts parseSummary)
 * Staff (any dashboard session):
 *   GET  /api/dashboard/journeys/behavior/pages    ?from&to            every page: views, time, scroll, rage, dead, speed, errors
 *   GET  /api/dashboard/journeys/behavior/page     ?path&from&to&device  heat grids, scroll reach, attention, elements, findings
 *
 * Only totals per day, page and device are stored (store.ts). No person, no
 * text typed, nothing from the signed-in portals.
 */
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import { requireDashboardAuth } from "../../helper/auth/session.ts";
import { clientIpKey } from "../../helper/rateLimitKeys.ts";
import { cleanPath, type Device, DEVICES, heatView, insightsFor, pageView, parseSummary } from "./model.ts";
import { type BehaviorStore, behaviorStore } from "./store.ts";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** from/to (UTC days) from the query; default the last 28 days; at most 400 days. */
export function rangeOf(q: Record<string, unknown>, now = new Date()): { from: string; to: string } {
  const today = now.toISOString().slice(0, 10);
  let to = typeof q.to === "string" && DAY_RE.test(q.to) ? q.to : today;
  if (to > today) to = today;
  const min = new Date(Date.parse(`${to}T00:00:00Z`) - 399 * 86_400_000).toISOString().slice(0, 10);
  let from = typeof q.from === "string" && DAY_RE.test(q.from) ? q.from : new Date(Date.parse(`${to}T00:00:00Z`) - 27 * 86_400_000).toISOString().slice(0, 10);
  if (from > to) from = to;
  if (from < min) from = min;
  return { from, to };
}

export function registerBehaviorRoutes(app: Express, store: BehaviorStore = behaviorStore) {
  const limiter = rateLimit({
    windowMs: 60_000,
    max: 90,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
    keyGenerator: clientIpKey,
    message: { error: "Too many measurements." },
  });

  app.post("/api/journey/behavior", limiter, (req: Request, res: Response) => {
    // A measurement must never cost the visitor anything: always 204, even when it is dropped.
    try {
      const s = parseSummary(req.body);
      if (s) store.ingest(s);
    } catch (err) {
      log(`[behavior] ingest failed: ${err instanceof Error ? err.message : err}`, "error");
    }
    res.status(204).end();
  });

  app.get(
    "/api/dashboard/journeys/behavior/pages",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const range = rangeOf(req.query as Record<string, unknown>);
      const rows = (await store.pages(range.from, range.to)).map(pageView);
      const total = rows.reduce((t, r) => ({ views: t.views + r.views, clicks: t.clicks + r.clicks, rage: t.rage + r.rage, dead: t.dead + r.dead, errors: t.errors + r.errors }), { views: 0, clicks: 0, rage: 0, dead: 0, errors: 0 });
      res.json({ ...range, total, pages: rows });
    }),
  );

  app.get(
    "/api/dashboard/journeys/behavior/page",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const path = cleanPath(req.query.path);
      if (!path) return res.status(400).json({ error: "Choose a public page." });
      const device = DEVICES.includes(req.query.device as Device) ? (req.query.device as Device) : undefined;
      const range = rangeOf(req.query as Record<string, unknown>);
      const view = heatView(await store.page(path, range.from, range.to, device));
      res.json({ ...range, device: device ?? null, ...view, insights: insightsFor(view, view.reach) });
    }),
  );
}

export default function behaviorRouter(app: Express) {
  log("Behavior router initialized.");
  registerBehaviorRoutes(app);
}
