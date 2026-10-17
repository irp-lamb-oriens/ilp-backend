/**
 * quoteLabelsRouter.ts — CRUD for CUSTOM Quote-line GROUP LABELS.
 *
 * A QuoteLabel is a small, editable, fully-agnostic label (e.g. "Corporate
 * structuring", "Immigration", "Real estate") that operators attach to a
 * quote's line-item GROUPS so the same reusable vocabulary can be applied
 * across every quote. Labels are intentionally generic — operators create
 * whatever taxonomy suits their legal practice.
 *
 * A group persists an opaque `labelId`. The group also keeps its free-text
 * `title` (set to the label's name when a label is chosen), so:
 *   • the client-facing status page keeps working with zero changes, and
 *   • legacy quotes that only have a `title` are completely unaffected.
 *
 * Firestore: quote_labels/{labelId}  (top-level collection)
 *
 * Routes
 * ──────
 *   GET    /api/dashboard/quote-labels             list all
 *   POST   /api/dashboard/quote-labels             create
 *   PATCH  /api/dashboard/quote-labels/:labelId    partial update
 *   DELETE /api/dashboard/quote-labels/:labelId    delete
 *
 * Auth: all routes require requireDashboardAuth.
 */

import type { Express, Request, Response } from "express";
import { requireDashboardAuth } from "../../helper/auth/session.ts";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import patch from "../../db/patch.ts";
import remove from "../../db/delete.ts";
import getAll from "../../db/getAll.ts";
import log from "../../helper/log.ts";

const COLLECTION = "quote_labels";

// ── Helpers ───────────────────────────────────────────────────────────────────

function nanoId(size = 14): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const arr = crypto.getRandomValues(new Uint8Array(size));
  return Array.from(arr).map((b) => chars[b % chars.length]).join("");
}

/** Normalise a label → collapsed-whitespace, trimmed string. */
function normaliseLabel(raw: unknown): string {
  return (typeof raw === "string" ? raw : String(raw ?? ""))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalise a short icon/emoji → trimmed, capped to a few characters so a
 * pasted string can't bloat the doc. Falls back to a neutral 🏷️ when blank.
 */
function normaliseIcon(raw: unknown): string {
  const s = (typeof raw === "string" ? raw : "").trim();
  if (!s) return "🏷️";
  return Array.from(s).slice(0, 4).join("");
}

// ── Router ────────────────────────────────────────────────────────────────────

export default function quoteLabelsRouter(app: Express) {
  app.get(
    "/api/dashboard/quote-labels",
    requireDashboardAuth,
    async (_req: Request, res: Response) => {
      try {
        const labels = await getAll(COLLECTION);

        labels.sort((a: any, b: any) => {
          const aOrd = typeof a.order === "number" ? a.order : 9999;
          const bOrd = typeof b.order === "number" ? b.order : 9999;
          if (aOrd !== bOrd) return aOrd - bOrd;
          return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
        });

        res.json({ quoteLabels: labels });
      } catch (err: any) {
        log(`[quoteLabelsRouter] list: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to list quote labels" });
      }
    },
  );

  app.post(
    "/api/dashboard/quote-labels",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const actor = (req as any).dashboardUser ?? "unknown";
      const now = new Date().toISOString();

      const label = normaliseLabel(req.body?.label);
      if (!label) {
        return res.status(400).json({ error: "label is required." });
      }

      const labelId = nanoId(14);
      const doc = {
        labelId,
        label,
        icon: normaliseIcon(req.body?.icon),
        createdBy: actor,
        createdAt: now,
        updatedAt: null,
      };

      try {
        await put(COLLECTION, labelId, doc);
        log(`[quoteLabelsRouter] Created ${labelId} ("${doc.label}") by ${actor}`);
        res.status(201).json({ success: true, quoteLabel: doc });
      } catch (err: any) {
        log(`[quoteLabelsRouter] create: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to create quote label" });
      }
    },
  );

  app.patch(
    "/api/dashboard/quote-labels/:labelId",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { labelId } = req.params;
      const actor = (req as any).dashboardUser ?? "unknown";
      const now = new Date().toISOString();

      try {
        const existing = await get(COLLECTION, labelId);
        if (!existing) return res.status(404).json({ error: "Quote label not found." });

        const body = req.body ?? {};
        const updates: Record<string, any> = { updatedAt: now };
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

        await patch(COLLECTION, labelId, updates);
        log(`[quoteLabelsRouter] Updated ${labelId}: [${changed.join(", ")}] by ${actor}`);
        res.json({ success: true, labelId, updatedFields: changed });
      } catch (err: any) {
        log(`[quoteLabelsRouter] patch ${labelId}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to update quote label" });
      }
    },
  );

  app.delete(
    "/api/dashboard/quote-labels/:labelId",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { labelId } = req.params;
      const actor = (req as any).dashboardUser ?? "unknown";
      try {
        const existing = await get(COLLECTION, labelId);
        if (!existing) return res.status(404).json({ error: "Quote label not found." });
        await remove(COLLECTION, labelId);
        log(`[quoteLabelsRouter] Deleted ${labelId} by ${actor}`);
        res.json({ success: true, labelId });
      } catch (err: any) {
        log(`[quoteLabelsRouter] delete ${labelId}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to delete quote label" });
      }
    },
  );
}