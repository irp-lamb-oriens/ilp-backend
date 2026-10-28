/**
 * API/providers/applyLogic.ts — partner lawyer applications (T2).
 * ──────────────────────────────────────────────────────────────────────────
 * Pure validation plus the submit and review flows, with every side effect
 * passed in as a dependency (ApplyDeps) so the tests run without Firestore,
 * SMTP or Express. applyRouter.ts wires the real dependencies.
 *
 * Statuses on the `providers` doc (field `status`, with `active` kept in step):
 *   pending_review     application received; may sign in, cannot take calls
 *   changes_requested  staff asked for changes; may sign in and resubmit
 *   active             approved by staff; takes calls (active: true)
 *   declined           not approved; cannot sign in
 * An application never activates a lawyer. Only a staff "approve" does.
 */

import { isTimeZone, normalizeAvailability } from "../calls/callLogic.ts";
import { LEGAL_VERSIONS } from "../privacy/policy.ts";
import {
  type ConsentRecord,
  COUNTRIES,
  type CountryCode,
  type CsmTask,
  type LawyerAvailability,
  toCountryCode,
  type WeeklyWindow,
} from "../../schemas/contracts.ts";

type Doc = Record<string, unknown>;

/** Version of the draft partner lawyer terms (keep equal to frontend components/legal/content/partner.ts). */
export const PARTNER_TERMS_VERSION = "partner-terms-2026-10-27-draft1";

export type ApplicationStatus = "pending_review" | "changes_requested" | "active" | "declined";

export const APPLY_AREAS = ["immigration", "real_estate", "corporate", "tax", "vehicle", "family_estate", "labor", "other"] as const;
export type ApplyArea = (typeof APPLY_AREAS)[number];

export const APPLY_LANGUAGES = ["en", "es", "fr", "de", "pt", "other"] as const;
export const CR_PROVINCES = ["San José", "Alajuela", "Cartago", "Heredia", "Guanacaste", "Puntarenas", "Limón"] as const;
export const NOTICE_HOURS = [12, 24, 48, 72] as const;
export const COMFORT_LEVELS = ["regular", "sometimes"] as const;
export const QUOTE_PREFERENCES = ["flat", "hourly", "either"] as const;
export const INVOICING = ["individual", "firm"] as const;
/** Common work a member may ask a quote for; flat fees are optional. */
export const FLAT_FEE_KEYS = ["residency", "company_setup", "property_review", "vehicle_transfer", "will"] as const;

export const BIO_MIN = 80;
export const BIO_MAX = 800;
const MAX_CENTS = 10_000_000; // US$100,000

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9 ()-]{7,24}$/;
const CARNE_RE = /^\d{1,7}$/;
/** Licence numbers outside Costa Rica: letters, digits and separators (e.g. Madrid "ICAM 123456", Portugal "12345L"). */
const LICENCE_RE = /^[A-Za-z0-9/-]{1,20}$/;

/** The licensing body and the number to ask for, per country (contracts COUNTRIES). */
export function licensingFor(country: CountryCode) {
  const c = COUNTRIES[country];
  return { body: c.lawyerBody.name, numberLabel: c.lawyerBody.numberLabel, url: c.lawyerBody.url, countryName: c.name };
}

export interface Application {
  /** Country of practice; the licence below is from this country's body. Costa Rica for older forms. */
  country: CountryCode;
  name: string;
  email: string;
  phone: string;
  languages: string[];
  city: string;
  province: string; // Costa Rica: one of CR_PROVINCES; elsewhere the state, region or department
  carne: string; // licence number (Costa Rica carné, Colombia tarjeta profesional, Mexico cédula profesional, ...)
  timezone: string;
  yearAdmitted: number;
  notary: boolean;
  notaryCarne?: string;
  firmName?: string;
  firmWebsite?: string;
  yearsInPractice: number;
  areas: ApplyArea[];
  otherArea?: string;
  areaComfort: Partial<Record<ApplyArea, (typeof COMFORT_LEVELS)[number]>>;
  weekly: WeeklyWindow[];
  callsPerWeek: number;
  minNoticeHours: number;
  hourlyRateCents: number;
  flatFeesCents: Partial<Record<(typeof FLAT_FEE_KEYS)[number], number>>;
  quotePreference: (typeof QUOTE_PREFERENCES)[number];
  invoicingEntity: (typeof INVOICING)[number];
  bio: string;
  agreements: {
    licensedInGoodStanding: true;
    partnerTermsVersion: string;
    privacyVersion: string;
    carneVerification: true;
  };
}

export type FieldErrors = Record<string, string>;

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
const lower = (v: unknown) => str(v, 254).toLowerCase();
const intOf = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN);
const centsOf = (v: unknown): number | null | undefined => {
  if (v === null || v === undefined || v === "") return null;
  const n = intOf(v);
  return Number.isInteger(n) && n > 0 && n <= MAX_CENTS ? n : undefined;
};

/** True when the honeypot was filled or the form was sent too fast to be a person. */
export function looksAutomated(body: unknown): boolean {
  const o = (body && typeof body === "object" ? body : {}) as Doc;
  if (str(o.homepage)) return true;
  const elapsed = intOf(o.elapsedMs);
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < 2500;
}

/**
 * Validate an application body. Returns the cleaned application, or field
 * errors in plain words (keys match the form's field names).
 */
export function validateApplication(body: unknown, now = new Date()): { value: Application } | { errors: FieldErrors } {
  const o = (body && typeof body === "object" ? body : {}) as Doc;
  const e: FieldErrors = {};
  const year = now.getUTCFullYear();

  const country = o.country === undefined || o.country === "" ? "CR" : toCountryCode(o.country);
  if (!country) e.country = "Choose the country where you are licensed to practise.";
  const lic = licensingFor(country ?? "CR");
  const name = str(o.name, 120);
  if (name.length < 2) e.name = "Enter your full name as it appears on your licence.";
  const email = lower(o.email);
  if (!EMAIL_RE.test(email)) e.email = "Enter an email address you check, like name@yourfirm.com.";
  const phone = str(o.phone, 30);
  if (!PHONE_RE.test(phone)) e.phone = "Enter a mobile number with the country code, like +34 612 345 678.";
  const languages = [...new Set((Array.isArray(o.languages) ? o.languages : []).map((l) => lower(l)))]
    .filter((l): l is string => (APPLY_LANGUAGES as readonly string[]).includes(l));
  if (!languages.length) e.languages = "Choose at least one language you can hold a call in.";
  const city = str(o.city, 80);
  if (city.length < 2) e.city = "Enter the city or town where you work.";
  const province = str(o.province, 60);
  if (country === "CR" || !country) {
    if (!(CR_PROVINCES as readonly string[]).includes(province)) e.province = "Choose your province.";
  } else if (province.length < 2) e.province = "Enter the state, region or department where you work.";

  const carne = country === "CR" || !country ? str(o.carne, 20).replace(/[\s.-]/g, "") : str(o.carne, 24).replace(/\s+/g, "");
  if (country === "CR" || !country) {
    if (!CARNE_RE.test(carne)) e.carne = "Enter your carné number from the Colegio de Abogados y Abogadas, digits only.";
  } else if (!LICENCE_RE.test(carne)) e.carne = `Enter your ${lic.numberLabel.toLowerCase()} as it appears on your licence.`;
  const tzRaw = str(o.timezone, 60);
  if (tzRaw && !isTimeZone(tzRaw)) e.timezone = "Choose your time zone from the list.";
  const timezone = isTimeZone(tzRaw) ? tzRaw : COUNTRIES[country ?? "CR"].defaultTimeZone;
  const yearAdmitted = intOf(o.yearAdmitted);
  if (!Number.isInteger(yearAdmitted) || yearAdmitted < 1950 || yearAdmitted > year) {
    e.yearAdmitted = `Enter the year you were admitted, between 1950 and ${year}.`;
  }
  const notary = o.notary === true;
  if (o.notary !== true && o.notary !== false) e.notary = "Tell us whether you are a notary public.";
  const notaryCarne = notary ? str(o.notaryCarne, 20).replace(/[\s.-]/g, "") : "";
  if (notary && !CARNE_RE.test(notaryCarne)) e.notaryCarne = "Enter your notary number, digits only.";
  const firmName = str(o.firmName, 120);
  let firmWebsite = str(o.firmWebsite, 200);
  if (firmWebsite && !/^https?:\/\//i.test(firmWebsite)) firmWebsite = `https://${firmWebsite}`;
  if (firmWebsite && !/^https?:\/\/[^\s/.]+\.[^\s]+$/i.test(firmWebsite)) e.firmWebsite = "Enter a web address like yourfirm.cr, or leave it empty.";
  const yearsInPractice = intOf(o.yearsInPractice);
  if (!Number.isInteger(yearsInPractice) || yearsInPractice < 0 || yearsInPractice > 70) {
    e.yearsInPractice = "Enter your years in practice, from 0 to 70.";
  } else if (Number.isInteger(yearAdmitted) && yearsInPractice > year - yearAdmitted + 1) {
    e.yearsInPractice = "Your years in practice cannot be more than the years since you were admitted.";
  }

  const areas = [...new Set((Array.isArray(o.areas) ? o.areas : []).map((a) => lower(a)))]
    .filter((a): a is ApplyArea => (APPLY_AREAS as readonly string[]).includes(a));
  if (!areas.length) e.areas = "Choose at least one legal area.";
  const otherArea = areas.includes("other") ? str(o.otherArea, 120) : "";
  if (areas.includes("other") && otherArea.length < 2) e.otherArea = "Say which other area you work in.";
  const areaComfort: Application["areaComfort"] = {};
  const rawComfort = (o.areaComfort && typeof o.areaComfort === "object" ? o.areaComfort : {}) as Doc;
  for (const a of areas) {
    const c = lower(rawComfort[a]);
    if ((COMFORT_LEVELS as readonly string[]).includes(c)) areaComfort[a] = c as (typeof COMFORT_LEVELS)[number];
  }

  const minNoticeHours = intOf(o.minNoticeHours);
  if (!(NOTICE_HOURS as readonly number[]).includes(minNoticeHours)) e.minNoticeHours = "Choose how much notice you need before a call.";
  const callsPerWeek = intOf(o.callsPerWeek);
  if (!Number.isInteger(callsPerWeek) || callsPerWeek < 1 || callsPerWeek > 40) e.callsPerWeek = "Enter between 1 and 40 calls a week.";
  let weekly: WeeklyWindow[] = [];
  const hours = normalizeAvailability({ weekly: o.weekly, timezone }, "check", now);
  if ("error" in hours) e.weekly = hours.error;
  else if (!hours.value.weekly.length) e.weekly = "Add the hours of at least one day when members could book a call.";
  else weekly = hours.value.weekly;

  const hourly = centsOf(o.hourlyRateCents);
  if (!hourly) e.hourlyRateCents = "Enter your usual hourly rate in US dollars.";
  const flatFeesCents: Application["flatFeesCents"] = {};
  const rawFees = (o.flatFeesCents && typeof o.flatFeesCents === "object" ? o.flatFeesCents : {}) as Doc;
  for (const k of FLAT_FEE_KEYS) {
    const c = centsOf(rawFees[k]);
    if (c === undefined) e[`fee_${k}`] = "Enter an amount in US dollars, or leave it empty.";
    else if (c !== null) flatFeesCents[k] = c;
  }
  const quotePreference = lower(o.quotePreference);
  if (!(QUOTE_PREFERENCES as readonly string[]).includes(quotePreference)) e.quotePreference = "Choose how you prefer to quote.";
  const invoicingEntity = lower(o.invoicingEntity);
  if (!(INVOICING as readonly string[]).includes(invoicingEntity)) e.invoicingEntity = "Choose who sends the invoices.";

  const bio = typeof o.bio === "string" ? o.bio.trim().slice(0, BIO_MAX + 200) : "";
  if (bio.length < BIO_MIN) e.bio = `Write at least ${BIO_MIN} characters, so members know who they will talk to.`;
  else if (bio.length > BIO_MAX) e.bio = `Keep it to ${BIO_MAX} characters or fewer.`;

  const a = (o.agreements && typeof o.agreements === "object" ? o.agreements : {}) as Doc;
  if (a.licensedInGoodStanding !== true) e.licensedInGoodStanding = "Confirm that you are licensed and in good standing.";
  if (a.partnerTerms !== true) e.partnerTerms = "Read and accept the partner lawyer terms to apply.";
  else if (str(a.partnerTermsVersion) && str(a.partnerTermsVersion) !== PARTNER_TERMS_VERSION) {
    e.partnerTerms = "The partner terms changed while you were applying. Reload the page and accept the new version.";
  }
  if (a.privacy !== true) e.privacy = "Read and accept the privacy policy to apply.";
  else if (str(a.privacyVersion) && str(a.privacyVersion) !== LEGAL_VERSIONS.privacy) {
    e.privacy = "The privacy policy changed while you were applying. Reload the page and accept the new version.";
  }
  if (a.carneVerification !== true) {
    e.carneVerification = country === "CR" || !country
      ? "Allow us to check your carné with the Colegio, or we cannot review the application."
      : `Allow us to check your licence with the ${lic.body}, or we cannot review the application.`;
  }

  if (Object.keys(e).length) return { errors: e };
  return {
    value: {
      country: country as CountryCode,
      name,
      email,
      phone,
      languages,
      city,
      province,
      carne,
      timezone,
      yearAdmitted,
      notary,
      ...(notary ? { notaryCarne } : {}),
      ...(firmName ? { firmName } : {}),
      ...(firmWebsite ? { firmWebsite } : {}),
      yearsInPractice,
      areas,
      ...(otherArea ? { otherArea } : {}),
      areaComfort,
      weekly,
      callsPerWeek,
      minNoticeHours,
      hourlyRateCents: hourly as number,
      flatFeesCents,
      quotePreference: quotePreference as Application["quotePreference"],
      invoicingEntity: invoicingEntity as Application["invoicingEntity"],
      bio,
      agreements: {
        licensedInGoodStanding: true,
        partnerTermsVersion: PARTNER_TERMS_VERSION,
        privacyVersion: LEGAL_VERSIONS.privacy,
        carneVerification: true,
      },
    },
  };
}

// ─── Status rules ──────────────────────────────────────────────────────────

/** A provider's application status; providers created before T2 count as active unless switched off. */
export function providerStatus(p: Doc | null | undefined): ApplicationStatus | "inactive" {
  const s = p?.status;
  if (s === "pending_review" || s === "changes_requested" || s === "declined" || s === "active") return s;
  if (s === "inactive" || p?.active === false) return "inactive";
  return "active";
}

/** Members can book this lawyer: approved and switched on. */
export function isProviderBookable(p: Doc | null | undefined): boolean {
  return !!p && providerStatus(p) === "active" && p.active !== false;
}

/**
 * The application itself keeps this lawyer off the booking screens (in review,
 * changes requested or declined). Narrower than isProviderBookable on purpose:
 * lawyers switched off before T2 keep their existing booking behaviour.
 */
export function applicationBlocksCalls(p: Doc | null | undefined): boolean {
  const s = p?.status;
  return s === "pending_review" || s === "changes_requested" || s === "declined";
}

/** Why this provider may not sign in to the lawyer portal, or null when they may. */
export function providerLoginBlock(p: Doc | null | undefined): string | null {
  if (p && providerStatus(p) === "declined") {
    return "This application was not approved, so the lawyer portal is closed for this email. Write to ILP if you think this is a mistake.";
  }
  return null;
}

// ─── Records built from an application ─────────────────────────────────────

/** Provider areas the staff tools and routing know. */
export function providerAreas(app: Pick<Application, "areas">): string[] {
  return [...app.areas];
}

export function newProviderId(): string {
  return `prov_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;
}

export function applicationTaskId(providerId: string): string {
  return `task_lawyer_application__${providerId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** "Colegio de Abogados y Abogadas de Costa Rica, carné 12345" or the country's body and number. */
export function credentialsLine(app: Pick<Application, "country" | "carne" | "notary" | "notaryCarne">): string {
  const notary = app.notary ? `; notary ${app.notaryCarne}` : "";
  if (app.country === "CR") return `Colegio de Abogados y Abogadas de Costa Rica, carné ${app.carne}${notary}`;
  const lic = licensingFor(app.country);
  return `${lic.body}, ${lic.numberLabel.toLowerCase()} ${app.carne}${notary}`;
}

/** The fields an application writes on the provider doc. Never sets active: true. */
export function providerFieldsFrom(app: Application, nowIso: string): Doc {
  return {
    name: app.name,
    email: app.email,
    phone: app.phone,
    contactPerson: app.name,
    contacts: [{ name: app.name, email: app.email, phone: app.phone }],
    ...(app.firmWebsite ? { website: app.firmWebsite } : {}),
    legalAreas: providerAreas(app),
    jurisdictions: [app.country],
    country: app.country,
    timezone: app.timezone,
    languages: app.languages,
    credentials: credentialsLine(app),
    bio: app.bio,
    status: "pending_review" as ApplicationStatus,
    active: false,
    application: {
      submittedAt: nowIso,
      country: app.country,
      city: app.city,
      province: app.province,
      carne: app.carne,
      yearAdmitted: app.yearAdmitted,
      notary: app.notary,
      ...(app.notaryCarne ? { notaryCarne: app.notaryCarne } : {}),
      ...(app.firmName ? { firmName: app.firmName } : {}),
      ...(app.firmWebsite ? { firmWebsite: app.firmWebsite } : {}),
      yearsInPractice: app.yearsInPractice,
      areas: app.areas,
      ...(app.otherArea ? { otherArea: app.otherArea } : {}),
      areaComfort: app.areaComfort,
      callsPerWeek: app.callsPerWeek,
      minNoticeHours: app.minNoticeHours,
      hourlyRateCents: app.hourlyRateCents,
      flatFeesCents: app.flatFeesCents,
      quotePreference: app.quotePreference,
      invoicingEntity: app.invoicingEntity,
      agreements: { ...app.agreements, at: nowIso },
    },
    updatedAt: nowIso,
  };
}

/** The lawyer_availability doc from the submitted hours (routing stays blocked until approval). */
export function availabilityFrom(app: Application, providerId: string, now: Date): LawyerAvailability {
  const norm = normalizeAvailability(
    {
      weekly: app.weekly,
      minLeadHours: app.minNoticeHours,
      maxCallsPerDay: Math.min(6, Math.max(1, app.callsPerWeek)),
      specialties: app.areas.filter((a) => a !== "other"),
      timezone: app.timezone,
    },
    providerId,
    now,
    COUNTRIES[app.country].defaultTimeZone,
  );
  if ("error" in norm) throw new Error(norm.error);
  return norm.value;
}

export function reviewTaskFor(providerId: string, name: string, now: Date, ownerEmail?: string): CsmTask & Doc {
  return {
    id: applicationTaskId(providerId),
    clientId: providerId,
    type: "follow_up",
    title: `Review lawyer application: ${name}`,
    dueAt: new Date(now.getTime() + 24 * 3600_000).toISOString(),
    status: "open",
    source: { kind: "manual", id: providerId },
    subject: { kind: "lawyer_application", providerId },
    link: "/dashboard/lawyers#applications",
    createdAt: now.toISOString(),
    ...(ownerEmail ? { ownerEmail } : {}),
  };
}

export function consentsFor(app: Application, now: Date, id: () => string): ConsentRecord[] {
  const at = now.toISOString();
  return [
    { id: id(), email: app.email, kind: "terms", granted: true, version: app.agreements.partnerTermsVersion, source: "lawyer_application", at },
    { id: id(), email: app.email, kind: "privacy", granted: true, version: app.agreements.privacyVersion, source: "lawyer_application", at },
  ];
}

// ─── Flows ─────────────────────────────────────────────────────────────────

export interface Actor {
  uid: string;
  email: string;
  role: string;
}

export interface ApplyDeps {
  now: () => Date;
  findProviderByEmail: (email: string) => Promise<Doc | null>;
  getProvider: (id: string) => Promise<Doc | null>;
  writeProvider: (id: string, fields: Doc, create: boolean) => Promise<void>;
  writeAvailability: (providerId: string, doc: LawyerAvailability) => Promise<void>;
  getTask: (id: string) => Promise<Doc | null>;
  writeTask: (id: string, fields: Doc, create: boolean) => Promise<void>;
  writeConsent: (record: ConsentRecord) => Promise<void>;
  audit: (entry: { actor: Actor; action: string; target: string; meta?: Doc }) => Promise<void>;
  sendEmail: (msg: { to: string; subject: string; html: string; text: string }, dedupeKey: string) => Promise<void>;
  emails: {
    received: (o: { name: string; signInUrl: string; country?: CountryCode }) => { subject: string; html: string; text: string };
    approved: (o: { name: string; signInUrl: string }) => { subject: string; html: string; text: string };
    changes: (o: { name: string; note: string; applyUrl: string; signInUrl: string }) => { subject: string; html: string; text: string };
    declined: (o: { name: string; reason: string }) => { subject: string; html: string; text: string };
  };
  urls: { signIn: string; apply: string };
  ownerEmail?: string;
  consentId: () => string;
}

export type SubmitResult =
  | { status: 201; body: { ok: true; providerId: string; status: ApplicationStatus; resubmitted?: boolean } }
  | { status: 202; body: { ok: true } }
  | { status: 400; body: { error: string; errors: FieldErrors } }
  | { status: 409; body: { error: string; code: "exists"; status: ApplicationStatus | "inactive" } };

const firstName = (name: string) => name.split(" ")[0] || name;

/**
 * Submit an application. Honeypot hits get a 202 and nothing is written.
 * A new email creates a provider in pending_review with its availability,
 * a review task, consent records, an audit entry and a confirmation email.
 * An email in changes_requested resubmits; any other existing email is 409.
 */
export async function submitApplication(body: unknown, deps: ApplyDeps, ip?: string): Promise<SubmitResult> {
  if (looksAutomated(body)) return { status: 202, body: { ok: true } };
  const now = deps.now();
  const checked = validateApplication(body, now);
  if ("errors" in checked) {
    return { status: 400, body: { error: "Some answers need a fix. Each one is marked on the form.", errors: checked.errors } };
  }
  const app = checked.value;
  const existing = await deps.findProviderByEmail(app.email);
  const existingStatus = existing ? providerStatus(existing) : null;
  if (existing && existingStatus !== "changes_requested") {
    return {
      status: 409,
      body: {
        error: "We already have a lawyer account or application for this email. Sign in to the lawyer portal to see it.",
        code: "exists",
        status: existingStatus as ApplicationStatus | "inactive",
      },
    };
  }

  const providerId = existing ? String(existing.id) : newProviderId();
  const nowIso = now.toISOString();
  const fields = providerFieldsFrom(app, nowIso);
  if (existing) {
    fields.reviewNote = null;
  } else {
    Object.assign(fields, { id: providerId, createdAt: nowIso, createdBy: "lawyer_application", source: "lawyer_application" });
  }
  await deps.writeProvider(providerId, fields, !existing);
  await deps.writeAvailability(providerId, availabilityFrom(app, providerId, now));

  const taskId = applicationTaskId(providerId);
  const task = reviewTaskFor(providerId, app.name, now, deps.ownerEmail);
  const oldTask = await deps.getTask(taskId);
  if (!oldTask) await deps.writeTask(taskId, task, true);
  else await deps.writeTask(taskId, { status: "open", title: task.title, dueAt: task.dueAt, outcome: null, closedAt: null }, false);

  for (const c of consentsFor(app, now, deps.consentId)) await deps.writeConsent(c);
  await deps.audit({
    actor: { uid: app.email, email: app.email, role: "lawyer_applicant" },
    action: existing ? "provider.application_resubmitted" : "provider.applied",
    target: `providers/${providerId}`,
    meta: { areas: app.areas, notary: app.notary, taskId, ...(ip ? { ip } : {}) },
  });
  const mail = deps.emails.received({ name: firstName(app.name), signInUrl: deps.urls.signIn, country: app.country });
  await deps.sendEmail({ to: app.email, ...mail }, `lawyer_apply_${providerId}_${nowIso.slice(0, 13)}`);
  return { status: 201, body: { ok: true, providerId, status: "pending_review", ...(existing ? { resubmitted: true } : {}) } };
}

export type ReviewAction = "approve" | "request_changes" | "decline";

export type ReviewResult =
  | { status: 200; body: { ok: true; status: ApplicationStatus } }
  | { status: 400 | 404 | 409; body: { error: string } };

/** Staff review. Approve is the only path to active: true. Every outcome is audited and emailed. */
export async function reviewApplication(
  providerId: string,
  input: unknown,
  actor: Actor,
  deps: ApplyDeps,
): Promise<ReviewResult> {
  const o = (input && typeof input === "object" ? input : {}) as Doc;
  const action = str(o.action) as ReviewAction;
  if (!["approve", "request_changes", "decline"].includes(action)) {
    return { status: 400, body: { error: "Choose approve, request changes or decline." } };
  }
  const note = typeof o.note === "string" ? o.note.trim().slice(0, 1500) : "";
  if ((action === "request_changes" || action === "decline") && note.length < 5) {
    return {
      status: 400,
      body: { error: action === "decline" ? "Write the reason for declining. The lawyer reads it in the email." : "Write what the lawyer should change. They read it in the email." },
    };
  }
  const p = await deps.getProvider(providerId);
  if (!p) return { status: 404, body: { error: "Application not found." } };
  const current = providerStatus(p);
  if (current !== "pending_review" && current !== "changes_requested") {
    return { status: 409, body: { error: `This application is already ${current === "declined" ? "declined" : "approved"}.` } };
  }

  const now = deps.now();
  const nowIso = now.toISOString();
  const name = String(p.name ?? "");
  const email = String(p.email ?? "");
  const next: ApplicationStatus = action === "approve" ? "active" : action === "decline" ? "declined" : "changes_requested";
  const fields: Doc = { status: next, reviewedAt: nowIso, reviewedBy: actor.email, updatedAt: nowIso, updatedBy: actor.email };
  if (action === "approve") Object.assign(fields, { active: true, activatedAt: nowIso, reviewNote: null });
  if (action === "decline") Object.assign(fields, { active: false, declineReason: note, reviewNote: null });
  if (action === "request_changes") Object.assign(fields, { active: false, reviewNote: note });
  await deps.writeProvider(providerId, fields, false);

  const taskId = applicationTaskId(providerId);
  if (await deps.getTask(taskId)) {
    const outcome = action === "approve" ? "Approved" : action === "decline" ? `Declined: ${note}` : `Asked for changes: ${note}`;
    await deps.writeTask(taskId, { status: "done", outcome, closedAt: nowIso }, false);
  }
  await deps.audit({
    actor,
    action: `provider.application_${action === "approve" ? "approved" : action === "decline" ? "declined" : "changes_requested"}`,
    target: `providers/${providerId}`,
    meta: { from: current, to: next, ...(note ? { note } : {}) },
  });
  if (email) {
    const first = firstName(name);
    const mail = action === "approve"
      ? deps.emails.approved({ name: first, signInUrl: deps.urls.signIn })
      : action === "decline"
      ? deps.emails.declined({ name: first, reason: note })
      : deps.emails.changes({ name: first, note, applyUrl: deps.urls.apply, signInUrl: deps.urls.signIn });
    await deps.sendEmail({ to: email, ...mail }, `lawyer_review_${providerId}_${action}_${nowIso.slice(0, 16)}`);
  }
  return { status: 200, body: { ok: true, status: next } };
}
