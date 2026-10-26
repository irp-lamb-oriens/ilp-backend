/**
 * API/dashboard/stageConfigRouter.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Dashboard endpoints for the centralized pipeline STAGE CONFIGURATION
 * (Automations → Stage Configuration): list, create, rename/edit, reorder, and
 * DELETE-WITH-MIGRATION of stages, plus a standalone "migrate all clients in a
 * column to another column" action.
 *
 * Safety rule: a column that still has clients CANNOT be deleted until the
 * operator picks where those clients go. The DELETE endpoint enforces this with
 * a 409 unless a `migrateTo` target is supplied; when supplied it migrates
 * first, then deletes. All heavy lifting is delegated to the modular
 * `stageStore` functions.
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import { requireDashboardAuth } from "../../helper/auth/session.ts";
import { requireStaffRole } from "../../helper/auth/roles.ts";
import {
  countClientsInStage,
  deleteStageDoc,
  ensureStagesSeeded,
  getStage,
  listStagesFromDb,
  migrateClientsBetweenStages,
  reorderStages,
  upsertStage,
} from "./automation/stageStore.ts";
import { ensureStageConfig, getStageNeighbors } from "./automation/stageConfig.ts";
import type { StageDef } from "./automation/stageDefaults.ts";

/** Turn a free-text label into a safe, unique-ish stage id. */
function slugifyStageId(label: string): string {
  return String(label || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || `stage_${Date.now()}`;
}

/** Resolve a `migrateTo` token ("__previous__" | "__next__" | id) to a stage id. */
function resolveMigrateTarget(
  token: string | undefined,
  stageId: string,
): { target: string | null; reason?: string } {
  if (!token) return { target: null };
  if (token === "__previous__") {
    const { previousStageId } = getStageNeighbors(stageId);
    return previousStageId
      ? { target: previousStageId }
      : { target: null, reason: "no previous stage" };
  }
  if (token === "__next__") {
    const { nextStageId } = getStageNeighbors(stageId);
    return nextStageId ? { target: nextStageId } : { target: null, reason: "no next stage" };
  }
  return { target: token };
}

export default function stageConfigRouter(app: Express): void {
  // ── List ───────────────────────────────────────────────────────────────────
  app.get(
    "/api/dashboard/stage-config",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      await ensureStagesSeeded();
      const stages = await listStagesFromDb();
      res.json({ stages });
    }),
  );

  // ── Reorder (registered BEFORE "/:id" so the literal path wins) ─────────────
  app.patch(
    "/api/dashboard/stage-config/reorder",
    requireDashboardAuth,
    requireStaffRole("admin"),
    asyncHandler(async (req: Request, res: Response) => {
      const actor = (req as any).dashboardUser ?? "dashboard";
      const orderedIds: unknown = req.body?.orderedIds;
      if (!Array.isArray(orderedIds) || orderedIds.some((x) => typeof x !== "string")) {
        return res.status(400).json({ error: "orderedIds (string[]) is required" });
      }
      await ensureStagesSeeded();
      const stages = await reorderStages(orderedIds as string[], actor);
      log(`[stages] ${actor} reordered ${orderedIds.length} stages`);
      res.json({ stages });
    }),
  );

  // ── Create ──────────────────────────────────────────────────────────────────
  app.post(
    "/api/dashboard/stage-config",
    requireDashboardAuth,
    requireStaffRole("admin"),
    asyncHandler(async (req: Request, res: Response) => {
      const actor = (req as any).dashboardUser ?? "dashboard";
      const b = req.body ?? {};
      const label = String(b.label || "").trim();
      if (!label) return res.status(400).json({ error: "label is required" });

      await ensureStagesSeeded();
      const existingStages = await listStagesFromDb();
      const existingIds = new Set(existingStages.map((s) => s.id));

      let id = String(b.id || "").trim() || slugifyStageId(label);
      if (existingIds.has(id)) {
        let n = 2;
        while (existingIds.has(`${id}_${n}`)) n++;
        id = `${id}_${n}`;
      }

      const payload: Partial<StageDef> & { id: string } = {
        id,
        label,
        description: typeof b.description === "string" ? b.description : "",
        icon: typeof b.icon === "string" && b.icon ? b.icon : "📌",
        color: typeof b.color === "string" && b.color ? b.color : "#64748b",
        slaDays:
          b.slaDays === null || b.slaDays === undefined || b.slaDays === ""
            ? null
            : Number(b.slaDays),
        phase: b.phase,
        notifyGroup: b.notifyGroup,
        hiddenFromClient: b.hiddenFromClient === true,
        clientLabel: typeof b.clientLabel === "string" ? b.clientLabel : undefined,
        active: b.active === false ? false : true,
      };

      const created = await upsertStage(payload, actor);

      const insertAfterId = typeof b.insertAfterId === "string" ? b.insertAfterId : "";
      if (insertAfterId && existingIds.has(insertAfterId)) {
        const ordered = (await listStagesFromDb())
          .sort((a, b2) => a.order - b2.order)
          .map((s) => s.id)
          .filter((sid) => sid !== created.id);
        const at = ordered.indexOf(insertAfterId);
        if (at >= 0) ordered.splice(at + 1, 0, created.id);
        else ordered.push(created.id);
        await reorderStages(ordered, actor);
      }

      const stages = await listStagesFromDb();
      log(`[stages] ${actor} created stage "${created.id}"`);
      res.json({ stage: await getStage(created.id), stages });
    }),
  );

  // ── Edit / rename ────────────────────────────────────────────────────────────
  app.patch(
    "/api/dashboard/stage-config/:id",
    requireDashboardAuth,
    requireStaffRole("admin"),
    asyncHandler(async (req: Request, res: Response) => {
      const actor = (req as any).dashboardUser ?? "dashboard";
      const { id } = req.params;
      await ensureStagesSeeded();
      const existing = await getStage(id);
      if (!existing) return res.status(404).json({ error: "stage not found" });

      const b = req.body ?? {};
      const updates: Partial<StageDef> & { id: string } = { id };
      if (typeof b.label === "string") updates.label = b.label;
      if (typeof b.description === "string") updates.description = b.description;
      if (typeof b.icon === "string") updates.icon = b.icon;
      if (typeof b.color === "string") updates.color = b.color;
      if (b.slaDays === null || b.slaDays === "") updates.slaDays = null;
      else if (b.slaDays !== undefined) updates.slaDays = Number(b.slaDays);
      if (typeof b.phase === "string") updates.phase = b.phase as StageDef["phase"];
      if (typeof b.notifyGroup === "string") updates.notifyGroup = b.notifyGroup as StageDef["notifyGroup"];
      if (typeof b.hiddenFromClient === "boolean") updates.hiddenFromClient = b.hiddenFromClient;
      if (typeof b.clientLabel === "string") updates.clientLabel = b.clientLabel;
      if (typeof b.active === "boolean") updates.active = b.active;

      const saved = await upsertStage(updates, actor);
      log(`[stages] ${actor} edited stage "${id}"`);
      res.json({ stage: saved });
    }),
  );

  // ── Count clients in a stage (drives the delete + migrate modals) ───────────
  app.get(
    "/api/dashboard/stage-config/:id/clients/count",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      await ensureStageConfig();
      const count = await countClientsInStage(id);
      const { previousStageId, nextStageId } = getStageNeighbors(id);
      res.json({ stageId: id, count, previousStageId, nextStageId });
    }),
  );

  // ── Bulk-migrate ALL clients in a column to another column ───────────────────
  app.post(
    "/api/dashboard/stage-config/:id/migrate-clients",
    requireDashboardAuth,
    requireStaffRole("admin"),
    asyncHandler(async (req: Request, res: Response) => {
      const actor = (req as any).dashboardUser ?? "dashboard";
      const { id } = req.params;
      await ensureStageConfig();

      const { target, reason } = resolveMigrateTarget(
        typeof req.body?.toStage === "string" ? req.body.toStage : undefined,
        id,
      );
      if (!target) {
        return res.status(400).json({ error: `Invalid migration target${reason ? ` (${reason})` : ""}.` });
      }
      const targetStage = await getStage(target);
      if (!targetStage) return res.status(400).json({ error: "Target stage does not exist." });
      if (target === id) return res.status(400).json({ error: "Cannot migrate a stage into itself." });

      const result = await migrateClientsBetweenStages(id, target, actor);
      res.json({ ok: true, ...result });
    }),
  );

  // ── Delete WITH migration guard ──────────────────────────────────────────────
  app.delete(
    "/api/dashboard/stage-config/:id",
    requireDashboardAuth,
    requireStaffRole("admin"),
    asyncHandler(async (req: Request, res: Response) => {
      const actor = (req as any).dashboardUser ?? "dashboard";
      const { id } = req.params;
      await ensureStagesSeeded();

      const stage = await getStage(id);
      if (!stage) return res.status(404).json({ error: "stage not found" });

      const migrateToken =
        (typeof req.query?.migrateTo === "string" && req.query.migrateTo) ||
        (typeof req.body?.migrateTo === "string" && req.body.migrateTo) ||
        undefined;

      const count = await countClientsInStage(id);
      const { previousStageId, nextStageId } = getStageNeighbors(id);

      if (count > 0 && !migrateToken) {
        return res.status(409).json({
          error:
            "This column still has clients. Choose where to move them before deleting " +
            "(previous stage, next stage, or a specific stage).",
          clientCount: count,
          previousStageId,
          nextStageId,
        });
      }

      let migration: Awaited<ReturnType<typeof migrateClientsBetweenStages>> | null = null;
      if (count > 0) {
        const { target, reason } = resolveMigrateTarget(migrateToken, id);
        if (!target) {
          return res
            .status(400)
            .json({ error: `Invalid migration target${reason ? ` (${reason})` : ""}.`, clientCount: count });
        }
        if (target === id) {
          return res.status(400).json({ error: "Cannot migrate a stage into itself." });
        }
        const targetStage = await getStage(target);
        if (!targetStage) {
          return res.status(400).json({ error: "Target stage does not exist.", clientCount: count });
        }
        migration = await migrateClientsBetweenStages(id, target, actor);
        if (migration.failed > 0) {
          return res.status(500).json({
            error: `Migration incomplete: ${migration.failed} of ${migration.total} clients could not be moved. Stage was NOT deleted.`,
            migration,
          });
        }
      }

      await deleteStageDoc(id);
      log(`[stages] ${actor} deleted stage "${id}"${migration ? ` (migrated ${migration.migrated} → ${migration.toStage})` : ""}`);
      res.json({ ok: true, deleted: id, migration });
    }),
  );
}