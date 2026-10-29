/**
 * API/routing/router.ts — the automatic client → lawyer router (ROUTING). Pure.
 * ──────────────────────────────────────────────────────────────────────────
 * No Firestore, no network: service.ts loads the lawyers, their availability,
 * load and hidden ratings, builds the request from the member and matter, and
 * calls `routeCandidates`. Tested in test/routing_test.ts.
 *
 * Hard filters (a lawyer failing one is never offered):
 *   1. active: approved by staff, switched on, not paused (paused lawyers keep
 *      their own members: continuity) and not still onboarding;
 *   2. licensed in the matter's country, with that licence verified (lawyers
 *      approved before licence records existed count as verified: the staff
 *      review checked the licence);
 *   3. covers the needed specialty, or its area when only the area is known;
 *   4. speaks one of the member's languages (a lawyer with no languages on
 *      file passes, with a warning for staff);
 *   5. has a free slot within ROUTING_SLOT_DAYS days;
 *   6. under their weekly call limit;
 *   7. no conflict (a counterparty or the member is on the lawyer's list).
 *
 * Ranking (RoutingScoreBreakdown): specialty fit (exact 40 > area 25, area-only
 * request 30), continuity with the member's previous lawyer 25, hidden rating
 * 0-15, earliest slot 0-10 (doubled when a due date is 14 days away or less),
 * load 0-10 (fewer calls this week), region 5, client type 3. Ties break on the
 * earlier slot, then fewer calls this week, then providerId, so the same input
 * always gives the same lawyer.
 */

import {
  AREA_GROUPS,
  type AreaGroupId,
  COUNTRIES,
  type CountryCode,
  type LawyerClientType,
  type LawyerRoutingStatus,
  ROUTING_SLOT_DAYS,
  type RoutingCandidate,
  type RoutingRejection,
  type RoutingRequestSummary,
  type RoutingScoreBreakdown,
  type Specialty,
  toAreaGroup,
} from "../../schemas/contracts.ts";

const DAY = 86_400_000;

/** Everything the router needs to know about one lawyer. */
export interface LawyerForRouting {
  providerId: string;
  name: string;
  bookable: boolean; // approved and switched on (isProviderBookable)
  routingStatus: LawyerRoutingStatus;
  countries: CountryCode[]; // licensed in
  verifiedCountries: CountryCode[]; // licence verified (or approved before licence records)
  specialties: string[]; // specialty ids
  areas: AreaGroupId[]; // groups covered (from specialties and the older legal areas)
  languages: string[]; // [] = not on file
  regions: string[];
  clientTypes: LawyerClientType[];
  conflicts: string[];
  maxCallsPerWeek: number | null;
  callsThisWeek: number;
  nextSlotAt: string | null; // first free slot
  ratingScore: number; // 0-100, hidden
  reviewCount: number;
  placeholder: boolean;
}

export interface RouteRequest extends RoutingRequestSummary {
  counterparties: string[];
  memberName?: string;
  placeholder: boolean;
}

export interface RouteResult {
  ranked: RoutingCandidate[];
  rejected: RoutingRejection[];
  noMatchReason?: string;
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** True when a and b name the same person, company or place (one contains the other, ≥ 3 letters). */
export function sameName(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (x.length < 3 || y.length < 3) return false;
  return x === y || x.includes(y) || y.includes(x);
}

const areaLabel = (a: AreaGroupId | null) => (a ? AREA_GROUPS.find((g) => g.id === a)?.label ?? a : "general questions");
const specialtyLabel = (id: string | null, list: readonly Specialty[]) => (id ? list.find((s) => s.id === id)?.label ?? id.replace(/_/g, " ") : null);
const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const LANG_NAMES: Record<string, string> = { en: "English", es: "Spanish", pt: "Portuguese", fr: "French", de: "German", it: "Italian" };
const langName = (c: string) => LANG_NAMES[c] ?? c;

/** Why this lawyer can never take this request (empty = passes every hard filter). */
export function hardFilterReasons(l: LawyerForRouting, r: RouteRequest, now: Date, specialties: readonly Specialty[], slotDays = ROUTING_SLOT_DAYS): string[] {
  const out: string[] = [];
  const country = COUNTRIES[r.country]?.name ?? r.country;
  const isPrevious = !!r.previousProviderId && r.previousProviderId === l.providerId;
  if (!l.bookable) out.push("Not active: application in review, declined or switched off");
  else if (l.routingStatus === "onboarding") out.push("Still onboarding: not routed yet");
  else if (l.routingStatus === "paused" && !isPrevious) out.push("Paused: takes no new members");
  if (!l.countries.includes(r.country)) out.push(`Not licensed in ${country}`);
  else if (!l.verifiedCountries.includes(r.country)) out.push(`Licence in ${country} not verified yet`);
  if (r.specialtyId) {
    if (!l.specialties.includes(r.specialtyId) && !(r.area && l.areas.includes(r.area))) {
      out.push(`Does not cover ${specialtyLabel(r.specialtyId, specialties)} or ${areaLabel(r.area).toLowerCase()}`);
    }
  } else if (r.area && !l.areas.includes(r.area)) {
    out.push(`Does not cover ${areaLabel(r.area).toLowerCase()}`);
  }
  if (l.languages.length && r.languages.length && !r.languages.some((x) => l.languages.includes(x))) {
    out.push(`Does not speak ${r.languages.map(langName).join(" or ")}`);
  }
  const horizon = now.getTime() + slotDays * DAY;
  if (!l.nextSlotAt || Date.parse(l.nextSlotAt) > horizon) out.push(`No free time in the next ${slotDays} days`);
  if (l.maxCallsPerWeek != null && l.callsThisWeek >= l.maxCallsPerWeek) {
    out.push(`At capacity: ${l.callsThisWeek} of ${l.maxCallsPerWeek} calls this week`);
  }
  const names = [...r.counterparties, ...(r.memberName ? [r.memberName] : [])];
  const hit = l.conflicts.find((c) => names.some((n) => sameName(c, n)));
  if (hit) out.push(`Conflict on file: ${hit}`);
  return out;
}

/** Score one lawyer that passed the hard filters. */
export function scoreLawyer(l: LawyerForRouting, r: RouteRequest, now: Date, specialties: readonly Specialty[], slotDays = ROUTING_SLOT_DAYS): RoutingCandidate {
  const reasons: string[] = [];
  const b: RoutingScoreBreakdown = { specialty: 0, continuity: 0, rating: 0, earliestSlot: 0, load: 0, region: 0, clientType: 0 };
  if (r.specialtyId && l.specialties.includes(r.specialtyId)) {
    b.specialty = 40;
    reasons.push(`Takes ${specialtyLabel(r.specialtyId, specialties)} (exact specialty)`);
  } else if (r.specialtyId) {
    b.specialty = 25;
    reasons.push(`Covers ${areaLabel(r.area).toLowerCase()} (same area, not the exact specialty)`);
  } else if (r.area) {
    b.specialty = 30;
    reasons.push(`Covers ${areaLabel(r.area).toLowerCase()}`);
  } else {
    b.specialty = 10;
    reasons.push("General question: any active lawyer in the country fits");
  }
  if (r.previousProviderId === l.providerId) {
    b.continuity = 25;
    reasons.push("The member's current lawyer (continuity)");
  }
  b.rating = Math.round((Math.max(0, Math.min(100, l.ratingScore)) / 100) * 15 * 10) / 10;
  reasons.push(l.reviewCount ? `Rating ${l.ratingScore} from ${l.reviewCount} review${l.reviewCount === 1 ? "" : "s"}` : "No reviews yet (starts at 100)");
  if (l.nextSlotAt) {
    const days = Math.max(0, (Date.parse(l.nextSlotAt) - now.getTime()) / DAY);
    const urgent = r.urgencyDays != null && r.urgencyDays <= 14;
    b.earliestSlot = Math.round(10 * (1 - Math.min(days, slotDays) / slotDays) * (urgent ? 2 : 1) * 10) / 10;
    reasons.push(`First free time ${dayLabel(l.nextSlotAt)}${urgent ? " (a due date is close, so earlier times count double)" : ""}`);
  }
  const cap = l.maxCallsPerWeek ?? 10;
  b.load = Math.round(10 * (1 - Math.min(l.callsThisWeek / Math.max(1, cap), 1)) * 10) / 10;
  reasons.push(`${l.callsThisWeek} call${l.callsThisWeek === 1 ? "" : "s"} this week${l.maxCallsPerWeek != null ? ` of ${l.maxCallsPerWeek}` : ""}`);
  if (r.region && l.regions.some((x) => sameName(x, r.region!))) {
    b.region = 5;
    reasons.push(`Works in ${r.region}`);
  }
  const wantType: LawyerClientType = r.clientType === "company" ? "companies" : "individuals";
  if (l.clientTypes.includes(wantType)) b.clientType = 3;
  if (!l.languages.length) reasons.push("Languages not on file: check before the call");
  else {
    const shared = r.languages.filter((x) => l.languages.includes(x));
    if (shared.length) reasons.push(`Speaks ${shared.map(langName).join(" and ")}`);
  }
  const score = Math.round((b.specialty + b.continuity + b.rating + b.earliestSlot + b.load + b.region + b.clientType) * 10) / 10;
  return {
    providerId: l.providerId,
    name: l.name,
    score,
    breakdown: b,
    reasons,
    nextSlotAt: l.nextSlotAt,
    ratingScore: l.ratingScore,
    reviewCount: l.reviewCount,
    callsThisWeek: l.callsThisWeek,
  };
}

/** Deterministic order: score, earlier slot, fewer calls this week, providerId. */
export function compareCandidates(a: RoutingCandidate, b: RoutingCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const sa = a.nextSlotAt ? Date.parse(a.nextSlotAt) : Infinity;
  const sb = b.nextSlotAt ? Date.parse(b.nextSlotAt) : Infinity;
  if (sa !== sb) return sa - sb;
  if (a.callsThisWeek !== b.callsThisWeek) return a.callsThisWeek - b.callsThisWeek;
  return a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0;
}

/** Plain reason staff read when nobody passes. */
export function noMatchReason(r: RouteRequest, rejected: RoutingRejection[], specialties: readonly Specialty[]): string {
  const country = COUNTRIES[r.country]?.name ?? r.country;
  const need = specialtyLabel(r.specialtyId, specialties) ?? areaLabel(r.area);
  const has = (re: RegExp) => (x: RoutingRejection) => x.reasons.some((y) => re.test(y));
  const licensed = rejected.filter((x) => !x.reasons.some((y) => /^Not active|^Not licensed/.test(y)));
  if (!licensed.length) return `No active lawyer is licensed in ${country} yet.`;
  const covering = licensed.filter((x) => !has(/^Does not cover/)(x));
  if (!covering.length) return `No active lawyer in ${country} covers ${need.toLowerCase()}.`;
  const parts: string[] = [];
  const count = (re: RegExp, label: string) => {
    const n = covering.filter(has(re)).length;
    if (n) parts.push(`${n} ${label}`);
  };
  count(/^Licence in/, "licence not verified");
  count(/^Paused|^Still onboarding/, "paused or onboarding");
  count(/^Does not speak/, "no shared language");
  count(/^No free time/, "no free time");
  count(/^At capacity/, "at capacity");
  count(/^Conflict/, "conflict");
  return `Lawyers in ${country} who cover ${need.toLowerCase()} cannot take this member now (${parts.join(", ") || "other checks"}).`;
}

/**
 * Rank every lawyer for one request. Placeholder (seed) lawyers only ever
 * take placeholder members and the reverse; they are skipped silently.
 */
export function routeCandidates(
  r: RouteRequest,
  lawyers: readonly LawyerForRouting[],
  now: Date,
  specialties: readonly Specialty[],
  slotDays = ROUTING_SLOT_DAYS,
): RouteResult {
  const ranked: RoutingCandidate[] = [];
  const rejected: RoutingRejection[] = [];
  for (const l of lawyers) {
    if (l.placeholder !== r.placeholder) continue;
    const why = hardFilterReasons(l, r, now, specialties, slotDays);
    if (why.length) rejected.push({ providerId: l.providerId, name: l.name, reasons: why });
    else ranked.push(scoreLawyer(l, r, now, specialties, slotDays));
  }
  ranked.sort(compareCandidates);
  rejected.sort((a, b) => (a.providerId < b.providerId ? -1 : 1));
  return ranked.length ? { ranked, rejected } : { ranked, rejected, noMatchReason: noMatchReason(r, rejected, specialties) };
}

// ─── Request helpers (pure) ────────────────────────────────────────────────

/** Specialty keywords, checked in order; the first hit wins. Values are DEFAULT_SPECIALTIES ids. */
const SPECIALTY_WORDS: Array<[string, RegExp]> = [
  ["citizenship", /\b(citizenship|naturali[sz]\w*|nacionalidad|passport for me)\b/i],
  ["permanent_residency", /\bpermanent (residen\w*|status)\b|\bresidente permanente\b|\bpermanente\b/i],
  ["digital_nomad", /\b(digital nomad|remote work\w*|n[oó]mada digital|d8)\b/i],
  ["investor_residency", /\b(investor|inversionista|golden visa)\b/i],
  ["residency_renewals", /\b(dimex|tie|carn[eé])\b|\brenew\w*\b[^.]{0,40}\bresiden\w*|\bresiden\w*\b[^.]{0,40}\b(renew\w*|expir\w*)/i],
  ["residency_visas", /\b(residen\w*|visas?|pensionado|rentista|d7|immigration)\b/i],
  ["social_security", /\b(ccss|caja|imss|seguro social|social security|niss)\b/i],
  ["maritime_zone", /\b(maritime|zona mar[ií]timo|concession|canon)\b/i],
  ["bank_trust_restricted_zone", /\b(fideicomiso|bank trust|restricted zone)\b/i],
  ["condominium", /\b(condo\w*|hoa|owners'? association|condominio|propiedad horizontal)\b/i],
  ["property_sale", /\b(sell\w*|sale of (my|the|our) (house|home|property|condo|land))\b/i],
  ["land_titles", /\b(title|survey|plano|boundar\w*|catastro|registry)\b/i],
  ["property_tax", /\b(property tax|bienes inmuebles|predial|ibi|imi|municipal tax|luxury (home )?tax|solidario)\b/i],
  ["rentals_leases", /\b(rent\w*|lease\w*|tenant|airbnb)\b/i],
  ["property_purchase", /\b(buy\w*|purchas\w*|closing|due diligence|escritura|deed)\b/i],
  ["beneficial_ownership", /\b(beneficial owner\w*|rtbf|rub|rcbe)\b/i],
  ["company_cleanup", /\b(dissol\w*|dormant|inactive company|close (my|the|our) company|liquidat\w*)\b/i],
  ["company_formation", /\b(set up|form|open|incorporat\w*|start)\w* (a |an |my )?(company|corporation|business|s\.?a\.?|s\.?r\.?l\.?|llc)\b/i],
  ["foundations", /\b(foundation|fundaci[oó]n)\b/i],
  ["annual_corporate_filings", /\b(corporation tax|annual (filing|return|meeting)|legal books|personas jur[ií]dicas|s\.?a\.?|s\.?r\.?l\.?)\b/i],
  ["rental_income_tax", /\b(rental income|iva|vat)\b/i],
  ["special_tax_regimes", /\b(nhr|ifici|beckham)\b/i],
  ["tax_residency", /\b(tax residen\w*|double tax\w*|fbar|cross-border tax)\b/i],
  ["personal_income_tax", /\b(income tax|tax return|d-?101|irpf|declaraci[oó]n de renta)\b/i],
  ["vehicle_import", /\b(import\w*) (a |my )?(car|vehicle)\b|\b(car|vehicle) import\b/i],
  ["driver_licence", /\b(driver'?s? licen[cs]e|licencia de conducir)\b/i],
  ["vehicle_registration", /\b(marchamo|riteve|plates|refrendo|vehicle registration|transfer (a |my |the )?(car|vehicle)|soat|itv|iuc)\b/i],
  ["probate", /\b(probate|inherit\w*|estate of|sucesi[oó]n|heir\w*)\b/i],
  ["wills", /\b(a will|my will|our will|wills|testament|last will)\b/i],
  ["marriage_divorce", /\b(marri\w*|divorc\w*|custody)\b/i],
  ["powers_of_attorney", /\b(power of attorney|poder)\b/i],
  ["domestic_staff", /\b(housekeeper|gardener|caretaker|nanny|domestic|empleada)\b/i],
  ["business_employees", /\b(employees?|payroll|severance|liquidaci[oó]n)\b/i],
  ["apostille_translation", /\b(apostill\w*|translation)\b/i],
  ["notarial_acts", /\b(notar\w*)\b/i],
  ["landlord_tenant", /\b(evict\w*|landlord)\b/i],
  ["litigation", /\b(lawsuit|sue|sued|court|litigat\w*|demanda)\b/i],
  ["bank_accounts_kyc", /\b(bank account|kyc|open an account)\b/i],
  ["source_of_funds", /\b(source of funds|compliance letter)\b/i],
];

/**
 * The specialty a question most likely needs, among active specialties; null
 * when no keyword hits. When `area` is known, a hit in another area is ignored
 * (the area from the join form or staff wins over a stray word).
 */
export function inferSpecialty(text: string | null | undefined, area: AreaGroupId | null, active: readonly Specialty[]): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const byId = new Map(active.filter((s) => s.active).map((s) => [s.id, s]));
  for (const [id, re] of SPECIALTY_WORDS) {
    const s = byId.get(id);
    if (!s || !re.test(t)) continue;
    if (area && s.group !== area) continue;
    return id;
  }
  return null;
}

/** Member's preferred language field to call languages ("either" = English or Spanish). */
export function memberLanguages(preferred: unknown): string[] {
  const v = typeof preferred === "string" ? preferred.trim().toLowerCase() : "";
  if (v === "either" || v === "en_es") return ["en", "es"];
  if (/^(es|spanish|espa[nñ]ol)$/.test(v)) return ["es"];
  if (/^(pt|portuguese|portugu[eê]s)$/.test(v)) return ["pt"];
  if (/^(fr|french)$/.test(v)) return ["fr"];
  if (/^(de|german)$/.test(v)) return ["de"];
  return ["en"];
}

/** Whole days from now to the nearest of these dates (past dates count as 0); null when none. */
export function urgencyDays(dates: Array<string | null | undefined>, now: Date): number | null {
  const ts = dates.map((d) => (d ? Date.parse(d) : NaN)).filter((t) => !Number.isNaN(t));
  if (!ts.length) return null;
  return Math.max(0, Math.floor((Math.min(...ts) - now.getTime()) / DAY));
}

/** A stored area (matter.area) to its group, or null for general. */
export const areaOf = (v: unknown): AreaGroupId | null => toAreaGroup(v);
