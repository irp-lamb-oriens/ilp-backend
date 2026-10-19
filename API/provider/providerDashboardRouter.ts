/**
 * providerDashboardRouter.ts — the lawyer's isolated dashboard.
 *
 * Each lawyer (provider) sees ONLY their assigned clients, grouped by stage
 * for a Kanban board, plus their own finance (earnings from settlements).
 *
 * All routes are `requireProviderAuth` and scoped to the authenticated
 * provider's id (attached to the request by the middleware). A lawyer can
 * never read or move another lawyer's clients.
 *
 * Routes:
 *   GET   /api/provider/me
 *   GET   /api/provider/clients
 *   PATCH /api/provider/clients/:id/stage
 *   GET   /api/provider/finance
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import get from "../../db/get.ts";
import getAll from "../../db/getAll.ts";
import put from "../../db/put.ts";
import { requireProviderAuth } from "../../helper/auth/session.ts";
import {
  buildClientSummary,
  computeStage,
  fetchAllClientsWithIds,
  getStageIds,
  getStageLabels,
} from "../dashboard/clientHelpers.ts";
import { ensureStageConfig, isValidStage } from "../dashboard/automation/stageConfig.ts";

const CLIENTS_COLLECTION = "clients";
const SETTLEMENTS = "quoteSettlements";

/** The authenticated provider id, attached by requireProviderAuth. */
function providerIdOf(req: Request): string {
  return (req as Request & { providerId?: string }).providerId ?? "";
}

/** The authenticated provider email, attached by requireProviderAuth. */
function providerEmailOf(req: Request): string {
  return (req as Request & { providerUser?: string }).providerUser ?? "";
}

export default function providerDashboardRouter(app: Express) {
  log("Provider dashboard router initialized.");

  app.get(
    "/api/provider/me",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = providerIdOf(req);
      const email = providerEmailOf(req);
      const doc = id ? await get("providers", id) : null;
      res.json({
        providerId: id,
        email,
        name: doc?.name ?? null,
        score: doc?.score ?? null,
        legalAreas: doc?.legalAreas ?? [],
        jurisdictions: doc?.jurisdictions ?? [],
      });
    })
  );

  app.get(
    "/api/provider/clients",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const providerId = providerIdOf(req);
      if (!providerId) {
        return res.status(401).json({ error: "No provider identity on session." });
      }

      await ensureStageConfig();
      const all = await fetchAllClientsWithIds();
      const mine = all.filter(
        ({ data }) => data.assignedProviderId === providerId,
      );

      const clients = mine.map(({ docId, data }) =>
        buildClientSummary(docId, data, false)
      );
      clients.sort((a, b) => {
        const da = a.lastUpdated ? new Date(a.lastUpdated as string).getTime() : 0;
        const db = b.lastUpdated ? new Date(b.lastUpdated as string).getTime() : 0;
        return db - da;
      });

      res.json({
        clients,
        stages: getStageIds(),
        stageLabels: getStageLabels(),
        total: clients.length,
      });
    })
  );

  app.patch(
    "/api/provider/clients/:id/stage",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const providerId = providerIdOf(req);
      const { id } = req.params;
      const { stage } = req.body ?? {};

      if (!stage) return res.status(400).json({ error: "Invalid stage." });
      await ensureStageConfig();
      if (!isValidStage(stage)) return res.status(400).json({ error: "Invalid stage." });

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });

      // Isolation: a lawyer can only move their own assigned clients.
      if (doc.assignedProviderId !== providerId) {
        return res.status(403).json({ error: "This client is not assigned to you." });
      }

      const previousStage = computeStage(doc);
      const nowIso = new Date().toISOString();

      await put(CLIENTS_COLLECTION, id, {
        stage,
        stageEnteredAt: nowIso,
        updatedAt: nowIso,
        activityLog: [
          ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
          {
            type: "stage_change",
            from: previousStage,
            to: stage,
            actor: providerEmailOf(req),
            timestamp: nowIso,
          },
        ],
      });

      log(`[provider] ${providerEmailOf(req)} moved ${id} from ${previousStage} to ${stage}`);
      res.json({ success: true, stage, previousStage });
    })
  );

  app.get(
    "/api/provider/finance",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const providerId = providerIdOf(req);
      if (!providerId) {
        return res.status(401).json({ error: "No provider identity on session." });
      }

      const settlementDocs = await getAll(SETTLEMENTS).catch(() => []);

      // This lawyer's provider-payment rows across every settlement.
      const providerPayments: Array<Record<string, unknown>> = [];
      let totalEarned = 0;
      let totalPending = 0;

      for (const s of settlementDocs) {
        const rows = Array.isArray(s?.providerPayments) ? s.providerPayments : [];
        for (const p of rows) {
          if (p?.providerId !== providerId) continue;
          const amount = Number(p.amount) || 0;
          const paid = p.paid === true;
          providerPayments.push({
            quoteId: s.id,
            clientId: s.clientId ?? null,
            date: p.date ?? null,
            amount,
            paid,
            note: p.note ?? null,
          });
          if (paid) totalEarned += amount;
          else totalPending += amount;
        }
      }

      providerPayments.sort((a, b) =>
        String(b.date ?? "").localeCompare(String(a.date ?? ""))
      );

      res.json({
        providerId,
        providerPayments,
        totalEarned: Math.round(totalEarned * 100) / 100,
        totalPending: Math.round(totalPending * 100) / 100,
        settlementCount: providerPayments.length,
      });
    })
  );
}