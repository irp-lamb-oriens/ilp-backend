/**
 * quoteTemplateMapRouter.ts — Editable jurisdiction → template mapping config.
 *
 * This is the "main configuration" panel in the dashboard Templates section.
 * It defines WHICH quote_templates/{templateId} document should be shown by
 * DEFAULT for a given matter configuration (jurisdiction + optional legal
 * area).
 *
 * It is consulted by the AI auto-selector (`/infer-template`) BEFORE the legacy
 * hardcoded `ruleMatchTemplate()` logic, and it powers the per-client template
 * selector inside the dashboard quoting step.
 *
 * Firestore: dashboard_config/quoteTemplateMap   (single config doc)
 *
 * Shape:
 *   {
 *     defaultTemplateId: string,                  // global fallback
 *     rules: Array<{
 *       id: string,                               // stable nanoid (rule key)
 *       label?: string | null,                    // human-readable label
 *       jurisdiction: string,                     // required match key
 *       legalArea?: string | null,                // optional narrowing
 *       templateId: string,                       // which template to show
 *       priority: number,                         // tie-break (lower = wins)
 *     }>,
 *     updatedAt: string | null,
 *     updatedBy: string | null,
 *   }
 *
 * Routes
 * ──────
 *   GET /api/dashboard/quote-template-map   read (returns a seeded default if absent)
 *   PUT /api/dashboard/quote-template-map   replace
 *
 * Backward compatibility: this is a BRAND-NEW config doc. When it's absent or
 * empty, `resolveTemplateFromMap()` returns null so every caller falls through
 * to the existing hardcoded rules + LLM + default. Nothing pre-existing is
 * touched, removed, or overwritten.
 */

import type { Express, Request, Response } from "express";
import { requireDashboardAuth } from "../../helper/auth/session.ts";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import log from "../../helper/log.ts";

const COLLECTION = "dashboard_config";
const DOC_ID = "quoteTemplateMap";
const DEFAULT_TEMPLATE_ID = "ilp-standard-proposal";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TemplateMapRule {
  id: string;
  label?: string | null;
  jurisdiction: string;
  legalArea?: string | null;
  templateId: string;
  priority: number;
}

export interface QuoteTemplateMap {
  defaultTemplateId: string;
  rules: TemplateMapRule[];
  updatedAt: string | null;
  updatedBy: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function nanoId(size = 10): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const arr = crypto.getRandomValues(new Uint8Array(size));
  return Array.from(arr).map((b) => chars[b % chars.length]).join("");
}

/** Lowercase + trim a possibly-undefined value to a clean comparison string. */
function norm(v: unknown): string {
  return typeof v === "string" ? v.toLowerCase().trim() : "";
}

/**
 * ISO-2 / ISO-3 country codes → canonical lowercase names. Consultation docs
 * frequently store the jurisdiction as a code (e.g. "PA", "CR", "MX") while the
 * mapping rules store full names, so we canonicalise BOTH sides before matching.
 * Only an EXACT whole-string code is translated (no substring matching), so this
 * never produces false positives.
 */
const COUNTRY_CODE_TO_NAME: Record<string, string> = {
  // ISO-2
  cr: "costa rica", pa: "panama", mx: "mexico", co: "colombia", ec: "ecuador",
  do: "dominican republic", gt: "guatemala", hn: "honduras", sv: "el salvador",
  ni: "nicaragua", bz: "belize", es: "spain", pt: "portugal", us: "united states",
  ca: "canada", br: "brazil", ar: "argentina", cl: "chile", pe: "peru", uy: "uruguay",
  // ISO-3
  cri: "costa rica", pan: "panama", mex: "mexico", col: "colombia", ecu: "ecuador",
  dom: "dominican republic", gtm: "guatemala", hnd: "honduras", slv: "el salvador",
  nic: "nicaragua", blz: "belize", esp: "spain", prt: "portugal", usa: "united states",
  can: "canada", bra: "brazil", arg: "argentina", chl: "chile", per: "peru", ury: "uruguay",
};

/** Normalise a country value to a comparable name, translating ISO codes. */
function canonCountry(v: unknown): string {
  const n = norm(v);
  return COUNTRY_CODE_TO_NAME[n] ?? n;
}

/** Normalize an arbitrary record into a clean TemplateMapRule (or null). */
function normalizeRule(r: unknown): TemplateMapRule | null {
  if (!r || typeof r !== "object") return null;
  const rec = r as Record<string, any>;
  const jurisdiction = typeof rec.jurisdiction === "string" ? rec.jurisdiction.trim() : "";
  const templateId = typeof rec.templateId === "string" ? rec.templateId.trim() : "";
  // A rule is only meaningful with both a jurisdiction and a target template.
  if (!jurisdiction || !templateId) return null;
  return {
    id: typeof rec.id === "string" && rec.id ? rec.id : nanoId(10),
    label: typeof rec.label === "string" && rec.label.trim() ? rec.label.trim() : null,
    jurisdiction,
    legalArea:
      typeof rec.legalArea === "string" && rec.legalArea.trim()
        ? rec.legalArea.trim()
        : null,
    templateId,
    priority: Number.isFinite(Number(rec.priority)) ? Number(rec.priority) : 100,
  };
}

/** Empty/default map — used when the config doc has never been saved. */
function emptyMap(): QuoteTemplateMap {
  return { defaultTemplateId: DEFAULT_TEMPLATE_ID, rules: [], updatedAt: null, updatedBy: null };
}

/**
 * Load the live mapping config from Firestore, falling back to an empty map.
 * Never throws — template resolution must keep working even if Firestore is down.
 */
export async function loadQuoteTemplateMap(): Promise<QuoteTemplateMap> {
  try {
    const doc = await get(COLLECTION, DOC_ID);
    if (doc && (Array.isArray(doc.rules) || typeof doc.defaultTemplateId === "string")) {
      return {
        defaultTemplateId:
          typeof doc.defaultTemplateId === "string" && doc.defaultTemplateId.trim()
            ? doc.defaultTemplateId.trim()
            : DEFAULT_TEMPLATE_ID,
        rules: Array.isArray(doc.rules)
          ? (doc.rules as unknown[]).map(normalizeRule).filter((r): r is TemplateMapRule => r !== null)
          : [],
        updatedAt: typeof doc.updatedAt === "string" ? doc.updatedAt : null,
        updatedBy: typeof doc.updatedBy === "string" ? doc.updatedBy : null,
      };
    }
  } catch {
    /* fall through to empty map */
  }
  return emptyMap();
}

/**
 * Deterministic, data-driven matcher: returns the most-specific rule that
 * matches the consultation's matter configuration, or null when nothing
 * matches (so callers fall through to the legacy rules / LLM / default).
 *
 * Specificity scoring:
 *   • jurisdiction match            → +1 (base, required)
 *   • + matching legal area         → +2
 * A rule that SPECIFIES a legal area that does NOT match is disqualified.
 * Ties (equal score) are broken by the lower `priority` number.
 */
export function resolveTemplateFromMap(
  consultation: Record<string, any>,
  map: QuoteTemplateMap | null | undefined,
): { templateId: string; ruleId: string | null } | null {
  if (!map || !Array.isArray(map.rules) || map.rules.length === 0) return null;

  // Canonicalise both sides so ISO codes ("PA", "CR", "MX") match full names.
  const jurisdiction = canonCountry(consultation?.jurisdiction);
  const legalArea = norm(consultation?.legalArea);

  if (!jurisdiction) return null;

  let best: { rule: TemplateMapRule; score: number } | null = null;

  for (const rule of map.rules) {
    const rc = canonCountry(rule.jurisdiction);
    if (!rc) continue;
    // Jurisdiction must match (fuzzy two-way includes so "Mexico" ≈ "México DF" etc.)
    if (!(rc.includes(jurisdiction) || jurisdiction.includes(rc))) continue;

    let score = 1;

    // Optional legal area — when the rule specifies one, it must match.
    if (rule.legalArea) {
      const rarea = norm(rule.legalArea);
      if (rarea && legalArea && (rarea.includes(legalArea) || legalArea.includes(rarea))) {
        score += 2;
      } else {
        continue; // rule demands a legal area that doesn't match → disqualify
      }
    }

    if (
      !best ||
      score > best.score ||
      (score === best.score && (rule.priority ?? 999) < (best.rule.priority ?? 999))
    ) {
      best = { rule, score };
    }
  }

  if (!best) return null;
  return { templateId: best.rule.templateId, ruleId: best.rule.id ?? null };
}

// ── Router ────────────────────────────────────────────────────────────────────

export default function quoteTemplateMapRouter(app: Express) {
  app.get(
    "/api/dashboard/quote-template-map",
    requireDashboardAuth,
    async (_req: Request, res: Response) => {
      try {
        const map = await loadQuoteTemplateMap();
        res.json({ map });
      } catch (err: any) {
        log(`[quoteTemplateMapRouter] get: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to load template map" });
      }
    },
  );

  app.put(
    "/api/dashboard/quote-template-map",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const actor = (req as any).dashboardUser ?? "unknown";
      const { defaultTemplateId, rules } = req.body ?? {};

      const normalized: QuoteTemplateMap = {
        defaultTemplateId:
          typeof defaultTemplateId === "string" && defaultTemplateId.trim()
            ? defaultTemplateId.trim()
            : DEFAULT_TEMPLATE_ID,
        rules: Array.isArray(rules)
          ? (rules as unknown[]).map(normalizeRule).filter((r): r is TemplateMapRule => r !== null)
          : [],
        updatedAt: new Date().toISOString(),
        updatedBy: actor,
      };

      try {
        await put(COLLECTION, DOC_ID, normalized as unknown as Record<string, unknown>);
        log(`[quoteTemplateMapRouter] Saved map (${normalized.rules.length} rule(s)) by ${actor}`);
        res.json({ success: true, map: normalized });
      } catch (err: any) {
        log(`[quoteTemplateMapRouter] put: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to save template map" });
      }
    },
  );
}