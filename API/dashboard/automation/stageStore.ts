/**
 * API/dashboard/automation/stageStore.ts
 * ──────────────────────────────────────────────────────────────────────────
 * DB access + idempotent seeding for the ILP pipeline stage config.
 *
 * Ported from IRP-funnel's `stageStore.ts`, retargeted to ILP's legal
 * pipeline. Collections:
 *   • stage_config                      — one doc per stage (doc id === stage.id)
 *   • configurations/stage_config_seed  — sentinel so we seed exactly once
 *
 * Writes prime the in-memory cache (`stageConfig.ts`) immediately.
 */

import get from "../../../db/get.ts";
import getAll, { type FirestoreDocument } from "../../../db/getAll.ts";
import put from "../../../db/put.ts";
import del from "../../../db/delete.ts";
import query from "../../../db/query.ts";
import log from "../../../helper/log.ts";
import {
  HARDCODED_STAGE_DEFS,
  normalizeStageDef,
  type StageDef,
} from "./stageDefaults.ts";
import {
  dropStage,
  getStageConfigSync,
  primeStage,
  refreshStageConfig,
} from "./stageConfig.ts";

const STAGES_COLLECTION = "stage_config";
const SEED_SENTINEL = "stage_config_seed";

export async function ensureStagesSeeded(): Promise<void> {
  try {
    const sentinel = await get("configurations", SEED_SENTINEL).catch(() => null);
    if (sentinel && sentinel.seeded) return;

    for (const def of HARDCODED_STAGE_DEFS) {
      const existing = await get(STAGES_COLLECTION, def.id).catch(() => null);
      if (existing && existing.id) continue;
      const now = new Date().toISOString();
      await put(STAGES_COLLECTION, def.id, {
        ...def,
        createdAt: now,
        updatedAt: now,
      } as unknown as Record<string, unknown>);
    }
    await put("configurations", SEED_SENTINEL, {
      seeded: true,
      seededAt: new Date().toISOString(),
      stageCount: HARDCODED_STAGE_DEFS.length,
    });
    await refreshStageConfig();
  } catch {
    // Non-fatal — the getters keep serving hardcoded defaults until next attempt.
  }
}

export async function listStagesFromDb(): Promise<StageDef[]> {
  const rows: FirestoreDocument[] = await getAll(STAGES_COLLECTION).catch(() => []);
  if (!Array.isArray(rows) || rows.length === 0) {
    return [...HARDCODED_STAGE_DEFS];
  }
  return rows
    .filter((r) => !!r?.id)
    .map((r, i) => normalizeStageDef(r, i))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export async function getStage(id: string): Promise<StageDef | null> {
  const row = await get(STAGES_COLLECTION, id).catch(() => null);
  if (row && row.id) return normalizeStageDef(row);
  const hard = HARDCODED_STAGE_DEFS.find((s) => s.id === id);
  return hard ? { ...hard } : null;
}

export async function upsertStage(
  payload: Partial<StageDef> & { id: string },
  actor?: string,
): Promise<StageDef> {
  const now = new Date().toISOString();
  const existing = await get(STAGES_COLLECTION, payload.id).catch(() => null);
  const merged = normalizeStageDef(
    { ...(existing || {}), ...payload },
    getStageConfigSync().length,
  );
  const toSave: StageDef = {
    ...merged,
    isSeed: false,
    updatedBy: actor || merged.updatedBy,
    updatedAt: now,
    createdAt: (existing?.createdAt as string | undefined) || merged.createdAt || now,
  };
  await put(STAGES_COLLECTION, toSave.id, toSave as unknown as Record<string, unknown>);
  primeStage(toSave);
  return toSave;
}

export async function deleteStageDoc(id: string): Promise<void> {
  await del(STAGES_COLLECTION, id);
  dropStage(id);
}

export async function reorderStages(
  orderedIds: string[],
  actor?: string,
): Promise<StageDef[]> {
  const now = new Date().toISOString();
  const current = await listStagesFromDb();
  const byId = new Map(current.map((s) => [s.id, s]));

  let position = 0;
  for (const id of orderedIds) {
    const stage = byId.get(id);
    if (!stage) continue;
    if (stage.order !== position) {
      const updated: StageDef = {
        ...stage,
        order: position,
        updatedBy: actor || stage.updatedBy,
        updatedAt: now,
      };
      await put(STAGES_COLLECTION, id, updated as unknown as Record<string, unknown>);
      primeStage(updated);
      byId.set(id, updated);
    }
    position++;
  }
  return listStagesFromDb();
}

// ── Client counting + migration (reused by the delete-guard + scripts) ────────

const CLIENTS_COLLECTION = "clients";

/**
 * Count clients currently in `stageId` via a structured query on the flat
 * `clients` collection's `stage` field.
 */
export async function countClientsInStage(stageId: string): Promise<number> {
  try {
    const rows = await query(CLIENTS_COLLECTION, [
      { field: "stage", op: "EQUAL", value: stageId },
    ]).catch(() => []);
    return Array.isArray(rows) ? rows.length : 0;
  } catch (err) {
    log(`[stageStore] countClientsInStage(${stageId}) failed: ${(err as any)?.message ?? err}`);
    return 0;
  }
}

export interface MigrationResult {
  fromStage: string;
  toStage: string;
  migrated: number;
  failed: number;
  total: number;
}

/**
 * Move EVERY client in `fromStage` to `toStage` by patching the flat `clients`
 * collection's `stage` field, appending a `stage_change` activity entry per
 * client. Reusable by the delete-guard and the standalone "migrate all clients"
 * action.
 */
export async function migrateClientsBetweenStages(
  fromStage: string,
  toStage: string,
  actor = "system",
): Promise<MigrationResult> {
  const rows = await query(CLIENTS_COLLECTION, [
    { field: "stage", op: "EQUAL", value: fromStage },
  ]).catch(() => []);
  const ids = rows.map((r) => String(r.id)).filter(Boolean);

  let migrated = 0;
  let failed = 0;
  const nowIso = new Date().toISOString();

  for (const id of ids) {
    try {
      const doc = await get(CLIENTS_COLLECTION, id).catch(() => null);
      if (!doc) {
        failed++;
        continue;
      }
      await put(CLIENTS_COLLECTION, id, {
        stage: toStage,
        stageEnteredAt: nowIso,
        updatedAt: nowIso,
        activityLog: [
          ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
          {
            type: "stage_change",
            from: fromStage,
            to: toStage,
            actor,
            reason: `stage migration: ${fromStage} → ${toStage}`,
            timestamp: nowIso,
          },
        ],
      });
      migrated++;
    } catch {
      failed++;
    }
  }

  log(`[stageStore] migrated ${migrated}/${ids.length} clients ${fromStage} → ${toStage} (by ${actor})`);
  return { fromStage, toStage, migrated, failed, total: ids.length };
}

// ── Self-warm ─────────────────────────────────────────────────────────────────
ensureStagesSeeded();
