/**
 * serviceTypesRouter.ts — CRUD for CUSTOM legal SERVICE TYPES.
 *
 * Ported from IRP-funnel's `serviceTypesRouter.ts`, retargeted to ILP's legal
 * taxonomy. A ServiceType is a small, editable label + icon (e.g. "Notary" 🖋️)
 * that the Quote Editor's service-type selector merges ON TOP of the built-in
 * legal service types (immigration, corporate, real_estate, notary).
 *
 * Firestore: quote_service_types/{serviceTypeId}  (top-level collection)
 *
 * Routes
 * ──────
 *   GET    /api/dashboard/service-types                  list all
 *   POST   /api/dashboard/service-types                  create
 *   PATCH  /api/dashboard/service-types/:serviceTypeId   partial update
 *   DELETE /api/dashboard/service-types/:serviceTypeId   delete
 *
 * Auth: all routes require x-dashboard-token (requireDashboardAuth).
 */

import type { Express, Request, Response } from "express";
import { requireDashboardAuth } from "../../helper/auth/session.ts";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import patch from "../../db/patch.ts";
import del from "../../db/delete.ts";
import getAll, { type FirestoreDocument } from "../../db/getAll.ts";
import log from "../../helper/log.ts";

const COLLECTION = "quote_service_types";

function nanoId(size = 14): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const arr = crypto.getRandomValues(new Uint8Array(size));
  return Array.from(arr).map((b) => chars[b % chars.length]).join("");
}

function normaliseLabel(raw: unknown): string {
  return (typeof raw === "string" ? raw : String(raw ?? ""))
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseIcon(raw: unknown): string {
  const s = (typeof raw === "string" ? raw : "").trim();
  if (!s) return "🧩";
  return Array.from(s).slice(0, 4).join("");
}

export default function serviceTypesRouter(app: Express) {
  app.get(
    "/api/dashboard/service-types",
    requireDashboardAuth,
    async (_req: Request, res: Response) => {
      try {
        const serviceTypes = await getAll(COLLECTION);
        serviceTypes.sort((a: FirestoreDocument, b: FirestoreDocument) => {
          const aOrd = typeof a.order === "number" ? a.order : 9999;
          const bOrd = typeof b.order === "number" ? b.order : 9999;
          if (aOrd !== bOrd) return aOrd - bOrd;
          return String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""));
        });
        res.json({ serviceTypes });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`[serviceTypesRouter] list: ${message}`);
        res.status(500).json({ error: message || "Failed to list service types" });
      }
    },
  );

  app.post(
    "/api/dashboard/service-types",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "unknown";
      const now = new Date().toISOString();

      const label = normaliseLabel(req.body?.label);
      if (!label) {
        return res.status(400).json({ error: "label is required." });
      }

      const serviceTypeId = nanoId(14);
      const doc = {
        serviceTypeId,
        label,
        icon: normaliseIcon(req.body?.icon),
        createdBy: actor,
        createdAt: now,
        updatedAt: null,
      };

      try {
        await put(COLLECTION, serviceTypeId, doc);
        log(`[serviceTypesRouter] Created ${serviceTypeId} ("${doc.label}") by ${actor}`);
        res.status(201).json({ success: true, serviceType: doc });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`[serviceTypesRouter] create: ${message}`);
        res.status(500).json({ error: message || "Failed to create service type" });
      }
    },
  );

  app.patch(
    "/api/dashboard/service-types/:serviceTypeId",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { serviceTypeId } = req.params;
      const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "unknown";
      const now = new Date().toISOString();

      try {
        const existing = await get(COLLECTION, serviceTypeId);
        if (!existing) return res.status(404).json({ error: "Service type not found." });

        const body = req.body ?? {};
        const updates: Record<string, unknown> = { updatedAt: now };
        const changed: string[] = [];

        if ("label" in body) {
          const l = normaliseLabel(body.label);
          if (!l) return res.status(400).json({ error: "label cannot be empty." });
          updates.label = l;
          changed.push("label");
        }
        if ("icon" in body) {
          updates.icon = normaliseIcon(body.icon);
          changed.push("icon");
        }

        await patch(COLLECTION, serviceTypeId, updates);
        log(`[serviceTypesRouter] Updated ${serviceTypeId}: [${changed.join(", ")}] by ${actor}`);
        res.json({ success: true, serviceTypeId, updatedFields: changed });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`[serviceTypesRouter] patch ${serviceTypeId}: ${message}`);
        res.status(500).json({ error: message || "Failed to update service type" });
      }
    },
  );

  app.delete(
    "/api/dashboard/service-types/:serviceTypeId",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { serviceTypeId } = req.params;
      const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "unknown";
      try {
        const existing = await get(COLLECTION, serviceTypeId);
        if (!existing) return res.status(404).json({ error: "Service type not found." });
        await del(COLLECTION, serviceTypeId);
        log(`[serviceTypesRouter] Deleted ${serviceTypeId} by ${actor}`);
        res.json({ success: true, serviceTypeId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`[serviceTypesRouter] delete ${serviceTypeId}: ${message}`);
        res.status(500).json({ error: message || "Failed to delete service type" });
      }
    },
  );
}