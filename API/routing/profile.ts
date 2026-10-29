/**
 * API/routing/profile.ts — lawyer routing profiles (ROUTING).
 * ──────────────────────────────────────────────────────────────────────────
 * Validation is pure (`normalizeProfile`). Lawyers save LAWYER_PROFILE_FIELDS
 * on their own profile; staff save those plus LAWYER_PROFILE_STAFF_FIELDS
 * (countries, licences and their verification, notary status) on any lawyer.
 * `legalAreas` is kept in step with the specialties' areas for older screens.
 */

import get from "../../db/get.ts";
import put from "../../db/put.ts";
import auditLog from "../../helper/auditLog.ts";
import {
  CALL_LANGUAGES,
  COUNTRIES,
  COUNTRY_CODES,
  type CountryCode,
  groupsOf,
  LANGUAGE_LEVELS,
  LAWYER_CLIENT_TYPES,
  LAWYER_PROFILE_FIELDS,
  LAWYER_PROFILE_STAFF_FIELDS,
  type LawyerLicence,
  type LawyerRoutingProfile,
  type Specialty,
  toCountryCode,
} from "../../schemas/contracts.ts";
import { cleanSpecialtyIds, loadSpecialties } from "./specialties.ts";
import { emailLanguageFor } from "./precall.ts";
import { isProviderBookable } from "../providers/applyLogic.ts";

type Doc = Record<string, unknown>;
export type ProfileRole = "lawyer" | "staff";

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
const strList = (v: unknown, max: number, each: number) =>
  [...new Set((Array.isArray(v) ? v : []).map((x) => str(x, each)).filter((x) => x.length >= 2))].slice(0, max);
const countries = (v: unknown): CountryCode[] =>
  [...new Set((Array.isArray(v) ? v : []).map(toCountryCode).filter((c): c is CountryCode => !!c))];
const intIn = (v: unknown, lo: number, hi: number): number | null | undefined => {
  if (v === null || v === "" || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : undefined;
};

/** The profile as stored, with defaults from the older fields (application, legalAreas). */
export function profileOf(p: Doc, specialties: readonly Specialty[]): LawyerRoutingProfile & { emailLanguage: "es" | "pt" | "en" } {
  const app = (p.application && typeof p.application === "object" ? p.application : {}) as Doc;
  const juris = countries(Array.isArray(p.jurisdictions) && p.jurisdictions.length ? p.jurisdictions : [p.country ?? "CR"]);
  const licences: LawyerLicence[] = Array.isArray(p.licences) && p.licences.length
    ? (p.licences as LawyerLicence[])
    : juris.map((c) => ({
      country: c,
      body: COUNTRIES[c].lawyerBody.name,
      number: c === toCountryCode(app.country ?? p.country) ? str(app.carne, 24) : "",
      // Lawyers approved before licence records: the staff review checked the licence (same rule as the router).
      verified: isProviderBookable(p),
      ...(isProviderBookable(p) && str(p.activatedAt ?? p.reviewedAt) ? { verifiedAt: str(p.activatedAt ?? p.reviewedAt), verifiedBy: str(p.reviewedBy) || "application review" } : {}),
    }));
  return {
    specialties: cleanSpecialtyIds(p.specialties, specialties),
    specialtyNotes: (p.specialtyNotes && typeof p.specialtyNotes === "object" ? p.specialtyNotes : {}) as Record<string, string>,
    jurisdictions: juris,
    licences,
    notary: (p.notary && typeof p.notary === "object" ? p.notary : { isNotary: app.notary === true, countries: app.notary === true ? juris.slice(0, 1) : [], ...(str(app.notaryCarne) ? { number: str(app.notaryCarne) } : {}) }) as LawyerRoutingProfile["notary"],
    languages: Array.isArray(p.languages) ? (p.languages as string[]).filter((l) => (CALL_LANGUAGES as readonly string[]).includes(l)) : [],
    languageLevels: (p.languageLevels && typeof p.languageLevels === "object" ? p.languageLevels : {}) as LawyerRoutingProfile["languageLevels"],
    emailLanguage: emailLanguageFor(p),
    regions: Array.isArray(p.regions) ? (p.regions as string[]) : [str(app.province), str(app.city)].filter(Boolean),
    clientTypes: Array.isArray(p.clientTypes) ? (p.clientTypes as LawyerRoutingProfile["clientTypes"]) : [],
    maxCallsPerWeek: typeof p.maxCallsPerWeek === "number" ? p.maxCallsPerWeek : typeof app.callsPerWeek === "number" ? app.callsPerWeek : undefined,
    responseHours: typeof p.responseHours === "number" ? p.responseHours : undefined,
    yearsInPractice: typeof p.yearsInPractice === "number" ? p.yearsInPractice : typeof app.yearsInPractice === "number" ? app.yearsInPractice : undefined,
    feeRangeCents: (p.feeRangeCents && typeof p.feeRangeCents === "object" ? p.feeRangeCents : null) as LawyerRoutingProfile["feeRangeCents"],
    conflicts: Array.isArray(p.conflicts) ? (p.conflicts as string[]) : [],
    routingStatus: p.routingStatus === "paused" || p.routingStatus === "onboarding" ? p.routingStatus : "active",
    bio: typeof p.bio === "string" ? p.bio : "",
  };
}

/**
 * Validate a profile body for this role. Unknown and (for lawyers) staff-only
 * keys are ignored. Returns the fields to write or field errors in plain words.
 */
export function normalizeProfile(
  body: unknown,
  role: ProfileRole,
  specialties: readonly Specialty[],
  actorEmail: string,
  previous: LawyerRoutingProfile | null,
  now = new Date(),
): { value: Doc } | { errors: Record<string, string> } {
  const o = (body && typeof body === "object" ? body : {}) as Doc;
  const e: Record<string, string> = {};
  const out: Doc = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(o, k);

  if (has("specialties")) {
    const ids = cleanSpecialtyIds(o.specialties, specialties);
    if (!ids.length) e.specialties = "Choose at least one specialty you take.";
    else if (ids.length > 25) e.specialties = "Choose 25 specialties at most.";
    out.specialties = ids;
    out.legalAreas = groupsOf(ids, specialties);
  }
  if (has("specialtyNotes")) {
    const raw = (o.specialtyNotes && typeof o.specialtyNotes === "object" ? o.specialtyNotes : {}) as Doc;
    const keep = (out.specialties as string[] | undefined) ?? previous?.specialties ?? [];
    out.specialtyNotes = Object.fromEntries(Object.entries(raw).filter(([k]) => keep.includes(k)).map(([k, v]) => [k, str(v, 200)]).filter(([, v]) => v));
  }
  if (has("languages")) {
    const langs = [...new Set((Array.isArray(o.languages) ? o.languages : []).map((l) => String(l).toLowerCase()))].filter((l) => (CALL_LANGUAGES as readonly string[]).includes(l));
    if (!langs.length) e.languages = "Choose at least one language you can hold a call in.";
    out.languages = langs;
  }
  if (has("languageLevels")) {
    const raw = (o.languageLevels && typeof o.languageLevels === "object" ? o.languageLevels : {}) as Doc;
    out.languageLevels = Object.fromEntries(Object.entries(raw).filter(([k, v]) => (CALL_LANGUAGES as readonly string[]).includes(k) && (LANGUAGE_LEVELS as readonly string[]).includes(String(v))));
  }
  if (has("emailLanguage")) {
    if (!["es", "pt", "en"].includes(String(o.emailLanguage))) e.emailLanguage = "Choose Spanish, Portuguese or English.";
    else out.emailLanguage = o.emailLanguage;
  }
  if (has("regions")) out.regions = strList(o.regions, 15, 60);
  if (has("clientTypes")) out.clientTypes = (Array.isArray(o.clientTypes) ? o.clientTypes : []).map(String).filter((x, i, a) => (LAWYER_CLIENT_TYPES as readonly string[]).includes(x) && a.indexOf(x) === i);
  const num = (k: string, lo: number, hi: number, msg: string) => {
    if (!has(k)) return;
    const n = intIn(o[k], lo, hi);
    if (n === undefined) e[k] = msg;
    else out[k] = n;
  };
  num("maxCallsPerWeek", 1, 40, "Enter between 1 and 40 calls a week.");
  num("responseHours", 1, 168, "Enter between 1 and 168 hours.");
  num("yearsInPractice", 0, 70, "Enter your years in practice, from 0 to 70.");
  if (has("feeRangeCents")) {
    const f = o.feeRangeCents as Doc | null;
    if (!f) out.feeRangeCents = null;
    else {
      const min = intIn(f.min, 0, 10_000_000);
      const max = intIn(f.max, 0, 10_000_000);
      if (min === undefined || max === undefined || min === null || max === null || min > max) e.feeRangeCents = "Enter a range in US dollars, the lower amount first.";
      else out.feeRangeCents = { min, max };
    }
  }
  if (has("conflicts")) out.conflicts = strList(o.conflicts, 50, 120);
  if (has("routingStatus")) {
    const allowed = role === "staff" ? ["active", "paused", "onboarding"] : ["active", "paused"];
    if (!allowed.includes(String(o.routingStatus))) e.routingStatus = "Choose whether you take new members now.";
    else out.routingStatus = o.routingStatus;
  }
  if (has("bio")) {
    const bio = typeof o.bio === "string" ? o.bio.trim().slice(0, 1000) : "";
    if (bio.length > 800) e.bio = "Keep it to 800 characters or fewer.";
    else out.bio = bio;
  }

  if (role === "staff") {
    if (has("jurisdictions")) {
      const j = countries(o.jurisdictions);
      if (!j.length) e.jurisdictions = "Choose at least one country where the lawyer is licensed.";
      out.jurisdictions = j;
    }
    if (has("licences")) {
      const prev = previous?.licences ?? [];
      const list: LawyerLicence[] = [];
      for (const raw of Array.isArray(o.licences) ? o.licences : []) {
        const l = (raw ?? {}) as Doc;
        const c = toCountryCode(l.country);
        if (!c) continue;
        const verified = l.verified === true;
        const before = prev.find((x) => x.country === c);
        const number = str(l.number, 24);
        if (verified && !number) e[`licence_${c}`] = `Enter the ${COUNTRIES[c].lawyerBody.numberLabel.toLowerCase()} before marking it verified.`;
        // COMMS-P2: optional expiry date (YYYY-MM-DD or ISO); the lawyer and staff are emailed 60 and 30 days before.
        const rawExpiry = typeof l.expiresAt === "string" ? l.expiresAt.trim() : "";
        const expiryMs = rawExpiry ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(rawExpiry) ? `${rawExpiry}T12:00:00.000Z` : rawExpiry) : NaN;
        if (rawExpiry && Number.isNaN(expiryMs)) e[`licenceExpiry_${c}`] = "Enter the expiry date as a date, for example 2027-03-31.";
        list.push({
          country: c,
          body: COUNTRIES[c].lawyerBody.name,
          number,
          verified,
          ...(verified ? (before?.verified && before.number === number ? { verifiedAt: before.verifiedAt, verifiedBy: before.verifiedBy } : { verifiedAt: now.toISOString(), verifiedBy: actorEmail }) : {}),
          ...(rawExpiry && !Number.isNaN(expiryMs) ? { expiresAt: new Date(expiryMs).toISOString() } : {}),
        });
      }
      out.licences = list;
    }
    if (has("notary")) {
      const n = (o.notary ?? {}) as Doc;
      out.notary = { isNotary: n.isNotary === true, countries: n.isNotary === true ? countries(n.countries) : [], ...(str(n.number, 24) ? { number: str(n.number, 24) } : {}), verified: n.isNotary === true && n.verified === true };
    }
  }
  if (Object.keys(e).length) return { errors: e };
  return { value: out };
}

/** Load, validate and save. Returns the saved profile or field errors. Audited. */
export async function saveProfile(
  providerId: string,
  body: unknown,
  actor: { email: string; role: ProfileRole },
): Promise<{ status: number; body: Doc }> {
  const p = (await get("providers", providerId).catch(() => null)) as Doc | null;
  if (!p) return { status: 404, body: { error: "Lawyer not found." } };
  const specialties = await loadSpecialties();
  const before = profileOf({ ...p, id: providerId }, specialties);
  const r = normalizeProfile(body, actor.role, specialties, actor.email, before);
  if ("errors" in r) return { status: 400, body: { error: "Some answers need a fix. Each one is marked on the form.", errors: r.errors } };
  if (!Object.keys(r.value).length) return { status: 400, body: { error: "Nothing to save." } };
  const at = new Date().toISOString();
  await put("providers", providerId, { ...r.value, updatedAt: at, updatedBy: actor.email, profileUpdatedAt: at });
  const changed = Object.keys(r.value);
  await auditLog({
    actor: { uid: actor.email, email: actor.email, role: actor.role },
    action: "provider.profile_updated",
    target: `providers/${providerId}`,
    meta: {
      fields: changed,
      staffFields: changed.filter((k) => (LAWYER_PROFILE_STAFF_FIELDS as readonly string[]).includes(k)),
      ...(r.value.specialties ? { specialties: r.value.specialties } : {}),
      ...(r.value.licences ? { verified: (r.value.licences as LawyerLicence[]).filter((l) => l.verified).map((l) => l.country) } : {}),
    },
  }).catch(() => undefined);
  const after = profileOf({ ...p, ...r.value, id: providerId }, specialties);
  return { status: 200, body: { profile: after, changed } };
}

/** Keys a lawyer may send (others are ignored by normalizeProfile). */
export const LAWYER_KEYS: readonly string[] = LAWYER_PROFILE_FIELDS;
/** Every country code (for staff forms). */
export const ALL_COUNTRIES: readonly CountryCode[] = COUNTRY_CODES;
