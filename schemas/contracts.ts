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
} as const;

export type Iso = string;
export type CountryCode = "CR" | "PA" | "MX";

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
}

export interface Lead {
  id: string;
  email: string;
  name?: string;
  country: CountryCode;
  answers: Record<string, string | boolean | number>;
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
  cancelledAt?: Iso;
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
  openedAt: Iso;
  closedAt?: Iso;
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
  consent: { recording: ConsentState; at?: Iso };
  transcript?: string;
  summary?: { text: string; status: "suggested" | "confirmed"; confirmedAt?: Iso };
  handoffId?: string;
  endedAt?: Iso;
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
  | "escalation";

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
  source: { kind: "membership" | "consultation" | "handoff" | "quote" | "document" | "manual"; id?: string };
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
};

// ─── Obligation (configurable rules, no hard-coded country logic) ──────────
export interface Obligation {
  id: string;
  clientId: string;
  country: CountryCode;
  ruleId: string;
  title: string; // worded as "may require review"
  dueAt?: Iso;
  status: "upcoming" | "asked" | "handled" | "dismissed";
}

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
