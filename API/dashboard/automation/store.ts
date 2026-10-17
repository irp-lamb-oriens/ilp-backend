/**
 * API/dashboard/automation/store.ts
 * ──────────────────────────────────────────────────────────────────────────
 * DB access + idempotent seeding for the Stage Email Automation engine.
 *
 * Collections:
 *   • stage_email_rules  — one doc per rule (doc id === rule.id)
 *   • email_templates    — one doc per override (doc id === emailType)
 *   • configurations/automation_seed — sentinel so we seed exactly once
 *
 * A small in-memory cache of rules keeps the cron sweep cheap. It self-warms on
 * import and refreshes periodically; writes prime it immediately.
 */

import get from "../../../db/get.ts";
import getAll from "../../../db/getAll.ts";
import put from "../../../db/put.ts";
import del from "../../../db/delete.ts";
import { buildDefaultRules } from "./defaults.ts";
import type { EmailTemplateOverride, StageEmailRule } from "./types.ts";
import {
  dropTemplateOverride,
  primeTemplateOverride,
  refreshTemplateOverrides,
} from "./templateRender.ts";

const RULES_COLLECTION = "stage_email_rules";
const TEMPLATES_COLLECTION = "email_templates";
const SEED_SENTINEL = "automation_seed";

const RULE_CACHE = new Map<string, StageEmailRule>();
let rulesLoaded = false;
let lastRulesRefresh = 0;
const REFRESH_MS = 5 * 60 * 1000;

// ── Seeding ────────────────────────────────────────────────────────────────

/**
 * Seed the default (behavior-preserving) rule set exactly once. Guarded by a
 * sentinel doc so deleting rules later never re-seeds them.
 */
export async function ensureSeeded(): Promise<void> {
  try {
    const sentinel = await get("configurations", SEED_SENTINEL).catch(() => null);
    if (sentinel && (sentinel as any).seeded) return;

    const defaults = buildDefaultRules();
    for (const rule of defaults) {
      // Do not clobber an existing (possibly operator-edited) rule.
      const existing = await get(RULES_COLLECTION, rule.id).catch(() => null);
      if (existing && (existing as any).id) continue;
      await put(RULES_COLLECTION, rule.id, rule as unknown as Record<string, unknown>);
    }
    await put("configurations", SEED_SENTINEL, {
      seeded: true,
      seededAt: new Date().toISOString(),
      ruleCount: defaults.length,
    });
  } catch {
    // Non-fatal — the cron simply has fewer rules until the next attempt.
  }
}

// ── Rules cache ──────────────────────────────────────────────────────────────

export async function refreshRules(): Promise<void> {
  try {
    const rows: any[] = await getAll(RULES_COLLECTION).catch(() => []);
    RULE_CACHE.clear();
    for (const row of rows) {
      const id = row?.id;
      if (!id) continue;
      RULE_CACHE.set(id, row as StageEmailRule);
    }
    rulesLoaded = true;
    lastRulesRefresh = Date.now();
  } catch {
    // keep prior cache
  }
}

async function ensureRulesLoaded(): Promise<void> {
  if (!rulesLoaded || Date.now() - lastRulesRefresh >= REFRESH_MS) {
    await refreshRules();
  }
}

// ── Rules CRUD ───────────────────────────────────────────────────────────────

export async function listRules(): Promise<StageEmailRule[]> {
  await ensureRulesLoaded();
  return Array.from(RULE_CACHE.values()).sort((a, b) =>
    a.triggerStage.localeCompare(b.triggerStage) || a.emailType.localeCompare(b.emailType)
  );
}

/** All ENABLED rules whose triggerStage matches `stage`. */
export async function getRulesForStage(stage: string): Promise<StageEmailRule[]> {
  await ensureRulesLoaded();
  return Array.from(RULE_CACHE.values()).filter(
    (r) => r.enabled !== false && r.triggerStage === stage,
  );
}

export async function upsertRule(rule: StageEmailRule): Promise<StageEmailRule> {
  const now = new Date().toISOString();
  const merged: StageEmailRule = {
    ...rule,
    id: rule.id || `${rule.triggerStage}__${rule.emailType}`,
    delayHours: rule.delayHours ?? 0,
    condition: rule.condition ?? "always",
    mode: rule.mode ?? "suggest",
    enabled: rule.enabled ?? true,
    label: rule.label ?? `${rule.triggerStage} → ${rule.emailType}`,
    updatedAt: now,
    createdAt: rule.createdAt || now,
  };
  await put(RULES_COLLECTION, merged.id, merged as unknown as Record<string, unknown>);
  RULE_CACHE.set(merged.id, merged);
  return merged;
}

export async function deleteRule(id: string): Promise<void> {
  await del(RULES_COLLECTION, id);
  RULE_CACHE.delete(id);
}

// ── Template overrides CRUD ─────────────────────────────────────────────────

export async function listTemplateOverridesFromDb(): Promise<EmailTemplateOverride[]> {
  const rows: any[] = await getAll(TEMPLATES_COLLECTION).catch(() => []);
  return rows
    .map((r) => ({ ...(r as EmailTemplateOverride), emailType: r?.emailType || r?.id }))
    .filter((r) => !!r.emailType);
}

export async function upsertTemplate(t: EmailTemplateOverride): Promise<EmailTemplateOverride> {
  const now = new Date().toISOString();
  const merged: EmailTemplateOverride = {
    ...t,
    emailType: t.emailType,
    subject: t.subject ?? "",
    bodyHtml: t.bodyHtml ?? "",
    label: t.label ?? t.emailType,
    category: t.category ?? "sales",
    enabled: t.enabled ?? true,
    isCustom: t.isCustom ?? false,
    updatedAt: now,
    createdAt: t.createdAt || now,
  };
  await put(TEMPLATES_COLLECTION, merged.emailType, merged as unknown as Record<string, unknown>);
  primeTemplateOverride(merged);
  return merged;
}

export async function deleteTemplate(emailType: string): Promise<void> {
  await del(TEMPLATES_COLLECTION, emailType);
  dropTemplateOverride(emailType);
  await refreshTemplateOverrides();
}

// ── Self-warm ────────────────────────────────────────────────────────────────
ensureSeeded().then(() => refreshRules());