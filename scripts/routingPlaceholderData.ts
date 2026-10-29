/**
 * scripts/routingPlaceholderData.ts — ROUTING pieces of the placeholder seed.
 * ──────────────────────────────────────────────────────────────────────────
 * Pure helpers used by placeholderData.ts:
 *   - routingProfileFor: specialties, languages, regions, capacity, client
 *     types, licences (one unverified second licence), notary status (a Costa
 *     Rica lawyer-notary), email language and one paused lawyer;
 *   - reviewsAndRatings: `reviews` from the seeded post-call ratings and one
 *     `lawyer_ratings` summary per lawyer (so the staff list shows "No reviews
 *     yet", blended and averaged ratings side by side);
 *   - GAP_SPECIALTIES: two specialties no seed lawyer covers anywhere
 *     (disputes and banking areas). Two members get a new matter needing
 *     them, so the no-match path is on screen: an open routing gap, a staff
 *     notification, a "routing.no_match" task, one booked sales call and one
 *     "sales.call_unscheduled" task.
 */

import {
  COUNTRIES,
  type CountryCode,
  DEFAULT_SPECIALTIES,
  groupsOf,
  type LawyerReview,
  lawyerRating,
  ROUTING_RULES_VERSION,
  type RoutingDecision,
  SALES_CALL_LENGTH_MIN,
  SALES_TEAM_ID,
  starsTo100,
} from "../schemas/contracts.ts";
import { type LawyerForRouting, routeCandidates } from "../API/routing/router.ts";
import { PLACEHOLDER_PREFIX } from "../helper/placeholder.ts";

type Doc = Record<string, unknown>;

/** Seed areas (placeholderData AREAS) to the specialties a lawyer with that area takes. */
export const AREA_SPECIALTIES: Record<string, string[]> = {
  immigration: ["residency_visas", "residency_renewals", "permanent_residency", "digital_nomad", "social_security", "citizenship"],
  real_estate: ["property_purchase", "land_titles", "property_tax", "condominium", "rentals_leases", "maritime_zone", "bank_trust_restricted_zone"],
  corporate: ["company_formation", "annual_corporate_filings", "beneficial_ownership", "company_cleanup", "foundations"],
  tax: ["personal_income_tax", "rental_income_tax", "tax_residency", "special_tax_regimes"],
  vehicle: ["vehicle_import", "vehicle_registration", "driver_licence"],
  family_estate: ["wills", "probate", "powers_of_attorney", "marriage_divorce"],
  labor: ["domestic_staff", "business_employees"],
};

/** Deliberate coverage gaps: no seed lawyer covers these areas in any country. */
export const GAP_SPECIALTIES = [
  { specialtyId: "litigation", title: "Small claims case against a builder", question: "Our builder in {loc} left the job half done and kept the deposit. Can we take him to court?" },
  { specialtyId: "bank_accounts_kyc", title: "Bank asks for proof of funds", question: "The bank froze my new account and wants papers about where my pension comes from. What do I send?" },
] as const;

const REGIONS: Record<CountryCode, string[]> = {
  CR: ["Guanacaste", "San José", "Puntarenas"],
  PA: ["Panamá Oeste", "Chiriquí", "Panamá"],
  MX: ["Quintana Roo", "Jalisco", "Baja California Sur"],
  CO: ["Antioquia", "Bogotá", "Bolívar"],
  ES: ["Málaga", "Alicante", "Madrid"],
  PT: ["Algarve", "Lisboa", "Porto"],
};

/** The routing fields for seed lawyer i (deterministic). */
export function routingProfileFor(i: number, country: CountryCode, areas: readonly string[], city: string): Doc {
  const allowed = (id: string) => {
    const s = DEFAULT_SPECIALTIES.find((x) => x.id === id);
    return !!s && (!s.countries.length || s.countries.includes(country));
  };
  // Each lawyer takes most of their areas' specialties, leaving one out in turn (variety).
  const specialties = areas.flatMap((a) => (AREA_SPECIALTIES[a] ?? []).filter(allowed).filter((_, k, list) => list.length < 3 || k !== i % list.length));
  if (country === "CR" && i % 6 === 0) specialties.push("notarial_acts");
  const regions = [city.split(",").pop()!.trim(), REGIONS[country][i % 3]].filter((x, k, a) => x && a.indexOf(x) === k);
  const second: CountryCode | null = i % 5 === 3 ? (country === "CR" ? "PA" : country === "ES" ? "PT" : null) : null;
  return {
    specialties: [...new Set(specialties)],
    ...(i % 4 === 1 && specialties[0] ? { specialtyNotes: { [specialties[0]]: "Most of my files are for retirees from the US and Canada." } } : {}),
    languages: country === "PT" ? ["pt", "en", "es"] : i % 3 === 2 ? ["es", "en", "fr"] : ["es", "en"],
    languageLevels: country === "PT" ? { pt: "native", en: "fluent", es: "working" } : { es: "native", en: i % 2 ? "fluent" : "working" },
    emailLanguage: country === "PT" ? "pt" : i % 7 === 4 ? "en" : "es",
    regions,
    clientTypes: areas.includes("corporate") ? ["individuals", "companies", "foreign_investors"] : ["individuals", "families"],
    maxCallsPerWeek: [12, 8, 10, 6][i % 4],
    responseHours: [4, 24, 8, 48][i % 4],
    yearsInPractice: 6 + ((i * 7) % 19),
    feeRangeCents: { min: 30000 + (i % 3) * 10000, max: 250000 + (i % 4) * 50000 },
    conflicts: i % 6 === 1 ? ["Inversiones Pacífico Azul S.A."] : [],
    routingStatus: i === 7 ? "paused" : "active", // one lawyer takes no new members (on leave)
    licences: [
      { country, body: COUNTRIES[country].lawyerBody.name, number: `PH-${20000 + i * 37}`, verified: true, verifiedBy: "seed review", verifiedAt: "2026-01-15T15:00:00.000Z" },
      ...(second ? [{ country: second, body: COUNTRIES[second].lawyerBody.name, number: `PH-${30000 + i * 41}`, verified: false }] : []),
    ],
    jurisdictions: second ? [country, second] : [country],
    notary: country === "CR" && i % 6 === 0 ? { isNotary: true, countries: ["CR"], number: `PH-N${4000 + i}`, verified: true } : { isNotary: false, countries: [] },
  };
}

/** Reviews from seeded post-call ratings, and one rating summary per lawyer with a ph_ id. */
export function reviewsAndRatings(
  ratings: Array<{ c: Doc; score: number; comment?: string; at: string }>,
  lawyerIds: readonly string[],
  nowIso: string,
): { reviews: LawyerReview[]; summaries: Doc[] } {
  const reviews: LawyerReview[] = ratings
    .filter((r) => typeof r.c.providerId === "string" && r.c.providerId !== SALES_TEAM_ID)
    .map((r) => ({
      id: `${PLACEHOLDER_PREFIX}rev_${String(r.c.id).replace(PLACEHOLDER_PREFIX, "")}`,
      providerId: String(r.c.providerId),
      clientId: String(r.c.clientId),
      consultationId: String(r.c.id),
      stars: r.score as LawyerReview["stars"],
      score100: starsTo100(r.score),
      ...(r.comment ? { comment: r.comment } : {}),
      at: r.at,
      placeholder: true,
    }));
  const summaries = lawyerIds.filter((id) => id.startsWith(PLACEHOLDER_PREFIX)).map((id) => {
    const r = lawyerRating(reviews.filter((x) => x.providerId === id).map((x) => x.score100));
    return { id, providerId: id, ratingScore: r.score, reviewCount: r.reviewCount, ratingStatus: r.status, updatedAt: nowIso };
  });
  return { reviews, summaries };
}

/** A seed lawyer as the router sees it (for the stored "Why this lawyer" decisions). */
export function seedLawyerForRouting(p: Doc, i: number, rating: { ratingScore: number; reviewCount: number } | undefined, load: number, nowMs: number): LawyerForRouting {
  const specialties = (p.specialties as string[]) ?? [];
  const juris = (p.jurisdictions as CountryCode[]) ?? [];
  const licences = (p.licences as Array<{ country: CountryCode; verified: boolean }>) ?? [];
  return {
    providerId: String(p.id),
    name: String(p.name),
    bookable: true,
    routingStatus: (p.routingStatus as LawyerForRouting["routingStatus"]) ?? "active",
    countries: juris,
    verifiedCountries: juris.filter((c) => licences.find((l) => l.country === c)?.verified),
    specialties,
    areas: groupsOf(specialties, DEFAULT_SPECIALTIES),
    languages: (p.languages as string[]) ?? [],
    regions: (p.regions as string[]) ?? [],
    clientTypes: (p.clientTypes as LawyerForRouting["clientTypes"]) ?? [],
    conflicts: (p.conflicts as string[]) ?? [],
    maxCallsPerWeek: (p.maxCallsPerWeek as number) ?? null,
    callsThisWeek: load % 6,
    nextSlotAt: new Date(nowMs + (1 + (i % 4)) * 86_400_000).toISOString(),
    ratingScore: rating?.ratingScore ?? 100,
    reviewCount: rating?.reviewCount ?? 0,
    placeholder: true,
  };
}

/**
 * The decision stored on a seeded matter: the router's ranking over the seed
 * lawyers; when the seed assigned someone else, the decision reads as a staff
 * override by the member's CSM.
 */
export function seedDecision(
  req: { country: CountryCode; area: string | null; region: string | null; memberName: string; languages: string[] },
  lawyers: LawyerForRouting[],
  assigned: string | null,
  csm: string,
  atIso: string,
): RoutingDecision {
  const now = new Date(atIso);
  const r = routeCandidates({
    country: req.country,
    area: (req.area as RoutingDecision["request"]["area"]) ?? null,
    specialtyId: null,
    languages: req.languages,
    timezone: COUNTRIES[req.country].defaultTimeZone,
    urgencyDays: null,
    clientType: "individual",
    region: req.region,
    previousProviderId: null,
    counterparties: [],
    memberName: req.memberName,
    placeholder: true,
  }, lawyers, now, DEFAULT_SPECIALTIES);
  const top = r.ranked[0]?.providerId ?? null;
  const override = assigned && assigned !== top;
  return {
    rulesVersion: ROUTING_RULES_VERSION,
    at: atIso,
    trigger: override ? "override" : "activation",
    providerId: assigned ?? top,
    request: { country: req.country, area: (req.area as RoutingDecision["request"]["area"]) ?? null, specialtyId: null, languages: req.languages, timezone: COUNTRIES[req.country].defaultTimeZone, urgencyDays: null, clientType: "individual", region: req.region, previousProviderId: null },
    candidates: r.ranked.slice(0, 5),
    rejected: r.rejected.slice(0, 25),
    ...(r.noMatchReason ? { noMatchReason: r.noMatchReason } : {}),
    ...(override ? { overriddenBy: csm, overrideNote: "Assigned by the CSM (seed data)" } : {}),
  };
}

/** Seed data uses a reserved address for the sales inbox (the real one is DEFAULT_SALES_EMAIL / SALES_EMAILS). */
export const SEED_SALES_EMAIL = "sales.desk@example.com";

/** A booked sales call for a member waiting for a lawyer (kind "sales", never charged). */
export function salesCallDoc(id: string, clientId: string, matterId: string, startIso: string, meetUrl: string, createdIso: string, need: string, country: CountryCode): Doc {
  return {
    id,
    clientId,
    matterId,
    providerId: SALES_TEAM_ID,
    kind: "sales",
    salesEmail: SEED_SALES_EMAIL,
    scheduledAt: startIso,
    durationMin: SALES_CALL_LENGTH_MIN,
    status: "booked",
    question: `Short call with the ILP team while we arrange a lawyer (${COUNTRIES[country].name}, ${need}).`,
    bookedBy: "system",
    consent: { recording: "declined", at: createdIso, by: "system", where: "sales_call" },
    meetUrl,
    remindersSent: [],
    createdAt: createdIso,
  };
}
