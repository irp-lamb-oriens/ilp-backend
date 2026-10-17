/**
 * API/dashboard/automation/templateRender.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Editable email-template OVERRIDES + a synchronous in-memory cache.
 *
 * Ported from IRP-funnel's `API/dashboard/automation/templateRender.ts`,
 * retargeted to ILP's `helper/emailTemplates.ts` hardcoded templates.
 *
 * Flow:
 *   • On module load — and every REFRESH_MS — we pull the `email_templates`
 *     collection into a Map. `getTemplateOverride` reads that Map synchronously.
 *   • After an operator edits a template, the router calls
 *     `refreshTemplateOverrides()` for instant effect.
 *   • When there is NO enabled override for a type, `getTemplateOverride`
 *     returns null and the caller falls back to the hardcoded template — fully
 *     backward compatible.
 *
 * Field-agnostic interpolation: `{{ any.dotted.path }}` in the subject/body is
 * replaced from the client data dict. Unknown paths render as empty string.
 */

import getAll, { type FirestoreDocument } from "../../../db/getAll.ts";
import type { EmailTemplateOverride } from "./types.ts";

const CACHE = new Map<string, EmailTemplateOverride>();
let lastRefresh = 0;
const REFRESH_MS = 5 * 60 * 1000;

/** Pull all template overrides into the sync cache. Safe to call often. */
export async function refreshTemplateOverrides(): Promise<void> {
  try {
    const rows: FirestoreDocument[] = await getAll("email_templates").catch(() => []);
    CACHE.clear();
    for (const row of rows) {
      const emailType = String(row?.emailType || row?.id || "");
      if (!emailType) continue;
      CACHE.set(emailType, { ...(row as unknown as EmailTemplateOverride), emailType });
    }
    lastRefresh = Date.now();
  } catch {
    // Non-fatal — keep whatever we had; hardcoded templates still work.
  }
}

/** Upsert one entry into the cache immediately (called after a write). */
export function primeTemplateOverride(override: EmailTemplateOverride): void {
  CACHE.set(override.emailType, override);
}

/** Remove one entry from the cache immediately (called after a delete). */
export function dropTemplateOverride(emailType: string): void {
  CACHE.delete(emailType);
}

/** All cached overrides (for the editor list). */
export function listTemplateOverrides(): EmailTemplateOverride[] {
  return Array.from(CACHE.values());
}

/**
 * Synchronous lookup. Returns the override ONLY when present AND enabled —
 * otherwise null (⇒ hardcoded fallback).
 */
export function getTemplateOverride(
  emailType: string,
): EmailTemplateOverride | null {
  const o = CACHE.get(emailType);
  if (!o || o.enabled === false) return null;
  return o;
}

/** Resolve a dotted path against the data dict. */
function resolvePath(data: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((acc, key) => {
      if (acc == null || typeof acc !== "object") return undefined;
      return (acc as Record<string, unknown>)[key];
    }, data);
}

/** Interpolate `{{ path }}` tokens. Unknown paths → empty string. */
export function interpolate(
  template: string,
  data: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (_m, path) => {
    const v = resolvePath(data, path);
    return v == null ? "" : String(v);
  });
}

/**
 * Render an override to final HTML. Interpolates the body against `data`.
 */
export function renderOverride(
  override: EmailTemplateOverride,
  data: Record<string, unknown>,
): string {
  return interpolate(override.bodyHtml || "", data);
}

// ── Self-warming: load once on import, then refresh periodically. ──────────
refreshTemplateOverrides();
setInterval(() => {
  if (Date.now() - lastRefresh >= REFRESH_MS) refreshTemplateOverrides();
}, REFRESH_MS);