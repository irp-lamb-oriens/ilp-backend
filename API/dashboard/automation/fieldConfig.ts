/**
 * API/dashboard/automation/fieldConfig.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Centralized, DB-backed "Overview Field Registry" + a synchronous in-memory
 * cache, mirroring `stageConfig.ts`.
 *
 * Ported from IRP-funnel's `fieldConfig.ts`, retargeted to ILP's legal fields.
 */

import getAll, { type FirestoreDocument } from "../../../db/getAll.ts";
import {
  HARDCODED_FIELD_DEFS,
  normalizeFieldDef,
  type FieldDef,
} from "./fieldDefaults.ts";

const FIELDS_COLLECTION = "overview_fields";
const REFRESH_MS = 5 * 60 * 1000;
const STALE_MS = 20 * 1000;

const CACHE = new Map<string, FieldDef>();
let isWarm = false;
let lastRefresh = 0;
let inflight: Promise<void> | null = null;

function orderedFromCache(): FieldDef[] {
  return Array.from(CACHE.values()).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function haveCache(): boolean {
  return isWarm && CACHE.size > 0;
}

export async function refreshFieldConfig(): Promise<void> {
  try {
    const rows: FirestoreDocument[] = await getAll(FIELDS_COLLECTION).catch(() => []);
    if (Array.isArray(rows) && rows.length > 0) {
      CACHE.clear();
      let i = 0;
      for (const row of rows) {
        if (!row?.id) continue;
        CACHE.set(String(row.id), normalizeFieldDef(row, i++));
      }
    }
    isWarm = true;
    lastRefresh = Date.now();
  } catch {
    // Non-fatal — keep whatever we had; hardcoded defaults still work.
  }
}

export async function ensureFieldConfig(): Promise<FieldDef[]> {
  const fresh = Date.now() - lastRefresh < STALE_MS;
  if (haveCache() && fresh) return orderedFromCache();
  if (!inflight) {
    inflight = refreshFieldConfig().finally(() => {
      inflight = null;
    });
  }
  await inflight;
  return getFieldConfigSync();
}

export function getFieldConfigSync(): FieldDef[] {
  return haveCache() ? orderedFromCache() : [...HARDCODED_FIELD_DEFS];
}

export function primeField(def: FieldDef): void {
  CACHE.set(def.id, def);
  isWarm = true;
}

export function dropField(id: string): void {
  CACHE.delete(id);
}

export function invalidateFieldConfig(): void {
  isWarm = false;
  lastRefresh = 0;
}

function byId(id: string): FieldDef | undefined {
  if (haveCache()) return CACHE.get(id);
  return HARDCODED_FIELD_DEFS.find((f) => f.id === id);
}

export function getFieldIds(): string[] {
  return getFieldConfigSync().map((f) => f.id);
}

export function getActiveFields(): FieldDef[] {
  return getFieldConfigSync().filter((f) => f.active !== false);
}

export function getField(id: string): FieldDef | undefined {
  return byId(id);
}

export function getExpectedImportFields(): FieldDef[] {
  return getActiveFields();
}

// ── Self-warming ────────────────────────────────────────────────────────────
refreshFieldConfig();
setInterval(() => {
  if (Date.now() - lastRefresh >= REFRESH_MS) refreshFieldConfig();
}, REFRESH_MS);