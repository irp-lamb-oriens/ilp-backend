/**
 * quoteApprovers.ts — centralized admin-configurable list of QUOTE APPROVERS.
 *
 * Mirrors the contract-recipients pattern: a singleton doc in `dashboard_config`,
 * a seeded DEFAULT list, a single-flight warm cache, and load/save helpers.
 * Editing the doc in the admin changes who may approve quotes (and who receives
 * the "quote pending approval" email) without a redeploy.
 */

import get from "../../../db/get.ts";
import put from "../../../db/put.ts";
import log from "../../../helper/log.ts";

const COLLECTION = "dashboard_config";
const DOC_ID = "quote_approvers";
const REFRESH_MS = 5 * 60 * 1000;

/** Preserves the exact behavior when no doc exists yet. */
export const DEFAULT_QUOTE_APPROVERS: string[] = [
  "oriens@internationallegalpartner.com",
  "pablo@internationallegalpartner.com",
  "luisarmando@internationallegalpartner.com",
];

export interface QuoteApproversConfig {
  /** Lower-cased, de-duplicated approver email addresses. */
  approvers: string[];
  updatedAt?: string | null;
  updatedBy?: string | null;
}

function defaultConfig(): QuoteApproversConfig {
  return { approvers: [...DEFAULT_QUOTE_APPROVERS], updatedAt: null, updatedBy: null };
}

/** Coerce arbitrary stored/incoming data into a clean, de-duplicated config. */
function normalize(raw: unknown): QuoteApproversConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(o.approvers) ? o.approvers : [];
  const cleaned = Array.from(
    new Set(
      list
        .map((v) => (typeof v === "string" ? v.trim().toLowerCase() : ""))
        .filter((v) => v.includes("@")),
    ),
  );
  return {
    approvers: cleaned,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : null,
    updatedBy: typeof o.updatedBy === "string" ? o.updatedBy : null,
  };
}

// ── Cache ────────────────────────────────────────────────────────────────────

let CACHE: QuoteApproversConfig = defaultConfig();
let isWarm = false;
let lastRefresh = 0;
let inflight: Promise<void> | null = null;

/** Pull the singleton doc into the sync cache. Safe to call often; never throws. */
export async function refreshQuoteApprovers(): Promise<void> {
  try {
    const doc = await get(COLLECTION, DOC_ID).catch(() => null);
    CACHE = doc ? normalize(doc) : defaultConfig();
    isWarm = true;
    lastRefresh = Date.now();
  } catch {
    // Non-fatal — keep whatever we had (defaults still work).
  }
}

/** Async getter with single-flight memoization. */
export async function ensureQuoteApprovers(): Promise<QuoteApproversConfig> {
  const fresh = Date.now() - lastRefresh < REFRESH_MS;
  if (isWarm && fresh) return CACHE;
  if (!inflight) {
    inflight = refreshQuoteApprovers().finally(() => {
      inflight = null;
    });
  }
  await inflight;
  return CACHE;
}

/** Convenience: the async list of approver addresses (lower-cased). */
export async function loadQuoteApprovers(): Promise<string[]> {
  return (await ensureQuoteApprovers()).approvers;
}

/** True if `email` is an approver (case-insensitive). Async, cache-backed. */
export async function isQuoteApprover(email: string): Promise<boolean> {
  const target = String(email ?? "").trim().toLowerCase();
  if (!target) return false;
  const approvers = await loadQuoteApprovers();
  return approvers.includes(target);
}

/** Persist the config + prime the cache immediately. */
export async function saveQuoteApprovers(
  input: Partial<QuoteApproversConfig>,
  updatedBy?: string,
): Promise<QuoteApproversConfig> {
  const now = new Date().toISOString();
  const merged: QuoteApproversConfig = {
    ...normalize({ approvers: input.approvers ?? CACHE.approvers }),
    updatedAt: now,
    updatedBy: updatedBy ?? CACHE.updatedBy ?? null,
  };
  await put(COLLECTION, DOC_ID, merged as unknown as Record<string, unknown>);
  CACHE = merged;
  isWarm = true;
  lastRefresh = Date.now();
  log(`[quoteApprovers] config saved (${merged.approvers.length} approvers) by ${updatedBy ?? "unknown"}`);
  return merged;
}

// ── Self-warming: load once on import, then refresh periodically. ─────────────
refreshQuoteApprovers();
setInterval(() => {
  if (Date.now() - lastRefresh >= REFRESH_MS) refreshQuoteApprovers();
}, REFRESH_MS);