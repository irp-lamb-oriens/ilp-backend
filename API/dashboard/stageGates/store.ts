/**
 * API/dashboard/stageGates/store.ts
 * ──────────────────────────────────────────────────────────────────────────
 * DB access + a small in-memory cache for the Stage-Gate rule engine.
 *
 * Collection: `stage_gate_rules` — one doc per rule (doc id === rule.id).
 *
 * The engine ships with ZERO seeded rules (fully backward compatible: with no
 * rules configured, every stage move is allowed exactly as before). Operators
 * add gates from the Automations → Stages section.
 *
 * The cache self-warms on import and refreshes periodically; writes prime it
 * immediately so the stage-move gate check stays cheap (no per-move DB read of
 * the whole rule set).
 */

import getAll from "../../../db/getAll.ts";
import put from "../../../db/put.ts";
import del from "../../../db/delete.ts";
import type { StageGateRule } from "./types.ts";

const COLLECTION = "stage_gate_rules";
const REFRESH_MS = 5 * 60 * 1000;

const CACHE = new Map<string, StageGateRule>();
let loaded = false;
let lastRefresh = 0;

export async function refreshGateRules(): Promise<void> {
  try {
    const rows: any[] = await getAll(COLLECTION).catch(() => []);
    CACHE.clear();
    for (const row of rows) {
      if (!row?.id) continue;
      CACHE.set(String(row.id), row as StageGateRule);
    }
    loaded = true;
    lastRefresh = Date.now();
  } catch {
    // keep prior cache — never throw
  }
}

async function ensureLoaded(): Promise<void> {
  if (!loaded || Date.now() - lastRefresh >= REFRESH_MS) {
    await refreshGateRules();
  }
}

/** All rules (any stage), sorted by stage then label — for the editor. */
export async function listGateRules(): Promise<StageGateRule[]> {
  await ensureLoaded();
  return Array.from(CACHE.values()).sort(
    (a, b) => a.targetStage.localeCompare(b.targetStage) || a.label.localeCompare(b.label),
  );
}

/** Enabled rules guarding a specific target stage. */
export async function getEnabledRulesForStage(stage: string): Promise<StageGateRule[]> {
  await ensureLoaded();
  return Array.from(CACHE.values()).filter(
    (r) => r.enabled !== false && r.targetStage === stage,
  );
}

export async function upsertGateRule(rule: StageGateRule): Promise<StageGateRule> {
  const now = new Date().toISOString();
  const merged: StageGateRule = {
    ...rule,
    id: rule.id || `gate_${crypto.randomUUID().slice(0, 8)}`,
    logic: rule.logic === "any" ? "any" : "all",
    conditions: Array.isArray(rule.conditions) ? rule.conditions : [],
    message: rule.message ?? "",
    enabled: rule.enabled ?? true,
    label: rule.label ?? `Gate for ${rule.targetStage}`,
    updatedAt: now,
    createdAt: rule.createdAt || now,
  };
  await put(COLLECTION, merged.id, merged as unknown as Record<string, unknown>);
  CACHE.set(merged.id, merged);
  return merged;
}

export async function deleteGateRule(id: string): Promise<void> {
  await del(COLLECTION, id);
  CACHE.delete(id);
}

// ── Self-warm ────────────────────────────────────────────────────────────────
refreshGateRules();