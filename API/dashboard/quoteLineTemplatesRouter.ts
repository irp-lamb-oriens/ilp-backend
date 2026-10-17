/**
 * quoteLineTemplatesRouter.ts — CRUD for reusable Quote LINE-ITEM templates.
 *
 * A QuoteLineTemplate is a named, ordered list of line-item LABELS (e.g. the
 * Costa Rica cost breakdown). Applying one in the Quote Editor seeds the
 * quote's line items with those labels (amount 0, editor's default margin,
 * the template's default currency) so the operator only fills in the numbers.
 *
 * This is intentionally SEPARATE from quote_templates (proposal content blocks):
 *   • quote_templates       → proposal document blocks (html/quoteTable/accept)
 *   • quote_line_templates  → pricing line-item presets (THIS file)
 *
 * Firestore: quote_line_templates/{templateId}  (top-level collection)
 *
 * Routes
 * ──────
 *   GET    /api/dashboard/quote-line-templates              list all
 *   GET    /api/dashboard/quote-line-templates/:templateId  get one
 *   POST   /api/dashboard/quote-line-templates              create
 *   PATCH  /api/dashboard/quote-line-templates/:templateId  partial update
 *   DELETE /api/dashboard/quote-line-templates/:templateId  delete
 *
 * Auth: all routes require requireDashboardAuth.
 *
 * Data is fully generative: this router is pure CRUD over Firestore. There are
 * NO hardcoded/default templates here — every preset lives as an editable
 * document, created/edited/deleted from the Quote Editor's line-template
 * selector.
 */

import type { Express, Request, Response } from "express";
import { requireDashboardAuth } from "../../helper/auth/session.ts";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import patch from "../../db/patch.ts";
import remove from "../../db/delete.ts";
import getAll from "../../db/getAll.ts";
import log from "../../helper/log.ts";

const COLLECTION = "quote_line_templates";

// ── Helpers ───────────────────────────────────────────────────────────────────

function nanoId(size = 14): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const arr = crypto.getRandomValues(new Uint8Array(size));
  return Array.from(arr).map((b) => chars[b % chars.length]).join("");
}

/** Normalise a `lines` array from the request body → trimmed, non-empty strings. */
function normaliseLines(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => (typeof l === "string" ? l : String(l ?? "")))
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);
}

/** Normalise a currency code → 3-letter uppercase, default USD. */
function normaliseCurrency(raw: unknown): string {
  const c = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(c) ? c : "USD";
}

// ── Router ────────────────────────────────────────────────────────────────────

export default function quoteLineTemplatesRouter(app: Express) {
  app.get(
    "/api/dashboard/quote-line-templates",
    requireDashboardAuth,
    async (_req: Request, res: Response) => {
      try {
        const templates = await getAll(COLLECTION);

        templates.sort((a: any, b: any) => {
          const aPin = a.isDefault ? 0 : 1;
          const bPin = b.isDefault ? 0 : 1;
          if (aPin !== bPin) return aPin - bPin;
          const aOrd = typeof a.order === "number" ? a.order : 9999;
          const bOrd = typeof b.order === "number" ? b.order : 9999;
          if (aOrd !== bOrd) return aOrd - bOrd;
          return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
        });

        res.json({ templates });
      } catch (err: any) {
        log(`[quoteLineTemplatesRouter] list: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to list line templates" });
      }
    },
  );

  app.get(
    "/api/dashboard/quote-line-templates/:templateId",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { templateId } = req.params;
      try {
        const template = await get(COLLECTION, templateId);
        if (!template) return res.status(404).json({ error: "Template not found." });
        res.json(template);
      } catch (err: any) {
        log(`[quoteLineTemplatesRouter] get ${templateId}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to fetch line template" });
      }
    },
  );

  app.post(
    "/api/dashboard/quote-line-templates",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const actor = (req as any).dashboardUser ?? "unknown";
      const now = new Date().toISOString();

      const { name, description = null, currency = "USD", lines = [] } = req.body ?? {};

      if (!name?.trim()) {
        return res.status(400).json({ error: "name is required." });
      }

      const templateId = nanoId(14);
      const doc = {
        templateId,
        name: String(name).trim(),
        description: description?.trim() || null,
        currency: normaliseCurrency(currency),
        lines: normaliseLines(lines),
        isDefault: false,
        createdBy: actor,
        createdAt: now,
        updatedAt: null,
      };

      try {
        await put(COLLECTION, templateId, doc);
        log(`[quoteLineTemplatesRouter] Created ${templateId} ("${doc.name}") by ${actor}`);
        res.status(201).json({ success: true, template: doc });
      } catch (err: any) {
        log(`[quoteLineTemplatesRouter] create: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to create line template" });
      }
    },
  );

  app.patch(
    "/api/dashboard/quote-line-templates/:templateId",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { templateId } = req.params;
      const actor = (req as any).dashboardUser ?? "unknown";
      const now = new Date().toISOString();

      try {
        const existing = await get(COLLECTION, templateId);
        if (!existing) return res.status(404).json({ error: "Template not found." });

        const body = req.body ?? {};
        const updates: Record<string, any> = { updatedAt: now };
        const changed: string[] = [];

        if ("name" in body) {
          const n = String(body.name ?? "").trim();
          if (!n) return res.status(400).json({ error: "name cannot be empty." });
          updates.name = n;
          changed.push("name");
        }
        if ("description" in body) {
          updates.description = body.description?.trim() || null;
          changed.push("description");
        }
        if ("currency" in body) {
          updates.currency = normaliseCurrency(body.currency);
          changed.push("currency");
        }
        if ("lines" in body) {
          updates.lines = normaliseLines(body.lines);
          changed.push("lines");
        }

        await patch(COLLECTION, templateId, updates);
        log(`[quoteLineTemplatesRouter] Updated ${templateId}: [${changed.join(", ")}] by ${actor}`);
        res.json({ success: true, templateId, updatedFields: changed });
      } catch (err: any) {
        log(`[quoteLineTemplatesRouter] patch ${templateId}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to update line template" });
      }
    },
  );

  app.delete(
    "/api/dashboard/quote-line-templates/:templateId",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { templateId } = req.params;
      const actor = (req as any).dashboardUser ?? "unknown";
      try {
        const existing = await get(COLLECTION, templateId);
        if (!existing) return res.status(404).json({ error: "Template not found." });
        await remove(COLLECTION, templateId);
        log(`[quoteLineTemplatesRouter] Deleted ${templateId} by ${actor}`);
        res.json({ success: true, templateId });
      } catch (err: any) {
        log(`[quoteLineTemplatesRouter] delete ${templateId}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to delete line template" });
      }
    },
  );
}