/**
 * API/dashboard/automation/stageConfig.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Centralized, DB-backed stage config + a synchronous in-memory cache.
 *
 * Ported from IRP-funnel's `stageConfig.ts`, retargeted to ILP's legal
 * pipeline. Reading:
 *   • `getStageConfigSync()` — never blocks; warm DB cache or hardcoded defaults.
 *   • `ensureStageConfig()`  — async; single-flight refresh when cold.
 *
 * Writing (from stageStore.ts, after a DB write):
 *   • `primeStage(def)` / `dropStage(id)` update the cache instantly.
 */

import getAll, { type FirestoreDocument } from "../../../db/getAll.ts";
import {
  HARDCODED_STAGE_DEFS,
  normalizeStageDef,
  type StageDef,
} from "./stageDefaults.ts";

const STAGES_COLLECTION = "stage_config";
const REFRESH_MS = 5 * 60 * 1000;

const CACHE = new Map<string, StageDef>();
let isWarm = false;
let lastRefresh = 0;
let inflight: Promise<void> | null = null;

function orderedFromCache(): StageDef[] {
  return Array.from(CACHE.values()).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function haveCache(): boolean {
  return isWarm && CACHE.size > 0;
}

export async function refreshStageConfig(): Promise<void> {
  try {
    const rows: FirestoreDocument[] = await getAll(STAGES_COLLECTION).catch(() => []);
    if (Array.isArray(rows) && rows.length > 0) {
      CACHE.clear();
      let i = 0;
      for (const row of rows) {
        if (!row?.id) continue;
        CACHE.set(String(row.id), normalizeStageDef(row, i++));
      }
    }
    isWarm = true;
    lastRefresh = Date.now();
  } catch {
    // Non-fatal — keep whatever we had; hardcoded defaults still work.
  }
}

export async function ensureStageConfig(): Promise<StageDef[]> {
  if (haveCache()) return orderedFromCache();
  if (!inflight) {
    inflight = refreshStageConfig().finally(() => {
      inflight = null;
    });
  }
  await inflight;
  return getStageConfigSync();
}

export function getStageConfigSync(): StageDef[] {
  return haveCache() ? orderedFromCache() : HARDCODED_STAGE_DEFS;
}

export function primeStage(def: StageDef): void {
  CACHE.set(def.id, def);
  isWarm = true;
}

export function dropStage(id: string): void {
  CACHE.delete(id);
}

export function invalidateStageConfig(): void {
  isWarm = false;
  lastRefresh = 0;
}

/** Neighbor lookup for a stage id (previous/next in order). */
export function getStageNeighbors(stageId: string): {
  previousStageId: string | null;
  nextStageId: string | null;
} {
  const ordered = getStageConfigSync();
  const idx = ordered.findIndex((s) => s.id === stageId);
  if (idx < 0) return { previousStageId: null, nextStageId: null };
  return {
    previousStageId: idx > 0 ? ordered[idx - 1].id : null,
    nextStageId: idx < ordered.length - 1 ? ordered[idx + 1].id : null,
  };
}

/** Human label for a stage id (falls back to the id itself). */
export function getStageLabel(stageId: string): string {
  const stage = getStageConfigSync().find((s) => s.id === stageId);
  return stage?.label ?? stageId;
}

/** True when the stage id exists in the active config. */
export function isValidStage(stageId: string): boolean {
  return getStageConfigSync().some((s) => s.id === stageId);
}

/** True when a stage is part of the client-facing journey (not hidden). */
export function isClientVisibleStage(stageId: string): boolean {
  const stage = getStageConfigSync().find((s) => s.id === stageId);
  return !!stage && stage.active !== false && stage.hiddenFromClient !== true;
}

/** Ordered ids of every client-visible stage. */
export function getClientVisibleStageIds(): string[] {
  return getStageConfigSync()
    .filter((s) => s.active !== false && s.hiddenFromClient !== true)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((s) => s.id);
}

/** Ordered `{ id, label }` pairs for every client-visible stage. */
export function getClientVisibleStageLabels(): Array<{ id: string; label: string }> {
  return getStageConfigSync()
    .filter((s) => s.active !== false && s.hiddenFromClient !== true)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((s) => ({ id: s.id, label: s.clientLabel ?? s.label }));
}

/**
 * Map any stage to the stage the CLIENT should see as their current position.
 * If the real stage is already client-visible it is returned unchanged;
 * otherwise walk backwards to the nearest preceding visible stage.
 */
export function resolveClientDisplayStage(stageId: string): string {
  if (isClientVisibleStage(stageId)) return stageId;
  const ordered = getStageConfigSync().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const idx = ordered.findIndex((s) => s.id === stageId);
  if (idx >= 0) {
    for (let i = idx; i >= 0; i--) {
      if (isClientVisibleStage(ordered[i].id)) return ordered[i].id;
    }
  }
  const visible = getClientVisibleStageIds();
  return visible[0] ?? stageId;
}

// ── Self-warming ────────────────────────────────────────────────────────────
refreshStageConfig();
setInterval(() => {
  if (Date.now() - lastRefresh >= REFRESH_MS) refreshStageConfig();
}, REFRESH_MS);