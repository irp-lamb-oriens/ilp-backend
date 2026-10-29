/**
 * API/notifications/notificationsRouter.ts — the bell (COMMS-P3).
 * ──────────────────────────────────────────────────────────────────────────
 * Staff, admins and CSMs (dashboard session; the /csm portal uses the same
 * session kind, see helper/auth/roles.ts):
 *   GET  /api/notifications?limit=30          { items, unread }
 *   GET  /api/notifications/unread-count      { unread }
 *   POST /api/notifications/read              { ids: string[] }  → { marked }
 *   POST /api/notifications/read-all                             → { marked }
 * Lawyers (provider session):
 *   GET  /api/provider/notifications, /api/provider/notifications/unread-count,
 *   POST /api/provider/notifications/read, /api/provider/notifications/read-all
 * The older GET /api/dashboard/notifications (ROUTING) answers the same data.
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import { type AuthedRequest, requireDashboardAuth, requireProviderAuth } from "../../helper/auth/session.ts";
import { staffRoleFor } from "../../helper/auth/roles.ts";
import { bellFor, markRead, type Reader } from "./store.ts";
import { bookClientIds } from "../csm/book.ts";

async function staffReader(req: Request): Promise<Reader> {
  const email = String((req as AuthedRequest).dashboardUser ?? "").toLowerCase();
  const role = staffRoleFor(email);
  return role === "csm" ? { role, id: email, bookClientIds: await bookClientIds(email) } : { role, id: email };
}

function lawyerReader(req: Request): Reader | null {
  const id = String((req as AuthedRequest).providerId ?? "");
  return id ? { role: "lawyer", id } : null;
}

const limitOf = (req: Request) => Math.max(1, Math.min(100, Number(req.query.limit) || 30));
const idsOf = (req: Request) => (Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map(String).filter(Boolean) : []);

export default function notificationsRouter(app: Express): void {
  app.get("/api/notifications", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    res.json(await bellFor(await staffReader(req), limitOf(req)));
  }));
  app.get("/api/notifications/unread-count", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    res.json({ unread: (await bellFor(await staffReader(req), 1)).unread });
  }));
  app.post("/api/notifications/read", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    const ids = idsOf(req);
    if (!ids.length) return res.status(400).json({ error: "Name the notifications to mark as read, or use read-all." });
    res.json({ marked: await markRead(await staffReader(req), ids) });
  }));
  app.post("/api/notifications/read-all", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    res.json({ marked: await markRead(await staffReader(req), []) });
  }));

  app.get("/api/provider/notifications", requireProviderAuth, asyncHandler(async (req: Request, res: Response) => {
    const r = lawyerReader(req);
    res.json(r ? await bellFor(r, limitOf(req)) : { items: [], unread: 0 });
  }));
  app.get("/api/provider/notifications/unread-count", requireProviderAuth, asyncHandler(async (req: Request, res: Response) => {
    const r = lawyerReader(req);
    res.json({ unread: r ? (await bellFor(r, 1)).unread : 0 });
  }));
  app.post("/api/provider/notifications/read", requireProviderAuth, asyncHandler(async (req: Request, res: Response) => {
    const r = lawyerReader(req);
    const ids = idsOf(req);
    if (!ids.length) return res.status(400).json({ error: "Name the notifications to mark as read, or use read-all." });
    res.json({ marked: r ? await markRead(r, ids) : 0 });
  }));
  app.post("/api/provider/notifications/read-all", requireProviderAuth, asyncHandler(async (req: Request, res: Response) => {
    const r = lawyerReader(req);
    res.json({ marked: r ? await markRead(r, []) : 0 });
  }));
}
