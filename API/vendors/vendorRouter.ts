/**
 * API/vendors/vendorRouter.ts
 *
 * CRUD endpoints for the ILP legal-professional vendor registry.
 *
 * All routes require ILP-staff dashboard authentication.
 *
 * Routes:
 *   GET    /api/vendors                  list (with optional filters)
 *   POST   /api/vendors                  create
 *   GET    /api/vendors/match/:clientId  suggest vendors for a client
 *   GET    /api/vendors/:id              detail
 *   PATCH  /api/vendors/:id              update
 *   DELETE /api/vendors/:id              soft-delete (active → false)
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import get from "../../db/get.ts";
import getAll from "../../db/getAll.ts";
import put from "../../db/put.ts";
import patch from "../../db/patch.ts";
import validateUser from "../../helper/auth/validateUser.ts";
import type { Vendor, VendorCreatePayload, VendorUpdatePayload } from "./vendorTypes.ts";
import { LEGAL_AREAS } from "./vendorTypes.ts";

const COLLECTION = "vendors";

function nanoId(size = 16): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const arr = crypto.getRandomValues(new Uint8Array(size));
  return Array.from(arr).map((b) => chars[b % chars.length]).join("");
}

// ─── Validation helpers ───────────────────────────────────────────────────────

function validateCreatePayload(
  body: Record<string, unknown>,
): { ok: true; data: VendorCreatePayload } | { ok: false; error: string } {
  if (!String(body.companyName ?? "").trim()) return { ok: false, error: "companyName is required." };
  if (!String(body.contactName ?? "").trim()) return { ok: false, error: "contactName is required." };
  if (!String(body.email ?? "").trim()) return { ok: false, error: "email is required." };

  const legalAreas: string[] = Array.isArray(body.legalAreas) ? body.legalAreas as string[] : [];
  const invalidArea = legalAreas.find((c) => !(LEGAL_AREAS as string[]).includes(c));
  if (legalAreas.length === 0) return { ok: false, error: "At least one legalArea is required." };
  if (invalidArea) return { ok: false, error: `Unknown legalArea: ${invalidArea}` };

  const data: VendorCreatePayload = {
    companyName: String(body.companyName).trim(),
    contactName: String(body.contactName).trim(),
    email: String(body.email).trim().toLowerCase(),
    phone: body.phone ? String(body.phone).trim() : undefined,
    website: body.website ? String(body.website).trim() : undefined,
    legalAreas: legalAreas as VendorCreatePayload["legalAreas"],
    jurisdictions: Array.isArray(body.jurisdictions) ? body.jurisdictions as string[] : [],
    languages: Array.isArray(body.languages) ? body.languages as string[] : [],
    credentials: body.credentials ? String(body.credentials).trim() : undefined,
    notes: body.notes ? String(body.notes).trim() : undefined,
    active: body.active !== false, // default true
  };

  return { ok: true, data };
}

// ─── Router factory ────────────────────────────────────────────────────────────

export default function vendorRouter(app: Express) {
  log("[vendors] router initialized.");

  // ── LIST ──────────────────────────────────────────────────────────────────
  app.get(
    "/api/vendors",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const all = await getAll(COLLECTION);
      let vendors: Vendor[] = (all || []).map((doc) => ({ ...doc })) as unknown as Vendor[];

      const { legalArea, jurisdiction, includeInactive } = req.query as Record<string, string>;

      if (includeInactive !== "true") {
        vendors = vendors.filter((v) => v.active !== false);
      }
      if (legalArea) {
        vendors = vendors.filter((v) => v.legalAreas?.includes(legalArea as never));
      }
      if (jurisdiction) {
        vendors = vendors.filter((v) =>
          v.jurisdictions?.length === 0 ||
          v.jurisdictions?.includes(jurisdiction.toUpperCase())
        );
      }

      vendors.sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return (a.companyName || "").localeCompare(b.companyName || "");
      });

      res.json({ vendors, total: vendors.length });
    }),
  );

  // ── MATCH (must be before /:id so Express doesn't eat "match") ─────────────
  app.get(
    "/api/vendors/match/:clientId",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const { clientId } = req.params;

      const doc = await get("clients", clientId);
      if (!doc) {
        return res.status(404).json({ error: "Client not found.", vendors: [] });
      }

      const insights = (doc.transcriptInsights ?? {}) as Record<string, unknown>;
      const legalArea: string | null = typeof insights?.legalArea === "string"
        ? insights.legalArea
        : null;

      const wantedArea = legalArea ?? null;

      const all = await getAll(COLLECTION);
      const vendors: Vendor[] = ((all || []) as unknown as Vendor[]).filter((v) => v.active !== false);

      const scored = vendors.map((v) => {
        let score = 0;
        if (wantedArea && v.legalAreas?.includes(wantedArea as never)) score += 2;

        const jurisdiction = typeof doc.jurisdiction === "string"
          ? doc.jurisdiction.toUpperCase()
          : "";
        if (jurisdiction) {
          if (v.jurisdictions?.length === 0 || v.jurisdictions?.includes(jurisdiction)) score += 1;
        }

        return { vendor: v, score };
      });

      scored.sort((a, b) => b.score - a.score);

      res.json({
        vendors: scored.map((s) => ({ ...s.vendor, _matchScore: s.score })),
        clientContext: {
          clientId,
          legalArea,
          wantedArea,
          jurisdiction: typeof doc.jurisdiction === "string" ? doc.jurisdiction : null,
        },
        total: scored.length,
      });
    }),
  );

  // ── CREATE ────────────────────────────────────────────────────────────────
  app.post(
    "/api/vendors",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const validation = validateCreatePayload(req.body ?? {});
      if (!validation.ok) {
        return res.status(400).json({ error: validation.error });
      }

      const id = nanoId(16);
      const now = new Date().toISOString();
      const vendor: Vendor = {
        id,
        ...validation.data,
        createdAt: now,
        updatedAt: now,
      };

      await put(COLLECTION, id, vendor as unknown as Record<string, unknown>);
      log(`[vendors] Created vendor ${id}: ${vendor.companyName}`);
      res.status(201).json({ vendor });
    }),
  );

  // ── DETAIL ────────────────────────────────────────────────────────────────
  app.get(
    "/api/vendors/:id",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const doc = await get(COLLECTION, req.params.id);
      if (!doc) return res.status(404).json({ error: "Vendor not found." });
      res.json({ vendor: { id: req.params.id, ...doc } });
    }),
  );

  // ── UPDATE ────────────────────────────────────────────────────────────────
  app.patch(
    "/api/vendors/:id",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const existing = await get(COLLECTION, req.params.id);
      if (!existing) return res.status(404).json({ error: "Vendor not found." });

      const body: VendorUpdatePayload = (req.body ?? {}) as VendorUpdatePayload;

      if (body.legalAreas !== undefined) {
        if (!Array.isArray(body.legalAreas) || body.legalAreas.length === 0) {
          return res.status(400).json({ error: "legalAreas must be a non-empty array." });
        }
        const invalid = body.legalAreas.find((c) => !(LEGAL_AREAS as string[]).includes(c));
        if (invalid) return res.status(400).json({ error: `Unknown legalArea: ${invalid}` });
      }

      const { id: _id, createdAt: _c, ...safeBody } = body as Record<string, unknown>;

      const updates = { ...safeBody, updatedAt: new Date().toISOString() };
      await patch(COLLECTION, req.params.id, updates);

      const updated: Vendor = { id: req.params.id, ...existing, ...updates } as Vendor;
      log(`[vendors] Updated vendor ${req.params.id}`);
      res.json({ vendor: updated });
    }),
  );

  // ── SOFT DELETE ───────────────────────────────────────────────────────────
  app.delete(
    "/api/vendors/:id",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const existing = await get(COLLECTION, req.params.id);
      if (!existing) return res.status(404).json({ error: "Vendor not found." });

      await patch(COLLECTION, req.params.id, {
        active: false,
        updatedAt: new Date().toISOString(),
      });

      log(`[vendors] Soft-deleted vendor ${req.params.id}`);
      res.json({ success: true, message: "Vendor deactivated." });
    }),
  );
}