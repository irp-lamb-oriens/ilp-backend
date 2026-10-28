/**
 * API/payments/joinIntake.ts
 * ──────────────────────────────────────────────────────────────────────────
 * T3: the guided join form's answers (/join). Pure functions, no I/O, so the
 * mapping is tested in test/joinIntake_test.ts.
 *
 *   parseJoinDetails(body)    → profile fields (PROFILE_FIELDS and
 *                               PROFILE_DETAIL_FIELDS keys), the intake
 *                               ("what you need first") and field errors
 *   checkAnswersFromProfile() → the free check's answers, so the join answers
 *                               give dated findings (obligations on activation)
 *   firstMatterFrom()         → the first Matter, created on activation
 *   onboardingDetail()        → text added to the onboarding CSM task title
 *
 * A body without `profile` and `intake` is the older short join (name, email,
 * phone): it still works and nothing extra is required.
 *
 * COUNTRIES: the form sends `profile.legalCountry` (one of the six) and
 * `profile.countryAnswers` (that country's situation questions, the same as
 * the free check's). The older Costa Rica body (residencyStatus "resident",
 * booleans) is still accepted when `countryAnswers` is absent.
 */

import {
  COUNTRIES,
  COUNTRY_ANSWERS_FIELD,
  type CountryCode,
  DOCUMENTS_ON_HAND,
  type DocumentOnHand,
  type JoinIntake,
  type LeadFinding,
  type Matter,
  PROFILE_DETAIL_FIELDS,
  PROFILE_FIELDS,
  toCountryCode,
} from "../../schemas/contracts.ts";
import { CR_PROVINCES, RESIDENCY_STATUSES } from "../leads/deadlineCheck.ts";
import { type Answers, answersToFacts, cleanAnswers, questionShown } from "../countries/rules/engine.ts";
import { questionsFor } from "../countries/rules/index.ts";

type Doc = Record<string, unknown>;
export type JoinErrors = Record<string, string>;

export const LANGUAGES = ["en", "es", "either"] as const;
export const MARITAL_STATUSES = ["single", "married", "partnered", "divorced", "widowed"] as const;
export const RESIDENCY_CATEGORIES = ["pensionado", "rentista", "inversionista", "permanent", "digital_nomad", "family", "other", "unsure"] as const;
export const PROPERTY_TYPES = ["house", "condo", "land", "commercial", "several", "other"] as const;
export const PROPERTY_HOLDINGS = ["personal", "company", "both", "unsure"] as const;
export const JOIN_COMPANY_TYPES = ["SA", "SRL", "none", "unsure"] as const;
export const YES_NO_UNSURE = ["yes", "no", "unsure"] as const;
export const URGENCIES = ["deadline", "soon", "no_rush"] as const;
export const QUESTION_MIN = 10;
export const QUESTION_MAX = 1000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE_RE = /^\+?[0-9 ()-]{7,24}$/;
const TZ_RE = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/;

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | undefined =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : undefined;
function bool(v: unknown): boolean | undefined {
  if (v === true || v === "true" || v === "yes") return true;
  if (v === false || v === "false" || v === "no") return false;
  return undefined;
}
function int(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}
function date(v: unknown): string | undefined {
  if (typeof v !== "string" || !DATE_RE.test(v)) return undefined;
  const d = new Date(`${v}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  const y = d.getUTCFullYear();
  return y >= 1990 && y <= 2100 ? v : undefined;
}

/** True when the body comes from the guided join form. */
export function isGuidedJoin(body: Doc): boolean {
  return !!(body.profile && typeof body.profile === "object") || !!(body.intake && typeof body.intake === "object");
}

/**
 * Validate the guided join form. Returns the profile fields to write on the
 * client record, the intake, and field errors keyed like the form's fields.
 * `today` (YYYY-MM-DD) bounds the deadline date; defaults to now.
 */
export function parseJoinDetails(body: Doc, today = new Date().toISOString().slice(0, 10)): {
  profile: Doc;
  intake: JoinIntake | null;
  errors: JoinErrors;
} {
  const errors: JoinErrors = {};
  if (!isGuidedJoin(body)) return { profile: {}, intake: null, errors };
  const p = (body.profile && typeof body.profile === "object" ? body.profile : {}) as Doc;
  const i = (body.intake && typeof body.intake === "object" ? body.intake : {}) as Doc;
  const out: Doc = {};

  // ── You ──
  const phone = text(body.phone, 40);
  if (!PHONE_RE.test(phone)) errors.phone = "Enter a mobile or WhatsApp number with the country code, like +1 503 555 0141.";
  const preferredName = text(p.preferredName, 60);
  if (preferredName) out.preferredName = preferredName;
  const lang = oneOf(LANGUAGES, p.preferredLanguage);
  if (lang) out.preferredLanguage = lang;
  else errors.preferredLanguage = "Choose the language you prefer for calls and messages.";
  const nationality = text(p.nationality, 120);
  if (nationality.length >= 2) out.nationality = nationality;
  else errors.nationality = "Choose at least one citizenship.";
  const residenceCountry = text(p.residenceCountry, 60);
  if (residenceCountry.length >= 2) out.residenceCountry = residenceCountry;
  else errors.residenceCountry = "Tell us which country you live in now.";
  if (residenceCountry === "Costa Rica") {
    const prov = oneOf(CR_PROVINCES, p.residenceProvince);
    if (prov) out.residenceProvince = prov;
    else errors.residenceProvince = "Choose the province where you live.";
    const town = text(p.residenceTown, 80);
    if (town) out.residenceTown = town;
  }
  const tz = text(p.timezone, 60);
  if (TZ_RE.test(tz)) out.timezone = tz;
  else errors.timezone = "Choose your time zone.";

  // ── Household ──
  const marital = oneOf(MARITAL_STATUSES, p.maritalStatus);
  if (marital) out.maritalStatus = marital;
  else errors.maritalStatus = "Choose your marital status.";
  const partner = bool(p.livesWithPartner);
  if (partner !== undefined) out.livesWithPartner = partner;
  else errors.livesWithPartner = "Tell us whether a spouse or partner lives with you.";
  const children = int(p.childrenAtHome, 0, 20);
  if (children !== undefined) out.childrenAtHome = children;
  else errors.childrenAtHome = "Enter how many children live with you, from 0 to 20.";
  const others = int(p.otherHousehold, 0, 20);
  if (others !== undefined) out.otherHousehold = others;
  else errors.otherHousehold = "Enter how many other people live with you, from 0 to 20.";
  if (children !== undefined && others !== undefined) out.dependents = children + others;
  const pets = text(p.pets, 120);
  if (pets) out.pets = pets;

  // ── Your situation in the membership's country ──
  const legalCountry = toCountryCode(p.legalCountry ?? body.country);
  if (p.countryAnswers && typeof p.countryAnswers === "object") {
    if (!legalCountry) errors.legalCountry = "Choose the country your membership is about.";
    else {
      const { answers, missing } = countryAnswersFrom(legalCountry, p.countryAnswers as Doc);
      for (const key of missing) errors[`countryAnswers.${key}`] = "Choose an answer, or I am not sure if it is listed.";
      out.legalCountry = legalCountry;
      out[COUNTRY_ANSWERS_FIELD] = answers;
      Object.assign(out, profileFromCountryAnswers(legalCountry, answers));
      const location = text(p.propertyLocation, 80);
      if (out.ownsProperty === true && location) out.propertyLocation = location;
      const type = oneOf(PROPERTY_TYPES, p.propertyType);
      if (out.ownsProperty === true && type) out.propertyType = type;
      const n = int(p.companyCount, 1, 20);
      if (out.hasCompany === true && n !== undefined) out.companyCount = n;
      const upToDate = oneOf(YES_NO_UNSURE, p.companyUpToDate);
      if (out.hasCompany === true && upToDate) out.companyUpToDate = upToDate;
    }
  } else {
    if (legalCountry && legalCountry !== "CR") errors.legalCountry = "Answer the questions about your situation in that country.";
    const rs = oneOf(RESIDENCY_STATUSES, p.residencyStatus);
    if (rs) out.residencyStatus = rs;
    else errors.residencyStatus = "Choose your residency status.";
    if (rs === "resident" || rs === "applying") {
      const cat = oneOf(RESIDENCY_CATEGORIES, p.residencyCategory);
      if (cat) out.residencyCategory = cat;
      else errors.residencyCategory = "Choose your residency category, or I am not sure.";
    }
    if (rs === "resident" && p.residencyExpiresAt) {
      const exp = date(p.residencyExpiresAt);
      if (exp) out.residencyExpiresAt = exp;
      else errors.residencyExpiresAt = "Enter the expiry date from your DIMEX card, or leave it empty.";
    }
    if (rs === "visitor" && p.lastEntryDate) {
      const entry = date(p.lastEntryDate);
      if (entry && entry <= today) out.lastEntryDate = entry;
      else errors.lastEntryDate = "Enter the date of your last entry stamp, or leave it empty.";
    }

    const ownsProperty = bool(p.ownsProperty);
    if (ownsProperty !== undefined) out.ownsProperty = ownsProperty;
    else errors.ownsProperty = "Tell us whether you own property in Costa Rica.";
    if (ownsProperty) {
      const type = oneOf(PROPERTY_TYPES, p.propertyType);
      if (type) out.propertyType = type;
      else errors.propertyType = "Choose the kind of property.";
      const loc = oneOf(CR_PROVINCES, p.propertyLocation);
      if (loc) out.propertyLocation = loc;
      else errors.propertyLocation = "Choose the province where the property is.";
      const holding = oneOf(PROPERTY_HOLDINGS, p.propertyHolding);
      if (holding) out.propertyHolding = holding;
      else errors.propertyHolding = "Tell us whose name the property is in, or I am not sure.";
    }

    const company = oneOf(JOIN_COMPANY_TYPES, p.companyType);
    if (company) {
      out.companyType = company;
      if (company === "SA" || company === "SRL") out.hasCompany = true;
      if (company === "none") out.hasCompany = false;
    } else errors.companyType = "Tell us whether you have a Costa Rican company.";
    if (company === "SA" || company === "SRL") {
      const n = int(p.companyCount, 1, 20);
      if (n !== undefined) out.companyCount = n;
      else errors.companyCount = "Enter how many companies, from 1 to 20.";
      const upToDate = oneOf(YES_NO_UNSURE, p.companyUpToDate);
      if (upToDate) out.companyUpToDate = upToDate;
      else errors.companyUpToDate = "Tell us whether the company filings are up to date, or I am not sure.";
    }

    const vehicle = bool(p.ownsVehicle);
    if (vehicle !== undefined) out.ownsVehicle = vehicle;
    else errors.ownsVehicle = "Tell us whether you own a vehicle in Costa Rica.";
    if (vehicle) {
      const m = oneOf(YES_NO_UNSURE, p.marchamoStatus);
      if (m) out.marchamoStatus = m;
      else errors.marchamoStatus = "Tell us whether the marchamo is paid for this year, or I am not sure.";
    }

    const employees = bool(p.hasEmployees);
    if (employees !== undefined) out.hasEmployees = employees;
    else errors.hasEmployees = "Tell us whether anyone works for you in Costa Rica.";

  }

  // ── What you need first ──
  const question = text(i.question, QUESTION_MAX + 200);
  if (question.length < QUESTION_MIN) errors.question = `Write your main question in a sentence or two (at least ${QUESTION_MIN} characters).`;
  else if (question.length > QUESTION_MAX) errors.question = `Keep it to ${QUESTION_MAX} characters. You can add more on the call.`;
  const urgency = oneOf(URGENCIES, i.urgency);
  if (!urgency) errors.urgency = "Tell us how soon you need an answer.";
  let deadlineAt: string | undefined;
  if (urgency === "deadline") {
    const d = date(i.deadlineAt);
    if (d && d >= today) deadlineAt = `${d}T12:00:00.000Z`;
    else errors.deadlineAt = "Enter the date of the deadline, today or later.";
  }
  const docsRaw = Array.isArray(i.documentsOnHand) ? i.documentsOnHand : null;
  const docs = (docsRaw ?? []).filter((d): d is DocumentOnHand => oneOf(DOCUMENTS_ON_HAND, d) !== undefined);
  const noneYet = i.noDocumentsYet === true;
  if (!docs.length && !noneYet) errors.documentsOnHand = "Tick the documents you have, or None yet.";

  const intake: JoinIntake | null = Object.keys(errors).length
    ? null
    : {
      question: question.slice(0, QUESTION_MAX),
      urgency: urgency!,
      ...(deadlineAt ? { deadlineAt } : {}),
      documentsOnHand: [...new Set(docs)],
      submittedAt: new Date().toISOString(),
    };
  return { profile: Object.keys(errors).length ? {} : { ...out, phone }, intake, errors };
}

/** Every profile key the join may write (both lists from contracts, plus the country answers map). */
export const JOIN_PROFILE_KEYS = new Set(
  [...Object.values(PROFILE_FIELDS), ...Object.values(PROFILE_DETAIL_FIELDS), COUNTRY_ANSWERS_FIELD].flat(),
);

/**
 * A country's situation answers: only known questions and values are kept.
 * `missing` lists the free-check questions (not optional, shown for these
 * answers) that have no answer yet.
 */
export function countryAnswersFrom(country: CountryCode, raw: Doc): { answers: Answers; missing: string[] } {
  const qs = questionsFor(country);
  const answers = cleanAnswers(qs, raw);
  const missing = qs
    .filter((q) => q.stage === "check" && !q.optional && q.type !== "date" && questionShown(q, answers) && answers[q.key] === undefined)
    .map((q) => q.key);
  return { answers, missing };
}

/** Date facts that mean "my residency card or visa expires on". */
const EXPIRY_KEYS = ["residencyExpiryDate", "permitExpiryDate", "residencyCardExpiry", "visaExpiryDate", "carneExpiryDate", "idCardExpiryDate"];
const NOT_YES = new Set(["no", "unsure", "not_sure", "notSure", "planning", "none"]);

/**
 * The shared profile fields (PROFILE_FIELDS, used for completeness and by
 * staff and lawyers) from a country's answers: booleans for property,
 * company, vehicle and staff; the residency status and expiry as given.
 */
export function profileFromCountryAnswers(country: CountryCode, answers: Answers): Doc {
  const facts = answersToFacts(questionsFor(country), answers);
  const out: Doc = {};
  const first = (k: string) => facts[k]?.[0];
  const flag = (k: string): boolean | undefined => {
    const v = facts[k];
    if (!v?.length) return undefined;
    if (v.includes("yes")) return true;
    if (v.every((x) => NOT_YES.has(x))) return v.includes("no") || v.includes("none") ? false : undefined;
    return true; // a kind of company, staff or vehicle
  };
  if (typeof answers.residencyStatus === "string") out.residencyStatus = answers.residencyStatus;
  const cat = answers.residencyCategory ?? answers.residencyProgram ?? answers.visaBasis;
  if (typeof cat === "string") out.residencyCategory = cat;
  for (const k of EXPIRY_KEYS) {
    const v = first(k);
    if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      out.residencyExpiresAt = v;
      break;
    }
  }
  const entry = first("entryDate");
  if (entry && /^\d{4}-\d{2}-\d{2}$/.test(entry)) out.lastEntryDate = entry;
  for (const k of ["ownsProperty", "hasCompany", "ownsVehicle", "hasEmployees"]) {
    const v = flag(k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * The free check's answers taken from the join profile (the check
 * normalizes them again): the country answers map when present, else the
 * older Costa Rica keys.
 */
export function checkAnswersFromProfile(profile: Doc): Doc {
  const ca = profile[COUNTRY_ANSWERS_FIELD];
  if (ca && typeof ca === "object") return { country: toCountryCode(profile.legalCountry) ?? "CR", ...(ca as Doc) };
  const keys = ["residencyStatus", "residencyCategory", "residencyExpiresAt", "lastEntryDate", "ownsProperty", "propertyLocation", "companyType", "ownsVehicle", "hasEmployees"];
  const a: Doc = { country: "CR" };
  for (const k of keys) if (profile[k] !== undefined) a[k] = profile[k];
  return a;
}

/** The membership's country from a join profile; Costa Rica for the older form. */
export const countryFromProfile = (profile: Doc): CountryCode => toCountryCode(profile.legalCountry) ?? "CR";

/** Default time zone for a member of `country` (the first of that country's zones). */
export const defaultTimeZoneFor = (country: CountryCode) => COUNTRIES[country].defaultTimeZone;

// ─── First matter ──────────────────────────────────────────────────────────

/** Area keywords, checked in order; the first match wins. Values match lawyer specialties. */
const AREA_WORDS: Array<[string, RegExp[]]> = [
  ["immigration", [/\b(residen\w*|dimex|visas?|pensionado|rentista|inversionista|migraci\w*|immigration|citizenship|naturali[sz]\w*|digital nomad|tourist stay|overstay\w*|c[eé]dula de extranjer[ií]a|traspaso|carn[eé]|tie|nie|aima|d7|d8|golden visa|inm|fmm|padr[oó]n)\b/i]],
  ["vehicle", [/\b(cars?|vehicles?|marchamo|riteve|driver'?s licen[cs]e|plates|motorcycles?|soat|itv|iuc|refrendo)\b/i]],
  ["labor", [/\b(employees?|employ\w*|housekeepers?|gardeners?|caretakers?|nanny|domestic staff|aguinaldo|severance|liquidaci\w*|caja|ccss)\b/i]],
  // S.A. / S.R.L. are matched case-sensitively, so "it's a" or "sa" in a word never counts.
  ["corporate", [/\bS\.\s?A\b|\bS\.\s?R\.\s?L\b|\bSRL\b|\bSA\b|\bS\.A\.S\b|\bS\.\s?L\b|\bLda\b/, /\b(corporations?|compan(y|ies)|sociedad\w*|beneficial owners?|rtbf|rub|rcbe|corporate|fundaci[oó]n|foundation)\b/i]],
  ["tax", [/\b(tax|taxes|hacienda|d-?101|iva|vat|capital gains|dian|sat|rfc|aeat|irpf|modelo|imi|irs|nif|dgi|predial|ibi)\b/i]],
  ["family_estate", [/\b(a will|my will|wills|testament|estate planning|inherit\w*|probate|divorc\w*|custody|power of attorney)\b/i]],
  ["real_estate", [/\b(property|properties|house|home|condo|land|title|plano|deed|escritura|municipal\w*|zoning|easement|boundar\w*|purchase|lease)\b/i]],
];

/**
 * The matter's legal area: from the question's words, else from the
 * situation answers when exactly one area stands out, else "general".
 */
export function inferArea(question: string, profile: Doc = {}): string {
  for (const [area, res] of AREA_WORDS) if (res.some((re) => re.test(question))) return area;
  const fromAnswers: string[] = [];
  if (profile.residencyStatus === "applying" || profile.residencyStatus === "visitor") fromAnswers.push("immigration");
  if (profile.hasCompany === true) fromAnswers.push("corporate");
  if (profile.ownsProperty === true && profile.hasCompany !== true) fromAnswers.push("real_estate");
  return fromAnswers.length === 1 ? fromAnswers[0] : "general";
}

/** Matter title: the question's first sentence, at most 80 characters. */
export function titleFromQuestion(question: string): string {
  const clean = question.replace(/\s+/g, " ").trim();
  // A sentence ends at ? or !, or at a period after a lowercase word ("S.A. up" is not an end).
  const first = clean.split(/(?<=[?!])\s|(?<=[a-z]{2}\.)\s(?=[A-Z])/)[0] ?? clean;
  if (first.length <= 80) return first;
  const cut = first.slice(0, 79);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[,;:]$/, "")}…`;
}

export const FIRST_NEXT_STEP = "Book your first call";

/** Deterministic id, so activating twice never opens two first matters. */
export const firstMatterId = (membershipId: string) => `mat_join_${membershipId}`.replace(/[^A-Za-z0-9_-]/g, "_");

/** The first Matter from the join intake. */
export function firstMatterFrom(
  args: { clientId: string; membershipId: string; intake: JoinIntake; profile?: Doc; country?: Matter["country"] },
  now = new Date(),
): Matter {
  const at = now.toISOString();
  const m: Matter = {
    id: firstMatterId(args.membershipId),
    clientId: args.clientId,
    title: titleFromQuestion(args.intake.question),
    area: inferArea(args.intake.question, args.profile ?? {}),
    country: args.country ?? "CR",
    stage: "intake",
    stageEnteredAt: at,
    nextStep: { what: FIRST_NEXT_STEP, who: "client" },
    nextStepSetAt: at,
    openedAt: at,
    source: "join",
    question: args.intake.question,
    documentsOnHand: args.intake.documentsOnHand,
  };
  if (args.intake.deadlineAt) m.deadlineAt = args.intake.deadlineAt;
  return m;
}

/** Text for the onboarding task title: the member's name and main question. */
export function onboardingDetail(name: string, intake?: JoinIntake | null): string | undefined {
  const who = name.trim();
  if (!intake) return who || undefined;
  const q = intake.question.replace(/\s+/g, " ").trim();
  const short = q.length > 140 ? `${q.slice(0, 139)}…` : q;
  const due = intake.urgency === "deadline" && intake.deadlineAt ? `, deadline ${intake.deadlineAt.slice(0, 10)}` : intake.urgency === "soon" ? ", wants an answer soon" : "";
  return `${who ? `${who}. ` : ""}First question: "${short}"${due}`;
}

/** Findings worth keeping on the intake (no `meaning` text, contract shape only). */
export function intakeFindings(findings: Array<LeadFinding & { meaning?: string }>): LeadFinding[] {
  return findings.map(({ ruleId, title, dueAt, area, windowStartAt, confidence, dueText }) => ({
    ruleId,
    title,
    area,
    ...(dueAt ? { dueAt } : {}),
    ...(windowStartAt ? { windowStartAt } : {}),
    ...(confidence ? { confidence } : {}),
    ...(dueText ? { dueText } : {}),
  }));
}
