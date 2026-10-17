/**
 * API/dashboard/overviewFieldsRouter.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Dashboard endpoints for the centralized "Overview Field Registry"
 * (Automations → Overview fields): list, create, rename/retype, reorder, and
 * delete of the fields surfaced on a client card's Overview tab.
 *
 * CONTRACT (advisory / additive — see fieldDefaults.ts):
 *   • This is NOT a whitelist. Deleting a field NEVER deletes client data and
 *     never hides a field a client doc already has. It only stops offering the
 *     empty suggested slot going forward, so DELETE needs no migration guard.
 *   • Imports/POSTs carrying unknown fields are always accepted elsewhere.
 *
 * All heavy lifting is delegated to the modular `fieldStore` functions.
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import { requireDashboardAuth } from "../../helper/auth/session.ts";
import {
  deleteFieldDoc,
  ensureFieldsSeeded,
  getFieldFromDb,
  listFieldsFromDb,
  reorderFields,
  upsertField,
} from "./automation/fieldStore.ts";
import type { FieldDef } from "./automation/fieldDefaults.ts";

const FIELD_SERVICE_VALUES: ReadonlySet<string> = new Set([
  "general", "immigration", "corporate", "real_estate", "notary",
]);

/** Coerce an incoming serviceGroup into a valid `FieldService` value (default "general"). */
function validServiceGroup(v: unknown): FieldDef["serviceGroup"] {
  const s = typeof v === "string" && v.trim() ? v.trim() : "general";
  return (FIELD_SERVICE_VALUES.has(s) ? s : "general") as FieldDef["serviceGroup"];
}

/** Turn a free-text label into a safe, camel-ish field id / doc key. */
function slugifyFieldId(label: string): string {
  const cleaned = String(label || "")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim();
  if (!cleaned) return `field_${Date.now()}`;
  const parts = cleaned.split(/\s+/);
  const head = parts[0].toLowerCase();
  const tail = parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
  return [head, ...tail].join("").slice(0, 60) || `field_${Date.now()}`;
}

export default function overviewFieldsRouter(app: Express): void {
  // ── List ───────────────────────────────────────────────────────────────────
  app.get(
    "/api/dashboard/overview-fields",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      await ensureFieldsSeeded();
      const fields = await listFieldsFromDb();
      res.json({ fields });
    }),
  );

  // ── Reorder (registered BEFORE "/:id" so the literal path wins) ─────────────
  app.patch(
    "/api/dashboard/overview-fields/reorder",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const actor = (req as any).dashboardUser ?? "dashboard";
      const orderedIds: unknown = req.body?.orderedIds;
      if (!Array.isArray(orderedIds) || orderedIds.some((x) => typeof x !== "string")) {
        return res.status(400).json({ error: "orderedIds (string[]) is required" });
      }
      await ensureFieldsSeeded();
      const fields = await reorderFields(orderedIds as string[], actor);
      log(`[fields] ${actor} reordered ${orderedIds.length} overview fields`);
      res.json({ fields });
    }),
  );

  // ── Create ──────────────────────────────────────────────────────────────────
  app.post(
    "/api/dashboard/overview-fields",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const actor = (req as any).dashboardUser ?? "dashboard";
      const b = req.body ?? {};
      const label = String(b.label || "").trim();
      if (!label) return res.status(400).json({ error: "label is required" });

      await ensureFieldsSeeded();
      const existingFields = await listFieldsFromDb();
      const existingIds = new Set(existingFields.map((f) => f.id));

      let id = String(b.id || "").trim() || slugifyFieldId(label);
      if (existingIds.has(id)) {
        let n = 2;
        while (existingIds.has(`${id}_${n}`)) n++;
        id = `${id}_${n}`;
      }

      const payload: Partial<FieldDef> & { id: string } = {
        id,
        label,
        section: typeof b.section === "string" ? (b.section as FieldDef["section"]) : "custom",
        valueType: typeof b.valueType === "string" ? (b.valueType as FieldDef["valueType"]) : "string",
        scope: b.scope === "root" ? "root" : "consultation",
        options: Array.isArray(b.options) ? b.options.map((o: unknown) => String(o)) : undefined,
        placeholder: typeof b.placeholder === "string" ? b.placeholder : undefined,
        subLabels:
          b.subLabels && typeof b.subLabels === "object" && !Array.isArray(b.subLabels)
            ? (b.subLabels as Record<string, string>)
            : undefined,
        required: b.required === true,
        showWhenEmpty: b.showWhenEmpty === false ? false : true,
        readOnly: b.readOnly === true,
        clientVisible: b.clientVisible === true,
        clientEditable: b.clientEditable === true,
        active: b.active === false ? false : true,
        serviceGroup: validServiceGroup(b.serviceGroup),
      };

      const created = await upsertField(payload, actor);

      const insertAfterId = typeof b.insertAfterId === "string" ? b.insertAfterId : "";
      if (insertAfterId && existingIds.has(insertAfterId)) {
        const ordered = (await listFieldsFromDb())
          .sort((a, b2) => a.order - b2.order)
          .map((f) => f.id)
          .filter((fid) => fid !== created.id);
        const at = ordered.indexOf(insertAfterId);
        if (at >= 0) ordered.splice(at + 1, 0, created.id);
        else ordered.push(created.id);
        await reorderFields(ordered, actor);
      }

      const fields = await listFieldsFromDb();
      log(`[fields] ${actor} created overview field "${created.id}"`);
      res.json({ field: await getFieldFromDb(created.id), fields });
    }),
  );

  // ── Edit / rename / retype ───────────────────────────────────────────────────
  app.patch(
    "/api/dashboard/overview-fields/:id",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const actor = (req as any).dashboardUser ?? "dashboard";
      const { id } = req.params;
      await ensureFieldsSeeded();
      const existing = await getFieldFromDb(id);
      if (!existing) return res.status(404).json({ error: "field not found" });

      const b = req.body ?? {};
      const updates: Partial<FieldDef> & { id: string } = { id };
      if (typeof b.label === "string") updates.label = b.label;
      if (typeof b.section === "string") updates.section = b.section as FieldDef["section"];
      if (typeof b.valueType === "string") updates.valueType = b.valueType as FieldDef["valueType"];
      if (b.scope === "root" || b.scope === "consultation") updates.scope = b.scope;
      if (Array.isArray(b.options)) updates.options = b.options.map((o: unknown) => String(o));
      if (typeof b.placeholder === "string") updates.placeholder = b.placeholder;
      if (b.subLabels && typeof b.subLabels === "object" && !Array.isArray(b.subLabels)) {
        updates.subLabels = b.subLabels as Record<string, string>;
      }
      if (typeof b.required === "boolean") updates.required = b.required;
      if (typeof b.showWhenEmpty === "boolean") updates.showWhenEmpty = b.showWhenEmpty;
      if (typeof b.readOnly === "boolean") updates.readOnly = b.readOnly;
      if (typeof b.clientVisible === "boolean") updates.clientVisible = b.clientVisible;
      if (typeof b.clientEditable === "boolean") updates.clientEditable = b.clientEditable;
      if (typeof b.active === "boolean") updates.active = b.active;
      if (typeof b.serviceGroup === "string" || b.serviceGroup === undefined || b.serviceGroup === null) {
        updates.serviceGroup = validServiceGroup(b.serviceGroup);
      }

      const saved = await upsertField(updates, actor);
      log(`[fields] ${actor} edited overview field "${id}"`);
      res.json({ field: saved });
    }),
  );

  // ── Delete (non-destructive to client data — no migration guard needed) ──────
  app.delete(
    "/api/dashboard/overview-fields/:id",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const actor = (req as any).dashboardUser ?? "dashboard";
      const { id } = req.params;
      await ensureFieldsSeeded();
      const existing = await getFieldFromDb(id);
      if (!existing) return res.status(404).json({ error: "field not found" });

      await deleteFieldDoc(id);
      log(`[fields] ${actor} deleted overview field "${id}" (client data untouched)`);
      res.json({ ok: true, deleted: id });
    }),
  );
}