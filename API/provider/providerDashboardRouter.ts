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
import {
  chatWithLily,
  getChatThread,
  type LawyerProfile,
} from "../chatbot/services/lilyChatEngine.ts";
import { extractClientFieldsServer } from "../dashboard/extractClientFieldsServer.ts";

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

  app.get(
    "/api/provider/clients/:id",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const providerId = providerIdOf(req);
      const { id } = req.params;
      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });
      if (doc.assignedProviderId !== providerId) {
        return res.status(403).json({ error: "This client is not assigned to you." });
      }
      res.json(buildClientSummary(id, doc, false));
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

  app.post(
    "/api/provider/clients/:id/lily",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const providerId = providerIdOf(req);
      const { id } = req.params;
      const { message } = req.body ?? {};
      const providerEmail = providerEmailOf(req);

      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "message is required." });
      }

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });
      if (doc.assignedProviderId !== providerId) {
        return res.status(403).json({ error: "This client is not assigned to you." });
      }

      const providerDoc = providerId ? await get("providers", providerId) : null;
      const lawyerProfile: LawyerProfile = {
        name: typeof providerDoc?.name === "string" ? providerDoc.name : null,
        legalAreas: Array.isArray(providerDoc?.legalAreas) ? providerDoc.legalAreas : [],
        jurisdictions: Array.isArray(providerDoc?.jurisdictions) ? providerDoc.jurisdictions : [],
      };

      try {
        const { reply } = await chatWithLily(
          id,
          "crm",
          message.trim(),
          providerEmail,
          "staff",
          lawyerProfile,
        );
        res.json({ reply });
      } catch (err) {
        if (err instanceof Error && err.message === "Project not found.") {
          return res.status(404).json({ error: "Project not found." });
        }
        throw err;
      }
    })
  );

  app.get(
    "/api/provider/clients/:id/lily/history",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const providerId = providerIdOf(req);
      const { id } = req.params;

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });
      if (doc.assignedProviderId !== providerId) {
        return res.status(403).json({ error: "This client is not assigned to you." });
      }

      const { thread } = await getChatThread(id, "crm");
      res.json({ thread });
    })
  );

  app.get(
    "/api/provider/clients/:id/notes",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const providerId = providerIdOf(req);
      const { id } = req.params;
      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });
      if (doc.assignedProviderId !== providerId) {
        return res.status(403).json({ error: "This client is not assigned to you." });
      }
      const notes = (Array.isArray(doc.notes) ? doc.notes : []).filter(
        (n) => !(n as Record<string, unknown>).deletedAt,
      );
      res.json({ notes });
    })
  );

  app.post(
    "/api/provider/clients/:id/notes",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const providerId = providerIdOf(req);
      const { id } = req.params;
      const { text } = req.body ?? {};
      const actor = providerEmailOf(req);

      if (!text || typeof text !== "string" || !text.trim()) {
        return res.status(400).json({ error: "Note text is required." });
      }

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });
      if (doc.assignedProviderId !== providerId) {
        return res.status(403).json({ error: "This client is not assigned to you." });
      }

      const nowIso = new Date().toISOString();
      const note: Record<string, unknown> = { text: text.trim(), author: actor, createdAt: nowIso };

      await put(CLIENTS_COLLECTION, id, {
        notes: [...(Array.isArray(doc.notes) ? doc.notes : []), note],
        activityLog: [
          ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
          { type: "note_added", actor, timestamp: nowIso },
        ],
        updatedAt: nowIso,
      });

      res.json({ success: true, note });
    })
  );

  app.patch(
    "/api/provider/clients/:id/notes/:noteId",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const providerId = providerIdOf(req);
      const { id, noteId } = req.params;
      const { text } = req.body ?? {};
      const actor = providerEmailOf(req);

      if (!text || typeof text !== "string" || !text.trim()) {
        return res.status(400).json({ error: "Note text is required." });
      }

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });
      if (doc.assignedProviderId !== providerId) {
        return res.status(403).json({ error: "This client is not assigned to you." });
      }

      const notes = Array.isArray(doc.notes) ? (doc.notes as Record<string, unknown>[]) : [];
      const idx = notes.findIndex((n) => n && n.createdAt === noteId);
      if (idx === -1) return res.status(404).json({ error: "Note not found." });
      if (notes[idx].deletedAt) return res.status(409).json({ error: "Cannot edit a deleted note." });

      const nowIso = new Date().toISOString();
      const updatedNote = { ...notes[idx], text: text.trim(), editedAt: nowIso, editedBy: actor };
      const nextNotes = notes.slice();
      nextNotes[idx] = updatedNote;

      await put(CLIENTS_COLLECTION, id, {
        notes: nextNotes,
        updatedAt: nowIso,
        activityLog: [
          ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
          { type: "note_edited", actor, timestamp: nowIso, noteCreatedAt: noteId },
        ],
      });

      res.json({ success: true, note: updatedNote });
    })
  );

  app.delete(
    "/api/provider/clients/:id/notes/:noteId",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const providerId = providerIdOf(req);
      const { id, noteId } = req.params;
      const actor = providerEmailOf(req);

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });
      if (doc.assignedProviderId !== providerId) {
        return res.status(403).json({ error: "This client is not assigned to you." });
      }

      const notes = Array.isArray(doc.notes) ? (doc.notes as Record<string, unknown>[]) : [];
      const idx = notes.findIndex((n) => n && n.createdAt === noteId);
      if (idx === -1) return res.status(404).json({ error: "Note not found." });
      if (notes[idx].deletedAt) return res.json({ success: true, note: notes[idx] });

      const nowIso = new Date().toISOString();
      const deletedNote = { ...notes[idx], deletedAt: nowIso, deletedBy: actor };
      const nextNotes = notes.slice();
      nextNotes[idx] = deletedNote;

      await put(CLIENTS_COLLECTION, id, {
        notes: nextNotes,
        updatedAt: nowIso,
        activityLog: [
          ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
          { type: "note_deleted", actor, timestamp: nowIso, noteCreatedAt: noteId },
        ],
      });

      res.json({ success: true, note: deletedNote });
    })
  );

  app.post(
    "/api/provider/clients/:id/insights",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const providerId = providerIdOf(req);
      const { id } = req.params;
      const actor = providerEmailOf(req);

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });
      if (doc.assignedProviderId !== providerId) {
        return res.status(403).json({ error: "This client is not assigned to you." });
      }

      const manualText = typeof req.body?.manualText === "string"
        ? req.body.manualText.trim()
        : "";
      const sourceText =
        manualText ||
        (typeof doc.transcript === "string" ? doc.transcript : "");

      if (!sourceText.trim()) {
        return res.status(400).json({
          error: "No transcript on file. Paste a transcript to extract insights.",
        });
      }

      try {
        const insights = await extractClientFieldsServer(sourceText);
        const nowIso = new Date().toISOString();
        await put(CLIENTS_COLLECTION, id, {
          transcriptInsights: insights,
          updatedAt: nowIso,
          activityLog: [
            ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
            { type: "insights_extracted", actor, timestamp: nowIso },
          ],
        });
        res.json({ success: true, insights });
      } catch (err) {
        log(`[provider] insights extraction failed for ${id}: ${err instanceof Error ? err.message : err}`);
        return res.status(502).json({ error: "Extraction failed. Try again shortly." });
      }
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