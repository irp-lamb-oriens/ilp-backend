/**
 * crmLilyRouter.ts — Lily AI copilot routes for the ILP dashboard (CRM scope).
 *
 * POST /api/dashboard/clients/:id/lily         — staff sends a message to Lily
 * GET  /api/dashboard/clients/:id/lily/history — load the CRM chat thread
 *
 * Both routes require `requireDashboardAuth` (ILP staff only). The homepage
 * intake flow and the client-status portal are separate and unaffected.
 *
 * Ported from IRP-funnel's `API/dashboard/crmLilyRouter.ts`, wired to ILP's
 * shared `lilyChatEngine` (project-scoped, grounded in the client doc).
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import { requireDashboardAuth } from "../../helper/auth/session.ts";
import { chatWithLily, getChatThread } from "../chatbot/services/lilyChatEngine.ts";

export default (app: Express) => {
  log("CRM Lily router initialized.");

  app.post(
    "/api/dashboard/clients/:id/lily",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const { message } = req.body ?? {};
      const staffEmail: string =
        (req as Request & { dashboardUser?: string }).dashboardUser ?? "staff";

      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "message is required." });
      }

      try {
        const { reply, threadSnapshot } = await chatWithLily(
          id,
          "crm",
          message.trim(),
          staffEmail,
          "staff",
        );
        log(`[crmLily] Staff ${staffEmail} sent a message to Lily for project ${id}`);
        res.json({ reply, rawTail: threadSnapshot.rawTail });
      } catch (err) {
        if (err instanceof Error && err.message === "Project not found.") {
          return res.status(404).json({ error: "Project not found." });
        }
        throw err;
      }
    }),
  );

  app.get(
    "/api/dashboard/clients/:id/lily/history",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const { thread } = await getChatThread(id, "crm");
      res.json({ thread });
    }),
  );
};