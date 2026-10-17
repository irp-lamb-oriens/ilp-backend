/**
 * contractRecipients.ts — centralized admin-configurable recipient list for the
 * engagement-contract PDF email sent when a client accepts a quote.
 *
 * Mirrors the quote-approvers pattern: a singleton doc in `dashboard_config`, a
 * seeded DEFAULT list, a single-flight warm cache, and load/save helpers.
 * Editing the doc in the admin changes the recipients of every future contract
 * email without a redeploy.
 */

import get from "../../../db/get.ts";
import put from "../../../db/put.ts";
import log from "../../../helper/log.ts";

const COLLECTION = "dashboard_config";
const DOC_ID = "contract_recipients";
const REFRESH_MS = 5 * 60 * 1000;

/** Preserves the exact behavior when no doc exists yet. */
export const DEFAULT_CONTRACT_RECIPIENTS: string[] = [
  "oriens@internationallegalpartner.com",
];

export interface ContractRecipientsConfig {
  /** Lower-cased, de-duplicated recipient email addresses. */
  recipients: string[];
  updatedAt?: string | null;
  updatedBy?: string | null;
}

function defaultConfig(): ContractRecipientsConfig {
  return { recipients: [...DEFAULT_CONTRACT_RECIPIENTS], updatedAt: null, updatedBy: null };
}

/** Coerce arbitrary stored/incoming data into a clean, de-duplicated config. */
function normalize(raw: unknown): ContractRecipientsConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(o.recipients) ? o.recipients : [];
  const cleaned = Array.from(
    new Set(
      list
        .map((v) => (typeof v === "string" ? v.trim().toLowerCase() : ""))
        .filter((v) => v.includes("@")),
    ),
  );
  return {
    recipients: cleaned,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : null,
    updatedBy: typeof o.updatedBy === "string" ? o.updatedBy : null,
  };
}

// ── Cache ────────────────────────────────────────────────────────────────────

let CACHE: ContractRecipientsConfig = defaultConfig();
let isWarm = false;
let lastRefresh = 0;
let inflight: Promise<void> | null = null;

/** Pull the singleton doc into the sync cache. Safe to call often; never throws. */
export async function refreshContractRecipients(): Promise<void> {
  try {
    const doc = await get(COLLECTION, DOC_ID).catch(() => null);
    // A saved-but-empty list is respected; a missing doc falls back to defaults.
    CACHE = doc ? normalize(doc) : defaultConfig();
    isWarm = true;
    lastRefresh = Date.now();
  } catch {
    // Non-fatal — keep whatever we had (defaults still work).
  }
}

/** Async getter with single-flight memoization. */
export async function ensureContractRecipients(): Promise<ContractRecipientsConfig> {
  const fresh = Date.now() - lastRefresh < REFRESH_MS;
  if (isWarm && fresh) return CACHE;
  if (!inflight) {
    inflight = refreshContractRecipients().finally(() => {
      inflight = null;
    });
  }
  await inflight;
  return CACHE;
}

/** Convenience: the async list of recipient addresses (lower-cased). */
export async function loadContractRecipients(): Promise<string[]> {
  return (await ensureContractRecipients()).recipients;
}

/** Persist the config + prime the cache immediately. */
export async function saveContractRecipients(
  input: Partial<ContractRecipientsConfig>,
  updatedBy?: string,
): Promise<ContractRecipientsConfig> {
  const now = new Date().toISOString();
  const merged: ContractRecipientsConfig = {
    ...normalize({ recipients: input.recipients ?? CACHE.recipients }),
    updatedAt: now,
    updatedBy: updatedBy ?? CACHE.updatedBy ?? null,
  };
  await put(COLLECTION, DOC_ID, merged as unknown as Record<string, unknown>);
  CACHE = merged;
  isWarm = true;
  lastRefresh = Date.now();
  log(`[contractRecipients] config saved (${merged.recipients.length} recipients) by ${updatedBy ?? "unknown"}`);
  return merged;
}

// ── Self-warming: load once on import, then refresh periodically. ─────────────
refreshContractRecipients();
setInterval(() => {
  if (Date.now() - lastRefresh >= REFRESH_MS) refreshContractRecipients();
}, REFRESH_MS);