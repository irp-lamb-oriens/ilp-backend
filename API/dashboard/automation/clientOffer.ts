/**
 * API/dashboard/automation/clientOffer.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Dashboard-configurable "Client Offer" popup shown once on the client
 * /status page after the client gains access (authenticates).
 *
 * This is a SINGLE GLOBAL config (not per-client) — one offer message the whole
 * client base sees. It is edited from the dashboard "Automations → Client
 * offer" tab and stored as ONE singleton document under `dashboard_config`.
 *
 * Reading:
 *   • `getClientOfferConfigSync()` — never blocks. Returns the warm cache, or
 *     the disabled default until the cache is warm.
 *   • `ensureClientOfferConfig()` — async; awaits a single shared refresh when
 *     cold, returning the freshest config.
 *
 * Writing (from the dashboard PUT endpoint):
 *   • `saveClientOfferConfig()` persists + primes the cache immediately.
 *
 * Backward compatible: with no saved doc the getters return `enabled:false`
 * (empty copy), so NOTHING is shown to clients until an operator turns it on.
 */

import get from "../../../db/get.ts";
import put from "../../../db/put.ts";
import log from "../../../helper/log.ts";

const COLLECTION = "dashboard_config";
const DOC_ID = "client_offer_popup";
const REFRESH_MS = 5 * 60 * 1000;

/** The single global offer-popup configuration. */
export interface ClientOfferConfig {
  /** Master switch — when false the popup never renders for clients. */
  enabled: boolean;
  /** Popup heading (plain text). */
  title: string;
  /** Popup body — rich HTML authored with the shared WYSIWYG editor. */
  bodyHtml: string;
  /** Call-to-action button label. Empty ⇒ no button rendered. */
  ctaLabel: string;
  /** Call-to-action button URL. Empty ⇒ no button rendered. */
  ctaUrl: string;
  updatedAt?: string | null;
  updatedBy?: string | null;
}

/** The disabled, empty default — served until an operator saves a real offer. */
function emptyConfig(): ClientOfferConfig {
  return {
    enabled: false,
    title: "",
    bodyHtml: "",
    ctaLabel: "",
    ctaUrl: "",
    updatedAt: null,
    updatedBy: null,
  };
}

/** Coerce an arbitrary stored/incoming object into a clean ClientOfferConfig. */
function normalize(raw: unknown): ClientOfferConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    enabled: o.enabled === true,
    title: str(o.title).slice(0, 200),
    bodyHtml: str(o.bodyHtml),
    ctaLabel: str(o.ctaLabel).slice(0, 120),
    ctaUrl: str(o.ctaUrl).slice(0, 2000),
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : null,
    updatedBy: typeof o.updatedBy === "string" ? o.updatedBy : null,
  };
}

// ── Cache ────────────────────────────────────────────────────────────────────

let CACHE: ClientOfferConfig = emptyConfig();
let isWarm = false;
let lastRefresh = 0;
let inflight: Promise<void> | null = null;

/** Pull the singleton doc into the sync cache. Safe to call often; never throws. */
export async function refreshClientOfferConfig(): Promise<void> {
  try {
    const doc = await get(COLLECTION, DOC_ID).catch(() => null);
    CACHE = doc ? normalize(doc) : emptyConfig();
    isWarm = true;
    lastRefresh = Date.now();
  } catch {
    // Non-fatal — keep whatever we had; disabled default still works.
  }
}

/**
 * Async getter with single-flight memoization: warm cache returns instantly,
 * otherwise concurrent cold callers share ONE database load.
 */
export async function ensureClientOfferConfig(): Promise<ClientOfferConfig> {
  const fresh = Date.now() - lastRefresh < REFRESH_MS;
  if (isWarm && fresh) return CACHE;
  if (!inflight) {
    inflight = refreshClientOfferConfig().finally(() => {
      inflight = null;
    });
  }
  await inflight;
  return CACHE;
}

/** Non-blocking read: warm cache when available, else the disabled default. */
export function getClientOfferConfigSync(): ClientOfferConfig {
  return CACHE;
}

/** Persist the config + prime the cache immediately. */
export async function saveClientOfferConfig(
  input: Partial<ClientOfferConfig>,
  updatedBy?: string,
): Promise<ClientOfferConfig> {
  const now = new Date().toISOString();
  const merged: ClientOfferConfig = {
    ...normalize({ ...CACHE, ...input }),
    updatedAt: now,
    updatedBy: updatedBy ?? CACHE.updatedBy ?? null,
  };
  await put(COLLECTION, DOC_ID, merged as unknown as Record<string, unknown>);
  CACHE = merged;
  isWarm = true;
  lastRefresh = Date.now();
  log(`[clientOffer] config saved (enabled=${merged.enabled}) by ${updatedBy ?? "unknown"}`);
  return merged;
}

// ── Self-warming: load once on import, then refresh periodically. ─────────────
refreshClientOfferConfig();
setInterval(() => {
  if (Date.now() - lastRefresh >= REFRESH_MS) refreshClientOfferConfig();
}, REFRESH_MS);