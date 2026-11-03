/**
 * POST /api/providers/me writes only these fields (QA round 1, 2026-11-03).
 * Status, score, insurance, SLA, notes, commission and every other
 * staff-owned field stay out of a lawyer's reach.
 */
/** Fields a lawyer may write on their own provider record. */
export const PROVIDER_SELF_FIELDS = [
  "name",
  "country",
  "phone",
  "website",
  "contactPerson",
  "specialties",
  "legalAreas",
  "jurisdictions",
  "languages",
  "credentials",
  "bio",
] as const;

export function pickProviderProfile(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PROVIDER_SELF_FIELDS) if (body[k] !== undefined) out[k] = body[k];
  return out;
}
