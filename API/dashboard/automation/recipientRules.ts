/**
 * API/dashboard/automation/recipientRules.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Dashboard-configurable per-email-type RECIPIENT EXCLUSIONS, ported from
 * IRP-funnel and retargeted to ILP's legal pipeline + `helper/team.ts`.
 *
 * Every outbound client email is, by default, CC'd to `TEAM_CC` and BCC'd to
 * every address in `TEAM_BCC`. An operator can EXCLUDE specific team addresses
 * from specific email types (e.g. the scoping intro should not copy pricing).
 * The exclusion is applied when the queue worker or the dashboard force-send
 * builds the CC/BCC lists. Missing rule ⇒ empty exclusion ⇒ full default copy.
 *
 * Mirrors the cache + CRUD + seed pattern of templateRender.ts / stageConfig.ts.
 */

import getAll from "../../../db/getAll.ts";
import get from "../../../db/get.ts";
import put from "../../../db/put.ts";
import del from "../../../db/delete.ts";
import log from "../../../helper/log.ts";
import {
  TEAM_CC,
  TEAM_BCC,
  PRICING_DESK_EMAIL,
  FINANCE_DESK_EMAIL,
  SALES_DESK_EMAIL,
} from "../../../helper/team.ts";

const COLLECTION = "email_recipient_rules";
const SEED_SENTINEL = "recipient_rules_seed";

/** One per-email-type exclusion rule. Doc id === `emailType`. */
export interface EmailRecipientRule {
  /** Doc id === email type key (e.g. "scoping_intro"). */
  emailType: string;
  /** Team addresses to REMOVE from the default CC/BCC for this type. */
  excludedRecipients: string[];
  /** True for rows created by the seeder (informational only). */
  isSeed?: boolean;
  updatedBy?: string;
  updatedAt?: string;
  createdAt?: string;
}

const CACHE = new Map<string, EmailRecipientRule>();
let lastRefresh = 0;
const REFRESH_MS = 5 * 60 * 1000;

/** The set of internal addresses that CAN be excluded. */
export function teamRecipientPool(): { email: string; label: string }[] {
  const emails = [...new Set([
    TEAM_CC,
    ...TEAM_BCC,
    PRICING_DESK_EMAIL,
    FINANCE_DESK_EMAIL,
    SALES_DESK_EMAIL,
  ])].filter((e) => e && e.includes("@"));
  // No collaborator label map in ILP; label falls back to the address (or a
  // friendly short name for the known desks).
  const LABELS: Record<string, string> = {
    [`pricing@internationallegalpartner.com`]: "Pricing desk",
    [`finance@internationallegalpartner.com`]: "Finance desk",
  };
  return emails.map((email) => ({
    email,
    label: LABELS[email.toLowerCase()] || email,
  }));
}

/**
 * Resolve the default CC (team copy) for an email type, minus any exclusions.
 */
export function resolveEmailCc(emailType: string): string[] {
  const excluded = new Set(getExcludedRecipients(emailType).map((e) => e.toLowerCase()));
  return [TEAM_CC].filter((e) => e && !excluded.has(e.toLowerCase()));
}

/**
 * Resolve the default BCC (team copy) for an email type, minus exclusions.
 */
export function resolveEmailBcc(emailType: string): string[] {
  const excluded = new Set(getExcludedRecipients(emailType).map((e) => e.toLowerCase()));
  return TEAM_BCC.filter((e) => e && !excluded.has(e.toLowerCase()));
}

// ── Seeding ──────────────────────────────────────────────────────────────────

function buildDefaultRules(nowIso: string): EmailRecipientRule[] {
  const seed = (emailType: string, excludedRecipients: string[]): EmailRecipientRule => ({
    emailType,
    excludedRecipients,
    isSeed: true,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  // Default: no exclusions — every legal email keeps full team copy. This keeps
  // the seed minimal and backward compatible; operators tune per type in the UI.
  return [
    seed("scoping_intro", []),
    seed("legal_review_update", []),
    seed("quote_ready", []),
    seed("quote_accepted_confirmation", []),
    seed("filing_started", []),
    seed("matter_closed", []),
    seed("filing_deadline_reminder", []),
  ];
}

/** Seed the default rule set exactly once (sentinel-guarded). */
export async function ensureSeeded(): Promise<void> {
  try {
    const sentinel = await get("configurations", SEED_SENTINEL).catch(() => null);
    if (sentinel && (sentinel as Record<string, unknown>).seeded) return;

    const defaults = buildDefaultRules(new Date().toISOString());
    for (const rule of defaults) {
      const existing = await get(COLLECTION, rule.emailType).catch(() => null);
      if (existing && (existing as Record<string, unknown>).emailType) continue;
      await put(COLLECTION, rule.emailType, rule as unknown as Record<string, unknown>);
    }
    await put("configurations", SEED_SENTINEL, {
      seeded: true,
      seededAt: new Date().toISOString(),
      ruleCount: defaults.length,
    });
    await refreshRecipientRules();
  } catch (err) {
    log(`[recipientRules] ensureSeeded non-fatal: ${err instanceof Error ? err.message : err}`);
  }
}

// ── Cache ────────────────────────────────────────────────────────────────────

export async function refreshRecipientRules(): Promise<void> {
  try {
    const rows = await getAll(COLLECTION).catch(() => []);
    CACHE.clear();
    for (const row of rows) {
      const emailType = String(row?.emailType || row?.id || "");
      if (!emailType) continue;
      CACHE.set(emailType, {
        emailType,
        excludedRecipients: Array.isArray((row as Record<string, unknown>).excludedRecipients)
          ? (row as Record<string, unknown>).excludedRecipients as string[]
          : [],
        isSeed: (row as Record<string, unknown>).isSeed as boolean | undefined,
        updatedBy: (row as Record<string, unknown>).updatedBy as string | undefined,
        updatedAt: (row as Record<string, unknown>).updatedAt as string | undefined,
        createdAt: (row as Record<string, unknown>).createdAt as string | undefined,
      });
    }
    lastRefresh = Date.now();
  } catch {
    // Non-fatal — keep whatever we had; default CC/BCC still applies.
  }
}

function primeRecipientRule(rule: EmailRecipientRule): void {
  CACHE.set(rule.emailType, rule);
}

function dropRecipientRule(emailType: string): void {
  CACHE.delete(emailType);
}

/** Synchronous lookup used by the send choke points. */
export function getExcludedRecipients(emailType: string): string[] {
  const rule = CACHE.get(emailType);
  return rule && Array.isArray(rule.excludedRecipients) ? rule.excludedRecipients : [];
}

// ── CRUD (dashboard) ──────────────────────────────────────────────────────────

export async function listRecipientRules(): Promise<EmailRecipientRule[]> {
  const rows = await getAll(COLLECTION).catch(() => []);
  return rows
    .map((r) => {
      const o = r as Record<string, unknown>;
      return {
        emailType: String(o?.emailType || o?.id || ""),
        excludedRecipients: Array.isArray(o?.excludedRecipients) ? o.excludedRecipients as string[] : [],
        isSeed: o?.isSeed as boolean | undefined,
        updatedBy: o?.updatedBy as string | undefined,
        updatedAt: o?.updatedAt as string | undefined,
        createdAt: o?.createdAt as string | undefined,
      };
    })
    .filter((r) => !!r.emailType);
}

export async function upsertRecipientRule(rule: EmailRecipientRule): Promise<EmailRecipientRule> {
  const now = new Date().toISOString();
  const pool = new Set(teamRecipientPool().map((r) => r.email.toLowerCase()));
  const cleaned = [...new Set((rule.excludedRecipients ?? []).map((e) => e.trim()))].filter(
    (e) => e && pool.has(e.toLowerCase()),
  );
  const existing = CACHE.get(rule.emailType);
  const merged: EmailRecipientRule = {
    emailType: rule.emailType,
    excludedRecipients: cleaned,
    isSeed: rule.isSeed ?? existing?.isSeed,
    updatedBy: rule.updatedBy,
    updatedAt: now,
    createdAt: existing?.createdAt || now,
  };
  await put(COLLECTION, merged.emailType, merged as unknown as Record<string, unknown>);
  primeRecipientRule(merged);
  return merged;
}

export async function deleteRecipientRule(emailType: string): Promise<void> {
  await del(COLLECTION, emailType);
  dropRecipientRule(emailType);
}

// ── Self-warm ─────────────────────────────────────────────────────────────────
ensureSeeded().then(() => refreshRecipientRules());
setInterval(() => {
  if (Date.now() - lastRefresh >= REFRESH_MS) refreshRecipientRules();
}, REFRESH_MS);