/**
 * API/dashboard/automation/fieldStore.ts
 * ──────────────────────────────────────────────────────────────────────────
 * DB access + idempotent seeding for the ILP "Overview Field Registry".
 *
 * Ported from IRP-funnel's `fieldStore.ts`, retargeted to ILP's legal fields.
 * Collections:
 *   • overview_fields                       — one doc per field (doc id === field.id)
 *   • configurations/overview_fields_seed   — sentinel so we seed exactly once
 *
 * Writes prime the in-memory cache (`fieldConfig.ts`) immediately.
 */

import get from "../../../db/get.ts";
import getAll, { type FirestoreDocument } from "../../../db/getAll.ts";
import put from "../../../db/put.ts";
import del from "../../../db/delete.ts";
import {
  HARDCODED_FIELD_DEFS,
  normalizeFieldDef,
  type FieldDef,
} from "./fieldDefaults.ts";
import {
  dropField,
  getFieldConfigSync,
  primeField,
  refreshFieldConfig,
} from "./fieldConfig.ts";

const FIELDS_COLLECTION = "overview_fields";
const SEED_SENTINEL = "overview_fields_seed";

export async function ensureFieldsSeeded(): Promise<void> {
  try {
    const sentinel = await get("configurations", SEED_SENTINEL).catch(() => null);
    const alreadySeeded = !!(sentinel && sentinel.seeded);

    const seededCount = Number(sentinel?.fieldCount) || 0;
    const needsReconcile = !alreadySeeded || seededCount < HARDCODED_FIELD_DEFS.length;

    let inserted = 0;
    if (needsReconcile) {
      for (const def of HARDCODED_FIELD_DEFS) {
        const existing = await get(FIELDS_COLLECTION, def.id).catch(() => null);
        if (existing && existing.id) continue;
        const now = new Date().toISOString();
        await put(FIELDS_COLLECTION, def.id, {
          ...def,
          createdAt: now,
          updatedAt: now,
        } as unknown as Record<string, unknown>);
        inserted++;
      }
    }

    if (!alreadySeeded || inserted > 0) {
      await put("configurations", SEED_SENTINEL, {
        seeded: true,
        seededAt: sentinel?.seededAt || new Date().toISOString(),
        reconciledAt: new Date().toISOString(),
        fieldCount: HARDCODED_FIELD_DEFS.length,
      });
      await refreshFieldConfig();
    }
  } catch {
    // Non-fatal — the getters keep serving hardcoded defaults until next attempt.
  }
}

export async function listFieldsFromDb(): Promise<FieldDef[]> {
  const rows: FirestoreDocument[] = await getAll(FIELDS_COLLECTION).catch(() => []);
  if (!Array.isArray(rows) || rows.length === 0) {
    return [...HARDCODED_FIELD_DEFS];
  }
  return rows
    .filter((r) => !!r?.id)
    .map((r, i) => normalizeFieldDef(r, i))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export async function getFieldFromDb(id: string): Promise<FieldDef | null> {
  const row = await get(FIELDS_COLLECTION, id).catch(() => null);
  if (row && row.id) return normalizeFieldDef(row);
  const hard = HARDCODED_FIELD_DEFS.find((f) => f.id === id);
  return hard ? { ...hard } : null;
}

export async function upsertField(
  payload: Partial<FieldDef> & { id: string },
  actor?: string,
): Promise<FieldDef> {
  const now = new Date().toISOString();
  const existing = await get(FIELDS_COLLECTION, payload.id).catch(() => null);
  const merged = normalizeFieldDef(
    { ...(existing || {}), ...payload },
    getFieldConfigSync().length,
  );
  const toSave: FieldDef = {
    ...merged,
    isSeed: false,
    updatedBy: actor || merged.updatedBy,
    updatedAt: now,
    createdAt: (existing?.createdAt as string | undefined) || merged.createdAt || now,
  };
  await put(FIELDS_COLLECTION, toSave.id, toSave as unknown as Record<string, unknown>);
  primeField(toSave);
  return toSave;
}

export async function deleteFieldDoc(id: string): Promise<void> {
  await del(FIELDS_COLLECTION, id);
  dropField(id);
}

export async function reorderFields(
  orderedIds: string[],
  actor?: string,
): Promise<FieldDef[]> {
  const now = new Date().toISOString();
  const current = await listFieldsFromDb();
  const byId = new Map(current.map((f) => [f.id, f]));

  let position = 0;
  for (const id of orderedIds) {
    const field = byId.get(id);
    if (!field) continue;
    if (field.order !== position) {
      const updated: FieldDef = {
        ...field,
        order: position,
        updatedBy: actor || field.updatedBy,
        updatedAt: now,
      };
      await put(FIELDS_COLLECTION, id, updated as unknown as Record<string, unknown>);
      primeField(updated);
      byId.set(id, updated);
    }
    position++;
  }
  return listFieldsFromDb();
}

// ── Self-warm ─────────────────────────────────────────────────────────────────
ensureFieldsSeeded();