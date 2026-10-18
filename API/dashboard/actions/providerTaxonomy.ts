/**
 * API/dashboard/actions/providerTaxonomy.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Pure mapping/filter functions between a client's legal taxonomy
 * (`legalArea` / `jurisdiction`) and the ILP provider registry
 * (`legalAreas` / `jurisdictions`). No I/O — safe to import anywhere.
 *
 * This is the ILP analog of IRP's shippingMode/packingTier → modality/category
 * mapping: it reduces a client to a set of match criteria and scores/filters
 * providers against those criteria.
 */

import type { Provider, LegalArea } from "../providersRouter.ts";

export interface ProviderMatchCriteria {
  /** Client's legalArea, normalized; null when absent. */
  legalArea: LegalArea | null;
  /** Client's jurisdiction, upper-cased; null when absent. */
  jurisdiction: string | null;
}

/** Extract match criteria from a client doc. */
export function inferProviderCriteria(
  clientDoc: Record<string, unknown> | null | undefined,
): ProviderMatchCriteria {
  const area = typeof clientDoc?.legalArea === "string"
    ? (clientDoc.legalArea.trim() as LegalArea)
    : null;
  const jurisdiction = typeof clientDoc?.jurisdiction === "string"
    ? clientDoc.jurisdiction.trim().toUpperCase()
    : null;
  return {
    legalArea: area || null,
    jurisdiction: jurisdiction || null,
  };
}

/** Does a provider cover a given jurisdiction tag (case-insensitive; empty = all)? */
export function providerCoversJurisdiction(
  jurisdictions: string[] | undefined | null,
  target: string | null,
): boolean {
  if (!target) return true;
  if (!Array.isArray(jurisdictions) || jurisdictions.length === 0) return true;
  const t = target.toUpperCase();
  return jurisdictions.some((j) => String(j).trim().toUpperCase() === t);
}

/** Does a provider cover a given legal area (empty = all)? */
export function providerCoversArea(
  legalAreas: LegalArea[] | undefined | null,
  target: LegalArea | null,
): boolean {
  if (!target) return true;
  if (!Array.isArray(legalAreas) || legalAreas.length === 0) return true;
  return legalAreas.includes(target);
}

export interface ScoredProvider extends Provider {
  _matchScore: number;
}

/**
 * Score providers against a client's criteria and sort descending. A provider
 * scores +2 for an exact legalArea match and +1 for a jurisdiction match; the
 * result mirrors GET /api/dashboard/providers/match/:clientId but is callable
 * from action handlers without hitting the HTTP layer.
 */
export function scoreProviders(
  providers: Provider[],
  criteria: ProviderMatchCriteria,
): ScoredProvider[] {
  return providers
    .filter((p) => p.active !== false)
    .map((p) => {
      let score = 0;
      if (providerCoversArea(p.legalAreas, criteria.legalArea)) score += 2;
      if (providerCoversJurisdiction(p.jurisdictions, criteria.jurisdiction)) score += 1;
      return { ...p, _matchScore: score } as ScoredProvider;
    })
    .sort((a, b) => b._matchScore - a._matchScore);
}

/** Filter strictly: area AND jurisdiction must match (null criterion = no filter). */
export function filterProviders(
  providers: Provider[],
  criteria: ProviderMatchCriteria,
): Provider[] {
  return providers.filter(
    (p) =>
      p.active !== false &&
      (criteria.legalArea === null || providerCoversArea(p.legalAreas, criteria.legalArea)) &&
      (criteria.jurisdiction === null ||
        providerCoversJurisdiction(p.jurisdictions, criteria.jurisdiction)),
  );
}