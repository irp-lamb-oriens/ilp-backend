/**
 * contracts.ts — shared data contracts for the ILP member core loop.
 * ──────────────────────────────────────────────────────────────────────────
 * Two identical copies live in the repo:
 *   server/schemas/contracts.ts      (Deno)
 *   frontend/src/lib/contracts.ts    (Next.js)
 * Keep them byte-identical. Only workstream W1 (Foundation) edits them; other
 * workstreams request changes in docs/workstreams/W<n>.md.
 *
 * Every record below is a TOP-LEVEL Firestore collection keyed by `id` and
 * carrying `clientId` (the existing `clients` doc id), so it can be queried
 * across members and edited without overwriting the client document.
 * Timestamps are ISO-8601 strings. Money is integer cents (USD).
 *
 * See docs/PLAN.md for the loop these records serve.
 */

// ─── Collection names ──────────────────────────────────────────────────────
export const COLLECTIONS = {
  clients: "clients", // existing person record (unchanged)
  leads: "leads",
  memberships: "memberships",
  matters: "matters",
  consultations: "consultations",
  handoffs: "handoffs",
  csmTasks: "csm_tasks",
  obligations: "obligations",
  auditLog: "audit_log", // existing
  availability: "lawyer_availability", // one doc per providerId
  funnelEvents: "funnel_events",
  feedback: "member_feedback",
  opportunities: "opportunities",
  privacyRequests: "privacy_requests",
  consents: "consents",
  journeyEvents: "journey_events",
  journeyDaily: "journey_daily",
  experiments: "experiments",
  outreach: "outreach",
  journeyExposures: "journey_exposures", // one doc per experiment × visitor (built by the aggregation job)
} as const;

export type Iso = string;
export type CountryCode = "CO" | "CR" | "PA" | "MX" | "ES" | "PT";

// ─── Countries (all six open; reference data from docs/research/<country>.md) ─
/** Display order: alphabetical by English name. */
export const COUNTRY_CODES: readonly CountryCode[] = ["CO", "CR", "MX", "PA", "PT", "ES"];

export interface CountryTimeZone {
  id: string; // IANA, e.g. "Europe/Madrid"
  label: string; // plain English, e.g. "Mainland Spain and the Balearic Islands"
}

export interface CountryBody {
  name: string;
  url?: string; // only where the research opened or confirmed the page
}

export interface CountryInfo {
  code: CountryCode;
  name: string; // English name, no flag
  slug: string; // landing page path, e.g. "costa-rica"
  adjective: string; // "Costa Rican", for copy like "a Costa Rican company"
  status: "open"; // every country is open for the check, joining and booking
  currency: { code: string; name: string };
  languages: string[]; // official first, then co-official
  timeZones: CountryTimeZone[]; // first is the default
  defaultTimeZone: string;
  foreignerIds: string[]; // the IDs a foreign resident deals with
  companyForms: string[]; // local company forms, e.g. "S.A.S."
  lawyerBody: CountryBody & { numberLabel: string; verifyUrl?: string };
  notaryBody: CountryBody;
}

export const COUNTRIES: Record<CountryCode, CountryInfo> = {
  CO: {
    code: "CO",
    name: "Colombia",
    slug: "colombia",
    adjective: "Colombian",
    status: "open",
    currency: { code: "COP", name: "Colombian peso" },
    languages: ["Spanish"],
    timeZones: [{ id: "America/Bogota", label: "Colombia" }],
    defaultTimeZone: "America/Bogota",
    foreignerIds: ["Cédula de extranjería", "Visa (e-visa)", "NIT and RUT (tax ID)", "Salvoconducto"],
    companyForms: ["S.A.S.", "S.A.", "Ltda."],
    lawyerBody: {
      name: "Consejo Superior de la Judicatura, Registro Nacional de Abogados",
      url: "https://www.ramajudicial.gov.co/web/registro-nacional-de-abogados",
      numberLabel: "Tarjeta profesional number",
      verifyUrl: "https://vigenciaspublicas.ramajudicial.gov.co/Certificados.aspx",
    },
    notaryBody: { name: "Superintendencia de Notariado y Registro (SNR)", url: "https://www.supernotariado.gov.co" },
  },
  CR: {
    code: "CR",
    name: "Costa Rica",
    slug: "costa-rica",
    adjective: "Costa Rican",
    status: "open",
    currency: { code: "CRC", name: "Costa Rican colón" },
    languages: ["Spanish"],
    timeZones: [{ id: "America/Costa_Rica", label: "Costa Rica" }],
    defaultTimeZone: "America/Costa_Rica",
    foreignerIds: ["DIMEX", "NITE (tax ID without a DIMEX)", "Cédula jurídica (company ID)"],
    companyForms: ["S.A.", "S.R.L."],
    lawyerBody: { name: "Colegio de Abogados y Abogadas de Costa Rica", url: "https://www.abogados.or.cr", numberLabel: "Carné number" },
    notaryBody: { name: "Dirección Nacional de Notariado (DNN)" },
  },
  PA: {
    code: "PA",
    name: "Panama",
    slug: "panama",
    adjective: "Panamanian",
    status: "open",
    currency: { code: "USD", name: "US dollar (balboa pegged 1:1)" },
    languages: ["Spanish"],
    timeZones: [{ id: "America/Panama", label: "Panama" }],
    defaultTimeZone: "America/Panama",
    foreignerIds: ["Carné de residente", "Cédula E", "RUC and NIT (tax IDs)"],
    companyForms: ["S.A.", "Fundación de interés privado", "S. de R.L."],
    lawyerBody: {
      name: "Corte Suprema de Justicia, Sala Cuarta de Negocios Generales (idoneidad)",
      url: "https://www.organojudicial.gob.pa/",
      numberLabel: "Idoneidad number",
    },
    notaryBody: { name: "Notarías públicas de Panamá" },
  },
  MX: {
    code: "MX",
    name: "Mexico",
    slug: "mexico",
    adjective: "Mexican",
    status: "open",
    currency: { code: "MXN", name: "Mexican peso" },
    languages: ["Spanish"],
    timeZones: [
      { id: "America/Mexico_City", label: "Central Mexico (most of the country)" },
      { id: "America/Cancun", label: "Quintana Roo" },
      { id: "America/Mazatlan", label: "Baja California Sur, Sinaloa and Nayarit" },
      { id: "America/Hermosillo", label: "Sonora" },
      { id: "America/Tijuana", label: "Baja California" },
    ],
    defaultTimeZone: "America/Mexico_City",
    foreignerIds: ["FMM (visitor record)", "Tarjeta de Residente Temporal", "Tarjeta de Residente Permanente", "CURP", "RFC (tax ID)", "e.firma"],
    companyForms: ["S.A. de C.V.", "S. de R.L. de C.V."],
    lawyerBody: {
      name: "Secretaría de Educación Pública, Dirección General de Profesiones",
      url: "https://www.cedulaprofesional.sep.gob.mx",
      numberLabel: "Cédula profesional number",
    },
    notaryBody: { name: "State notary colleges and the Colegio Nacional del Notariado Mexicano", url: "https://www.notariadomexicano.org.mx" },
  },
  ES: {
    code: "ES",
    name: "Spain",
    slug: "spain",
    adjective: "Spanish",
    status: "open",
    currency: { code: "EUR", name: "Euro" },
    languages: ["Spanish", "Catalan", "Galician", "Basque"],
    timeZones: [
      { id: "Europe/Madrid", label: "Mainland Spain and the Balearic Islands" },
      { id: "Atlantic/Canary", label: "Canary Islands" },
    ],
    defaultTimeZone: "Europe/Madrid",
    foreignerIds: ["NIE (foreigner number)", "TIE (residence card)", "Padrón (town hall registration)"],
    companyForms: ["S.L.", "S.A."],
    lawyerBody: {
      name: "A Colegio de Abogados (Consejo General de la Abogacía Española census)",
      url: "https://www.abogacia.es/servicios-abogacia/censo-de-letrados/",
      numberLabel: "Colegiado number",
    },
    notaryBody: { name: "Consejo General del Notariado", url: "https://www.notariado.org/" },
  },
  PT: {
    code: "PT",
    name: "Portugal",
    slug: "portugal",
    adjective: "Portuguese",
    status: "open",
    currency: { code: "EUR", name: "Euro" },
    languages: ["Portuguese"],
    timeZones: [
      { id: "Europe/Lisbon", label: "Mainland Portugal and Madeira" },
      { id: "Atlantic/Azores", label: "Azores" },
    ],
    defaultTimeZone: "Europe/Lisbon",
    foreignerIds: ["NIF (tax number)", "NISS (social security number)", "Número de utente (health number)", "Título de residência (AIMA)"],
    companyForms: ["Lda.", "Unipessoal Lda.", "S.A."],
    lawyerBody: {
      name: "Ordem dos Advogados",
      url: "https://portal.oa.pt/advogados/pesquisa-de-advogados/",
      numberLabel: "Cédula profissional number",
    },
    notaryBody: { name: "Ordem dos Notários", url: "https://www.notarios.pt" },
  },
};

export const isCountryCode = (v: unknown): v is CountryCode =>
  typeof v === "string" && (COUNTRY_CODES as readonly string[]).includes(v);

/**
 * A stored country value to a code: codes ("cr", "CR"), English or Spanish
 * names ("Costa Rica", "Panamá", "España"). Older records hold "CR" or the
 * name "Costa Rica", so both keep working. Unknown values give null.
 */
export function toCountryCode(v: unknown): CountryCode | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  const up = s.toUpperCase();
  if (isCountryCode(up)) return up;
  const plain = s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s*\(.*\)$/, "");
  const alias: Record<string, CountryCode> = { espana: "ES", "costa rica": "CR", panama: "PA", mexico: "MX", colombia: "CO", spain: "ES", portugal: "PT" };
  if (alias[plain]) return alias[plain];
  for (const c of COUNTRY_CODES) if (COUNTRIES[c].name.toLowerCase() === plain || COUNTRIES[c].slug === plain) return c;
  return null;
}

/** English name of a code; the code itself when unknown. */
export const countryName = (code: unknown): string => {
  const c = toCountryCode(code);
  return c ? COUNTRIES[c].name : String(code ?? "");
};

// ─── Pricing (master plan section 6) ───────────────────────────────────────
export const PLAN_STANDARD = {
  id: "standard",
  monthlyCents: 7999,
  activationCents: 10000,
  minutesIncluded: 60,
  callsIncluded: 3,
  callLengthMin: 20,
} as const;

// ─── Roles ─────────────────────────────────────────────────────────────────
export type Role = "client" | "lawyer" | "staff" | "csm" | "admin";

// ─── Lead (free deadline check) ────────────────────────────────────────────
export interface LeadFinding {
  ruleId: string;
  title: string; // plain language, "may require review"
  dueAt?: Iso;
  area: string; // e.g. "corporate", "property", "immigration", "vehicle"
  windowStartAt?: Iso; // when the date is a window (or a by-ID-digit range), its first day
  confidence?: "high" | "medium" | "low"; // research confidence; "low" shows "Ask your lawyer to confirm this date"
  dueText?: string; // plain due rule, shown when there is no date (ongoing, event, unknown anchor)
}

export interface Lead {
  id: string;
  email: string;
  name?: string;
  country: CountryCode;
  answers: Record<string, string | boolean | number | string[]>; // the country's question keys (multi-choice answers are lists)
  findings: LeadFinding[];
  source: string; // "deadline_check" | "alert" | "template" | ...
  createdAt: Iso;
  convertedClientId?: string;
  convertedAt?: Iso;
}

// ─── Membership ────────────────────────────────────────────────────────────
export type MembershipStatus = "pending" | "active" | "past_due" | "cancelled";

export interface Membership {
  id: string;
  clientId: string;
  plan: typeof PLAN_STANDARD.id;
  status: MembershipStatus;
  country: CountryCode;
  activationPaidAt?: Iso;
  activatedAt?: Iso; // first moment status became active (cohort key)
  periodStart: Iso;
  periodEnd: Iso;
  minutesIncluded: number;
  minutesUsed: number;
  callsIncluded: number;
  callsUsed: number;
  csmEmail?: string;
  paymentRef?: string; // Stripe id or "manual"
  sourceLeadId?: string; // lead that converted into this membership (free check)
  intake?: JoinIntake; // T3: "what you need first" from the join form; becomes the first matter on activation
  firstMatterId?: string; // T3: matter created from `intake` when the membership activated
  cancelledAt?: Iso;
  cancelAtPeriodEnd?: boolean; // member asked to cancel; access runs to periodEnd
  cancelReason?: string;
  pastDueSince?: Iso; // first failed payment of the current period
  createdAt: Iso;
  updatedAt: Iso;
}

// ─── Matter (many per client) ──────────────────────────────────────────────
export interface NextStep {
  what: string;
  who: "client" | "lawyer" | "ilp";
  dueAt?: Iso;
}

export interface Matter {
  id: string;
  clientId: string;
  title: string;
  area: string;
  country: CountryCode;
  stage: string; // stage id from stage config
  stageEnteredAt: Iso;
  assignedProviderId?: string;
  nextStep?: NextStep;
  nextStepSetAt?: Iso;
  openedAt: Iso;
  closedAt?: Iso;
  // T3: a matter opened from the join form
  source?: "join" | string;
  question?: string; // the member's main question for the first call
  deadlineAt?: Iso; // a date the member said the matter must meet
  documentsOnHand?: DocumentOnHand[];
}

// ─── Join intake (T3: "What you need first" on /join) ─────────────────────
/** Documents a new member says they already have. An empty list means "none yet". No uploads at join. */
export const DOCUMENTS_ON_HAND = ["passport", "dimex", "property_title", "company_books", "vehicle_papers"] as const;
export type DocumentOnHand = (typeof DOCUMENTS_ON_HAND)[number];

export interface JoinIntake {
  question: string; // main question for the first call
  urgency: "deadline" | "soon" | "no_rush";
  deadlineAt?: Iso; // when urgency = deadline
  documentsOnHand: DocumentOnHand[]; // [] = none yet
  findings?: LeadFinding[]; // check findings from the join answers; seeded as obligations on activation
  submittedAt: Iso;
}

// ─── Consultation ──────────────────────────────────────────────────────────
export type ConsultationStatus =
  | "booked"
  | "in_progress"
  | "completed"
  | "no_show"
  | "cancelled";

export type ConsentState = "pending" | "granted" | "declined";

export interface Consultation {
  id: string;
  clientId: string;
  matterId?: string;
  providerId: string;
  scheduledAt: Iso;
  durationMin: number; // booked length, default 20
  minutesUsed?: number; // actual, charged against membership
  status: ConsultationStatus;
  question?: string; // what the member wants to ask
  consent: { recording: ConsentState; at?: Iso; by?: string; where?: string }; // by: role that answered; where: booking | join | privacy_page | …
  transcript?: string;
  transcriptSource?: string; // e.g. "meet_transcript", "upload", "pasted"
  transcriptFetchedAt?: Iso;
  transcriptFetchAttempts?: number; // Meet transcript sweep, gives up after a few
  summary?: { text: string; status: "suggested" | "confirmed"; confirmedAt?: Iso };
  suggestedNextSteps?: LegalNextStep[]; // AI draft with the suggested summary; lawyer confirms
  handoffId?: string;
  endedAt?: Iso;
  meetUrl?: string; // Google Meet link from the calendar event
  calendarEventId?: string;
  remindersSent?: string[]; // e.g. ["24h", "1h"]
  rating?: { score: 1 | 2 | 3 | 4 | 5; comment?: string; at: Iso }; // member, after the call
  // Call lifecycle (P3, API/calls)
  bookedBy?: string;
  calendarError?: string | null; // last Calendar/Meet failure; null once retried OK
  chargedAt?: Iso; // minutes charged to the membership
  restoredAt?: Iso; // staff gave the call back (e.g. no-show forgiven)
  noShowAt?: Iso;
  noShowMarkedBy?: string;
  cancelledAt?: Iso;
  cancelledBy?: string;
  rescheduledAt?: Iso;
  rescheduledBy?: string;
  previousScheduledAt?: Iso;
  createdAt: Iso;
}

// ─── Handoff (lawyer judgment ≠ commercial follow-up) ─────────────────────
export interface LegalNextStep {
  what: string;
  who: "client" | "lawyer" | "ilp";
  dueAt?: Iso;
}

export interface Handoff {
  id: string;
  consultationId: string;
  clientId: string;
  matterId?: string;
  providerId: string;
  legalNextSteps: LegalNextStep[]; // client-visible
  commercialNotes?: string; // staff/CSM only — never sent to client or lawyer views
  approvedAt: Iso;
  csmTaskIds: string[];
}

// ─── CSM task ──────────────────────────────────────────────────────────────
export type CsmTaskType =
  | "onboarding"
  | "follow_up"
  | "missing_document"
  | "proposal"
  | "renewal"
  | "escalation"
  | "privacy"; // P6/P7: data-rights request with a legal deadline

export type CsmTaskStatus = "open" | "done" | "cancelled";

export interface CsmTask {
  id: string;
  clientId: string;
  matterId?: string;
  ownerEmail?: string;
  type: CsmTaskType;
  title: string;
  dueAt: Iso;
  status: CsmTaskStatus;
  outcome?: string; // required when status = done
  source: { kind: "membership" | "consultation" | "handoff" | "quote" | "document" | "privacy_request" | "obligation" | "manual"; id?: string };
  createdAt: Iso;
  closedAt?: Iso;
}

/** Server events that create CSM tasks automatically (W1 implements). */
export const TASK_RULES: Record<string, { type: CsmTaskType; dueInHours: number; title: string }> = {
  "membership.activated": { type: "onboarding", dueInHours: 24, title: "Welcome call and profile review" },
  "consultation.booked": { type: "follow_up", dueInHours: 24, title: "Check profile is consultation-ready" },
  "handoff.approved": { type: "follow_up", dueInHours: 24, title: "Send next steps and confirm with member" },
  "handoff.opportunity": { type: "proposal", dueInHours: 48, title: "Prepare proposal" }, // handoff carries commercialNotes
  "document.missing_3d": { type: "missing_document", dueInHours: 48, title: "Chase missing document" },
  "quote.unanswered_5d": { type: "proposal", dueInHours: 48, title: "Follow up on open proposal" },
  "membership.renewal_7d": { type: "renewal", dueInHours: 72, title: "Renewal check-in" },
  "membership.past_due": { type: "escalation", dueInHours: 24, title: "Payment failed: contact member" }, // P2 lifecycle
  "membership.cancel_requested": { type: "renewal", dueInHours: 24, title: "Cancellation requested: save call" }, // P2 cancel
  "feedback.low_score": { type: "follow_up", dueInHours: 24, title: "Low rating: follow up" }, // P2 post-call ≤ 2 or monthly ≤ 6
  "call.link_failed": { type: "follow_up", dueInHours: 4, title: "Meet link failed: send link" }, // P3 calendar failure
  "privacy.request_received": { type: "privacy", dueInHours: 24, title: "Privacy request: respond by due date" }, // P6 data-rights request
  "member.unassigned_country": { type: "follow_up", dueInHours: 24, title: "Match a lawyer licensed in the member's country" }, // COUNTRIES: no partner lawyer in the member's country yet
  "obligation.needs_date_7d": { type: "follow_up", dueInHours: 72, title: "Help the member set dates for their deadlines" }, // DEADLINES: needsDate items older than 7 days
  "call.outcome_missing": { type: "follow_up", dueInHours: 24, title: "Call not wrapped up: confirm the outcome and handoff with the lawyer" }, // REL: still booked a day after its end, or completed without a handoff after two days
};

// ─── Obligation (configurable rules, no hard-coded country logic) ──────────
/** DEADLINES: where an obligation came from. Older records have none (read as "check"). */
export type ObligationSource = "check" | "picker" | "lawyer" | "staff";
export const OBLIGATION_SOURCES: readonly ObligationSource[] = ["check", "picker", "lawyer", "staff"];

export interface Obligation {
  id: string;
  clientId: string;
  country: CountryCode;
  ruleId: string;
  title: string; // worded as "may require review"
  dueAt?: Iso; // computed from the rule and the person's answers
  status: "upcoming" | "asked" | "handled" | "dismissed";
  windowStartAt?: Iso;
  confidence?: "high" | "medium" | "low"; // "low": members see "Ask your lawyer to confirm this date", not the date
  dueText?: string;
  // DEADLINES: the person's own list (free check selection, picker, Deadlines page)
  area?: string; // the rule's area, copied so lists can filter by it
  source?: ObligationSource;
  userDueAt?: Iso | null; // a date the person set; shown and reminded instead of dueAt
  needsDate?: boolean; // no computed date, or a low-confidence one: the person is asked to set one
  remind?: boolean; // reminder emails at 30 and 7 days; absent = true
  dismissedAt?: Iso | null; // removed from the list by the person (status "dismissed"); undo clears it
  notes?: string; // the person's own note, up to 500 characters
  createdAt?: Iso;
  updatedAt?: Iso;
}

/** DEADLINES: the date shown and reminded for an obligation: the person's own date, else the computed one. */
export function obligationDueAt(o: Pick<Obligation, "dueAt" | "userDueAt">): Iso | undefined {
  return o.userDueAt || o.dueAt || undefined;
}

/** DEADLINES: true when the obligation still has no date the person can rely on. */
export function obligationNeedsDate(o: Pick<Obligation, "dueAt" | "userDueAt" | "confidence" | "needsDate">): boolean {
  if (o.userDueAt) return false;
  return o.needsDate === true || !o.dueAt || o.confidence === "low";
}

// ─── Account type (DEADLINES: free accounts) ──────────────────────────────
/**
 * A person who saves deadlines from the free check gets a free ILP account:
 * a client record with `accountType: "free"` and no paid membership. They
 * sign in to /status and see Overview, Deadlines, Profile and Privacy.
 * Joining later upgrades the same record (`accountType: "member"`).
 */
export type AccountType = "free" | "member";
export const ACCOUNT_TYPE_FIELD = "accountType";

/** Error code a member-only route answers a free account with (HTTP 402). */
export const MEMBERSHIP_REQUIRED = "membership_required";

/** "member" when a membership other than an unpaid one exists; "free" only for records marked free. Older records stay members. */
export function accountTypeOf(client: Record<string, unknown> | null | undefined, membership: Pick<Membership, "status"> | null | undefined): AccountType {
  if (membership && membership.status !== "pending") return "member";
  return client?.[ACCOUNT_TYPE_FIELD] === "free" ? "free" : "member";
}

/**
 * The member's answers to their country's situation questions (the free
 * check's questions plus the profile-only ones), stored on the client record
 * under this key as { [questionKey]: string }. Keys and values are listed per
 * country by GET /api/countries/:code/questions (server API/countries/rules).
 */
export const COUNTRY_ANSWERS_FIELD = "countryAnswers";

// ─── Profile completeness (one function, all three portals) ───────────────
export const PROFILE_SECTIONS = [
  "identity",
  "household",
  "immigration",
  "property",
  "company",
  "vehicle",
] as const;
export type ProfileSection = (typeof PROFILE_SECTIONS)[number];

/** Section → field keys on the client record that count toward completion. */
export const PROFILE_FIELDS: Record<ProfileSection, string[]> = {
  identity: ["fullName", "email", "phone", "nationality", "dateOfBirth"],
  household: ["maritalStatus", "dependents"],
  immigration: ["residencyStatus", "residencyExpiresAt"],
  property: ["ownsProperty", "propertyLocation"],
  company: ["hasCompany", "companyType"],
  vehicle: ["ownsVehicle"],
};

/**
 * T3: more profile keys on the client record, shown and editable with their
 * section and filled by the join form. They do NOT count toward
 * profileCompleteness: they are optional or apply only to some members.
 */
export const PROFILE_DETAIL_FIELDS: Record<ProfileSection, string[]> = {
  identity: ["preferredName", "preferredLanguage", "legalCountry", "residenceCountry", "residenceProvince", "residenceTown", "timezone"], // legalCountry: CountryCode the membership covers
  household: ["livesWithPartner", "childrenAtHome", "otherHousehold", "pets", "hasEmployees"],
  immigration: ["residencyCategory", "lastEntryDate"],
  property: ["propertyType", "propertyHolding"],
  company: ["companyCount", "companyUpToDate"],
  vehicle: ["marchamoStatus"],
};

/** Consultation-ready when at least this share of fields is filled. */
export const CONSULTATION_READY_THRESHOLD = 0.7;

export function profileCompleteness(record: Record<string, unknown>): {
  score: number; // 0..1
  bySection: Record<ProfileSection, number>;
  consultationReady: boolean;
} {
  const filled = (v: unknown) =>
    v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
  let total = 0;
  let done = 0;
  const bySection = {} as Record<ProfileSection, number>;
  for (const s of PROFILE_SECTIONS) {
    const keys = PROFILE_FIELDS[s];
    const n = keys.filter((k) => filled(record[k])).length;
    bySection[s] = keys.length ? n / keys.length : 1;
    total += keys.length;
    done += n;
  }
  const score = total ? done / total : 0;
  return { score, bySection, consultationReady: score >= CONSULTATION_READY_THRESHOLD };
}

// ─── Field visibility (master plan sections 9, 24.1) ──────────────────────
/** Fields that must never appear in a lawyer (provider) API response. */
export const LAWYER_HIDDEN_FIELDS = [
  "costSubtotal",
  "marginPct",
  "margin",
  "platformFee",
  "commercialNotes",
] as const;

/** Fields that must never appear in a client API response. */
export const CLIENT_HIDDEN_FIELDS = [
  "costSubtotal",
  "marginPct",
  "margin",
  "earnings",
  "commercialNotes",
  "priorityRank",
] as const;


// ─── Lawyer availability (feeds booking slots) ────────────────────────────
export interface WeeklyWindow {
  day: 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday, in the lawyer's own time zone
  start: string; // "08:30"
  end: string; // "12:00"
}

export interface LawyerAvailability {
  id: string; // = providerId
  providerId: string;
  timezone: string; // IANA; defaults to the lawyer's country (COUNTRIES[c].defaultTimeZone), older docs hold "America/Costa_Rica"
  weekly: WeeklyWindow[];
  blackoutDates: string[]; // "2026-12-24"
  minLeadHours: number; // default 18
  maxCallsPerDay: number; // default 6
  specialties: string[]; // legal areas, used for routing
  calendarId?: string | null; // lawyer's Google Calendar for busy times; null = ILP calendar only
  updatedAt: Iso;
}

// ─── Funnel + feedback (PMF measurement) ──────────────────────────────────
export type FunnelStep =
  | "check_started"
  | "check_completed"
  | "check_email_given"
  | "join_started"
  | "join_paid"
  | "first_call_booked";

export interface FunnelEvent {
  id: string;
  step: FunnelStep;
  anonId: string; // random id kept in the browser, no PII
  leadId?: string;
  clientId?: string;
  source?: string; // utm_source or referrer host
  at: Iso;
}

export interface MemberFeedback {
  id: string;
  clientId: string;
  kind: "post_call" | "monthly" | "cancel";
  consultationId?: string;
  score?: number; // 1-5 post_call; 0-10 monthly (likelihood to recommend)
  comment?: string;
  at: Iso;
}


// ─── Opportunity (paid legal work beyond the membership; plan sections 15, 17.1) ─
export type OpportunityStage = "identified" | "quoted" | "negotiating" | "won" | "lost";

export interface Opportunity {
  id: string;
  clientId: string;
  matterId?: string;
  source: { kind: "handoff" | "consultation" | "obligation" | "manual"; id?: string }; // no orphan opportunities
  title: string; // e.g. "S.A. clean-up"
  area: string;
  stage: OpportunityStage;
  valueCents?: number; // estimated legal fees (GMV, not platform revenue)
  providerId?: string;
  ownerEmail?: string; // CSM
  nextAction?: { what: string; dueAt?: Iso };
  quoteId?: string;
  outcome?: string; // required when won or lost
  createdAt: Iso;
  updatedAt: Iso;
  closedAt?: Iso;
}

// ─── Privacy (ILP operates under Costa Rica Ley 8968; US-resident members) ─
export type ConsentKind = "terms" | "privacy" | "recording" | "marketing_email" | "ai_assistant";

export interface ConsentRecord {
  id: string;
  clientId?: string;
  email: string;
  kind: ConsentKind;
  granted: boolean;
  version: string; // document version accepted, e.g. "privacy-2026-10-26"
  source: string; // "join", "booking", "settings", ...
  consultationId?: string; // recording consent given for one call
  at: Iso;
}

export type PrivacyRequestKind = "access" | "export" | "rectify" | "delete" | "restrict";

export interface PrivacyRequest {
  id: string;
  clientId: string;
  email: string;
  kind: PrivacyRequestKind;
  status: "received" | "in_review" | "completed" | "refused";
  note?: string;
  dueAt: Iso; // legal response deadline
  createdAt: Iso;
  completedAt?: Iso;
}

// ─── Journeys: first-party journey analytics + A/B experiments ─────────────
/**
 * JOURNEYS. Our own analytics, stored in Firestore (no third-party tool).
 * The browser posts small batched events to POST /api/journey/events; steps
 * that happen on the server (account created, paid, booked, ...) are written
 * by the route handlers themselves, so the funnel never depends on the browser.
 * No free text, no emails, no IP addresses are stored on an event.
 *
 * Source: "outbound" = people ILP contacted first (staff outreach email,
 * imported lead, CSM call), tracked send → open → click → check → join.
 * "inbound" = everyone else; utm campaigns are channel detail.
 */
export type FunnelStage = "acquire" | "activate" | "convert" | "retain";

export interface JourneyStepDef<Id extends string = string> {
  id: Id;
  label: string;
  stage: FunnelStage;
}

/** The member funnel, in order. */
export const FUNNEL_STEPS = [
  { id: "landing_view", label: "Landing page", stage: "acquire" },
  { id: "check_start", label: "Started the free check", stage: "acquire" },
  { id: "check_finish", label: "Finished the free check", stage: "acquire" },
  { id: "results_view", label: "Saw the results", stage: "acquire" },
  { id: "deadlines_select", label: "Picked deadlines to keep", stage: "activate" },
  { id: "signup_start", label: "Started a free account", stage: "activate" },
  { id: "account_created", label: "Free account created", stage: "activate" },
  { id: "join_start", label: "Started joining", stage: "convert" },
  { id: "activation_paid", label: "Paid activation (member)", stage: "convert" },
  { id: "profile_ready", label: "Profile consultation-ready", stage: "convert" },
  { id: "call_booked", label: "Booked a call", stage: "convert" },
  { id: "call_done", label: "Had a call", stage: "convert" },
  { id: "handoff_confirmed", label: "Lawyer confirmed next steps", stage: "retain" },
  { id: "paid_work_accepted", label: "Accepted paid legal work", stage: "retain" },
  { id: "renewed_m2", label: "Renewed month 2", stage: "retain" },
  { id: "renewed_m3", label: "Renewed month 3", stage: "retain" },
] as const;

/** Outbound only: before they join the member funnel at landing_view / check_start. */
export const OUTBOUND_STEPS = [
  { id: "outreach_sent", label: "Contacted by ILP", stage: "acquire" },
  { id: "outreach_opened", label: "Opened the email", stage: "acquire" },
  { id: "outreach_clicked", label: "Clicked through", stage: "acquire" },
] as const;

/** Lawyer recruitment funnel on /attorneys. */
export const LAWYER_STEPS = [
  { id: "lawyer_landing_view", label: "Lawyer landing page", stage: "acquire" },
  { id: "lawyer_apply_start", label: "Started the application", stage: "activate" },
  { id: "lawyer_apply_submit", label: "Submitted the application", stage: "activate" },
  { id: "lawyer_verified", label: "Verified partner lawyer", stage: "convert" },
] as const;

export type MemberFunnelStepId = (typeof FUNNEL_STEPS)[number]["id"];
export type OutboundStepId = (typeof OUTBOUND_STEPS)[number]["id"];
export type LawyerStepId = (typeof LAWYER_STEPS)[number]["id"];
export type FunnelStepId = MemberFunnelStepId | OutboundStepId | LawyerStepId;

/** Every journey step: outbound first, then the member funnel, then the lawyer funnel. */
export const ALL_JOURNEY_STEPS: readonly JourneyStepDef<FunnelStepId>[] = [...OUTBOUND_STEPS, ...FUNNEL_STEPS, ...LAWYER_STEPS];

export const isFunnelStepId = (v: unknown): v is FunnelStepId =>
  typeof v === "string" && ALL_JOURNEY_STEPS.some((s) => s.id === v);

/** Plain label of a step id; the id itself when unknown. */
export const journeyStepLabel = (id: string): string => ALL_JOURNEY_STEPS.find((s) => s.id === id)?.label ?? id;

/**
 * Steps the server records itself (route handlers / TASK_RULES events). The
 * browser may not send these; POST /api/journey/events drops them.
 */
export const SERVER_JOURNEY_STEPS: readonly FunnelStepId[] = [
  "account_created",
  "activation_paid",
  "profile_ready",
  "call_booked",
  "call_done",
  "handoff_confirmed",
  "paid_work_accepted",
  "renewed_m2",
  "renewed_m3",
  "outreach_sent",
  "outreach_opened",
  "outreach_clicked",
  "lawyer_apply_submit",
  "lawyer_verified",
];

export type JourneySource = "inbound" | "outbound";
export const JOURNEY_SOURCES: readonly JourneySource[] = ["inbound", "outbound"];

export type JourneyChannel = "organic" | "direct" | "referral" | "campaign" | "email_outreach" | "import" | "csm_call";
export const JOURNEY_CHANNELS: readonly JourneyChannel[] = ["organic", "direct", "referral", "campaign", "email_outreach", "import", "csm_call"];
/** Channels that make a visitor "outbound". */
export const OUTBOUND_CHANNELS: readonly JourneyChannel[] = ["email_outreach", "import", "csm_call"];

export type JourneyEventType = "page_view" | "step" | "click" | "form_error" | "heartbeat" | "exit";
export const JOURNEY_EVENT_TYPES: readonly JourneyEventType[] = ["page_view", "step", "click", "form_error", "heartbeat", "exit"];

export type JourneyDevice = "phone" | "tablet" | "desktop";
export const JOURNEY_DEVICES: readonly JourneyDevice[] = ["phone", "tablet", "desktop"];

/** Query parameter an outreach link carries (opaque outreach id). */
export const OUTREACH_PARAM = "o";
/**
 * Header the browser adds to existing requests (free check, claim, join,
 * lawyer application) so the server can link the visitor to the lead or
 * account it creates. A body field `visitorId` is read too.
 */
export const JOURNEY_VISITOR_HEADER = "x-ilp-visitor";
/** Field on `clients` and `leads` docs holding the journey link (JourneyTrack). Staff-only. */
export const JOURNEY_TRACK_FIELD = "journeyTrack";
/** Paths an outreach click may redirect to (prefix match on whole segments; anything else goes to "/"). */
export const JOURNEY_REDIRECT_PREFIXES: readonly string[] = [
  "/", "/check", "/join", "/pricing", "/status", "/attorneys", "/countries", "/deadlines", "/guides", "/blog", "/legal", "/about",
  "/colombia", "/costa-rica", "/mexico", "/panama", "/portugal", "/spain",
];
/** Browser storage key for the random first-party visitor id. */
export const JOURNEY_VISITOR_KEY = "ilp_vid";
/** Browser storage key for the visitor's analytics opt-out ("1" = opted out). */
export const JOURNEY_OPT_OUT_KEY = "ilp_journey_optout";
/** At most this many events per POST /api/journey/events. */
export const JOURNEY_BATCH_MAX = 50;
/** A heartbeat every this many ms while the tab is visible (time on page). */
export const JOURNEY_HEARTBEAT_MS = 15000;
/** Raw events are deleted after this many days (13 months). Daily aggregates are kept. */
export const JOURNEY_RAW_RETENTION_DAYS = 395;

export interface JourneyUtm {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
}

export interface JourneyEvent {
  id: string;
  visitorId: string; // random first-party id from the browser, not personal
  sessionId: string; // random per tab session (30 min idle)
  clientId?: string; // set by the server when the request carries a client session, or after identify
  leadId?: string;
  outreachId?: string;
  source: JourneySource;
  channel: JourneyChannel;
  utm?: JourneyUtm; // each value ≤ 80 chars, [a-z0-9._-] only
  type: JourneyEventType;
  step?: FunnelStepId; // type = "step"; on click / form_error, the step the form belongs to (e.g. check_start, target "q5")
  path: string; // pathname only, no query string; ids in the path are replaced by ":id"
  target?: string; // click / form_error: a component or field id (≤ 64 chars, [a-z0-9._-]), never free text
  durationMs?: number; // heartbeat / exit: time on the page since the last heartbeat or view
  variants: Record<string, string>; // experiment key → variant key, at the time of the event
  device: JourneyDevice;
  country?: CountryCode; // the country the visitor picked, not geo-IP
  at: Iso;
  placeholder?: boolean;
}

/** One event as the browser posts it. The server sets id, source/channel when unknown, clientId/leadId and at (clamped). */
export type JourneyEventInput = Omit<JourneyEvent, "id" | "clientId" | "leadId" | "placeholder" | "source" | "channel" | "at"> & {
  source?: JourneySource;
  channel?: JourneyChannel;
  at?: Iso;
};

/**
 * POST /api/journey/events body (application/json, or text/plain holding the
 * same JSON for navigator.sendBeacon). `optOut: true` (or DNT / Sec-GPC
 * headers) → nothing stored. Max 32 KB, JOURNEY_BATCH_MAX events.
 */
export interface JourneyEventsRequest {
  events: JourneyEventInput[];
  optOut?: boolean;
}

/** POST /api/journey/events response (202). `ignored` says why nothing was stored. */
export interface JourneyEventsResponse {
  accepted: number;
  dropped: number;
  ignored?: "opt_out" | "dnt" | "gpc" | "bot";
}

// ─── Experiments ───────────────────────────────────────────────────────────
export type ExperimentStatus = "draft" | "running" | "paused" | "ended";
export const EXPERIMENT_STATUSES: readonly ExperimentStatus[] = ["draft", "running", "paused", "ended"];
export type ExperimentAudience = "all" | "inbound" | "outbound";

export interface ExperimentVariant {
  key: string; // slug; the first variant is the control
  name: string;
  weight: number; // relative weight, > 0
}

export interface Experiment {
  id: string;
  key: string; // slug used in code, e.g. "hero-headline"
  name: string;
  hypothesis: string;
  surface: string; // path ("/check") or component id ("home.hero")
  variants: ExperimentVariant[]; // 2-4; changing them while running is refused
  primaryStep: FunnelStepId;
  guardrailSteps?: FunnelStepId[];
  audience: ExperimentAudience;
  status: ExperimentStatus;
  startedAt?: Iso;
  endedAt?: Iso;
  winner?: string; // variant key, set by declare-winner
  createdBy: string;
  createdAt: Iso;
  updatedAt: Iso;
  placeholder?: boolean;
}

/** POST / PATCH /api/dashboard/journeys/experiments body. */
export type ExperimentInput = Pick<Experiment, "key" | "name" | "hypothesis" | "surface" | "variants" | "primaryStep" | "audience"> & {
  guardrailSteps?: FunnelStepId[];
};

/** What the browser needs to render a running experiment. */
export type ExperimentConfig = Pick<Experiment, "key" | "surface" | "variants" | "audience" | "status">;

/** GET /api/journey/assign?visitorId=&source= (public, cached 60 s). */
export interface JourneyAssignResponse {
  visitorId: string;
  assignments: Record<string, string>; // experiment key → variant key (running experiments the visitor is in)
  experiments: ExperimentConfig[];
}

// ─── Outreach (outbound contact records; staff-only) ──────────────────────
export type OutreachChannel = Extract<JourneyChannel, "email_outreach" | "import" | "csm_call">;

export interface Outreach {
  id: string; // opaque, also the ?o= value
  clientId?: string;
  leadId?: string;
  email: string; // SHA-256 of the lowercased address (privacy doc); never sent to the browser in clear
  channel: OutreachChannel;
  campaign: string; // slug, e.g. "cr-retirees-nov"
  sentBy: string; // staff email
  sentAt: Iso;
  openedAt?: Iso;
  clickedAt?: Iso;
  convertedStep?: FunnelStepId; // furthest member-funnel step reached
  placeholder?: boolean;
}

// ─── Daily aggregate (journey_daily) ──────────────────────────────────────
/**
 * One doc per day × source × channel × country × device × experiment variant
 * (placeholder events go to separate docs with ph_ ids). Routes read these,
 * not raw events. Visitor counts are distinct per day, summed over a range.
 */
export interface JourneyDaily {
  id: string; // day|source|channel|country|device|exp=variant (or "-")
  day: string; // "2026-10-28" (UTC)
  source: JourneySource;
  channel: JourneyChannel;
  country: CountryCode | "-";
  device: JourneyDevice;
  experiment: string; // experiment key or "-" (rows are written once per running experiment the visitor was in, plus once with "-")
  variant: string; // variant key or "-"
  visitors: number; // distinct visitors seen that day
  steps: Partial<Record<FunnelStepId, number>>; // distinct visitors reaching each step that day
  stepMs: Partial<Record<FunnelStepId, number[]>>; // histogram of ms from the previous step (JOURNEY_MS_BUCKETS)
  pages: Record<string, { views: number; exits: number; ms: number[] }>; // path → views, exits, time histogram
  transitions: Record<string, number>; // "fromStep>toStep" and "page:/a>/b" → visitors
  exits: Record<string, number>; // last path of a session → sessions
  stepExits: Record<string, Record<string, number>>; // furthest step that day → last path → visitors who stopped there
  dwellMs: Partial<Record<FunnelStepId, number[]>>; // histogram: time at the furthest step before the last event of the day
  formErrors: Record<string, Record<string, number>>; // step → target → count
  builtAt: Iso;
  placeholder?: boolean;
}

/** Upper bounds (ms) of the duration histogram buckets; the last bucket is open-ended. */
export const JOURNEY_MS_BUCKETS: readonly number[] = [
  1000, 3000, 5000, 10000, 20000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000, 21600000, 86400000, 259200000, 604800000, 2592000000,
];

/** journey_exposures: a visitor's first exposure to a running experiment and the steps reached after it. */
export interface JourneyExposure {
  id: string; // <experimentKey>__<visitorId>
  experiment: string;
  variant: string;
  visitorId: string;
  source: JourneySource;
  firstAt: Iso;
  steps: Partial<Record<FunnelStepId, Iso>>; // first time each step was reached at or after firstAt
  placeholder?: boolean;
}

/** Stored on a clients / leads doc under JOURNEY_TRACK_FIELD. Staff-only (never in member or lawyer payloads). */
export interface JourneyTrack {
  visitorId: string;
  source: JourneySource;
  channel: JourneyChannel;
  outreachId?: string;
  country?: CountryCode;
  device?: JourneyDevice;
  variants?: Record<string, string>;
  firstAt: Iso;
  furthestStep?: FunnelStepId; // furthest member-funnel step reached
  furthestAt?: Iso;
}

// ─── Staff read models (GET /api/dashboard/journeys/*) ───────────────────
export interface JourneyRange {
  from: string; // "2026-10-01" inclusive (UTC day)
  to: string; // "2026-10-28" inclusive
}

export interface JourneyFilters {
  source?: JourneySource;
  channel?: JourneyChannel;
  country?: CountryCode;
  device?: JourneyDevice;
  experiment?: string;
  variant?: string;
  excludePlaceholder?: boolean; // ?excludePlaceholder=1
}

/** ?funnel= on GET /funnel and /stuck: which ordered step list. Default "member". */
export type JourneyFunnelKind = "member" | "outbound" | "lawyer";

export interface JourneyFunnelRow {
  step: FunnelStepId;
  label: string;
  visitors: number;
  conversionFromPrev: number; // 0..1 (1 for the first row)
  conversionFromStart: number; // 0..1
  medianMsFromPrev: number | null;
  p75MsFromPrev: number | null;
  dropOff: number; // visitors of the previous row minus this row's (0 for the first)
}

/** GET /funnel?from&to&source&channel&country&device&experiment&variant&funnel=member|lawyer|outbound&excludePlaceholder=1 */
export interface JourneyFunnel {
  funnel: JourneyFunnelKind;
  range: JourneyRange;
  filters: JourneyFilters;
  rows: JourneyFunnelRow[];
  bySource: Record<JourneySource, JourneyFunnelRow[]>;
}

export interface JourneyPath {
  from: string; // step id, or a path for page-to-page transitions
  to: string;
  visitors: number;
}

/** GET /paths */
export interface JourneyPaths {
  range: JourneyRange;
  filters: JourneyFilters;
  steps: JourneyPath[]; // top step → step transitions
  pages: JourneyPath[]; // top page → page transitions
  exits: { path: string; count: number }[]; // last page of a session
}

export interface JourneyStuck {
  step: FunnelStepId;
  label: string;
  stuckCount: number; // reached this step and not the next one
  medianDwellMs: number | null; // time spent at this step before leaving or moving on
  topExitPaths: { path: string; count: number }[];
  topFormErrors: { target: string; count: number }[];
}

/** GET /stuck */
export interface JourneyStuckResponse {
  range: JourneyRange;
  filters: JourneyFilters;
  steps: JourneyStuck[];
}

/** One row of GET /stuck/people?step&days&source&country (paginated, helper/listing.ts contract). */
export interface StuckPerson {
  id: string; // "client:<clientId>" or "lead:<leadId>"; used by POST /stuck/:id/task
  clientId?: string;
  leadId?: string;
  name?: string; // staff only
  step: FunnelStepId; // furthest step reached
  since: Iso; // when they reached it
  daysStuck: number;
  source: JourneySource;
  country?: CountryCode;
  csmEmail?: string;
  openTaskId?: string; // an open CSM task already created from this list
  placeholder?: boolean;
}

export interface StuckPeoplePage {
  items: StuckPerson[];
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
}

/** POST /stuck/:id/task body → { task: CsmTask } */
export interface StuckTaskRequest {
  title?: string; // default: "Stuck at <step>: reach out"
  ownerEmail?: string;
  dueInHours?: number; // default 24
}

export interface PageTime {
  path: string;
  views: number;
  medianMs: number | null;
  p75Ms: number | null;
  exitRate: number; // 0..1, exits / views
}

/** GET /pages */
export interface JourneyPagesResponse {
  range: JourneyRange;
  filters: JourneyFilters;
  pages: PageTime[];
}

export interface ExperimentVariantResult {
  key: string;
  name: string;
  visitors: number;
  conversions: number; // visitors reaching primaryStep
  rate: number; // 0..1
  liftVsControl: number | null; // (rate − control) / control; null for the control or when control is 0
  probabilityBest: number; // 0..1, Bayesian beta-binomial (Beta(1,1) prior), Monte Carlo
  ci95: [number, number]; // Wilson interval on rate
  guardrails?: { step: FunnelStepId; rate: number }[];
}

/** GET /experiments → { items }; GET /experiments/:id and every write → { experiment }. */
export interface ExperimentListResponse {
  items: Experiment[];
}

/** GET /experiments/:id/results */
export interface ExperimentResult {
  experimentId: string;
  variants: ExperimentVariantResult[];
  sampleSizeNeeded: number; // per variant, to detect a 20% relative lift at α 0.05, power 0.8
  enoughData: boolean;
  srmWarning: boolean; // sample ratio mismatch: chi-square p < 0.01 against the weights
}

export interface OutboundRow {
  campaign: string;
  channel: OutreachChannel;
  sent: number;
  opened: number;
  clicked: number;
  checkStarted: number;
  accountCreated: number;
  activationPaid: number;
  revenueCents: number; // activation + first month of members it converted
}

/** GET /outbound?from&to&channel */
export interface JourneyOutboundResponse {
  range: JourneyRange;
  rows: OutboundRow[];
}

/** POST /api/dashboard/journeys/outreach: log a CSM call or a manual send; returns the tracked link to share. */
export interface OutreachInput {
  channel: OutreachChannel;
  campaign: string; // slug
  clientId?: string;
  leadId?: string;
  email?: string; // stored only as a SHA-256 hash
  to?: string; // landing path for the link, default "/check"
}

export interface OutreachCreated {
  outreach: Omit<Outreach, "email">;
  link: string; // FRONTEND_URL + path + ?o=<id>
  clickUrl: string; // API click redirect (records the click, then lands on `link`)
  pixelUrl: string; // open pixel for emails
}
