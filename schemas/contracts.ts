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
  sourceLeadId?: string; // lead that converted into this membership (free check)
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
  suggestedNextSteps?: LegalNextStep[]; // AI draft with the suggested summary; lawyer confirms
  handoffId?: string;
  endedAt?: Iso;
  meetUrl?: string; // Google Meet link from the calendar event
  calendarEventId?: string;
  remindersSent?: string[]; // e.g. ["24h", "1h"]
  rating?: { score: 1 | 2 | 3 | 4 | 5; comment?: string; at: Iso }; // member, after the call
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
  "membership.past_due": { type: "escalation", dueInHours: 24, title: "Payment failed: contact member" }, // P2 lifecycle
  "membership.cancel_requested": { type: "renewal", dueInHours: 24, title: "Cancellation requested: save call" }, // P2 cancel
  "feedback.low_score": { type: "follow_up", dueInHours: 24, title: "Low rating: follow up" }, // P2 post-call ≤ 2 or monthly ≤ 6
  "call.link_failed": { type: "follow_up", dueInHours: 4, title: "Meet link failed: send link" }, // P3 calendar failure
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


// ─── Lawyer availability (feeds booking slots) ────────────────────────────
export interface WeeklyWindow {
  day: 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday, Costa Rica time
  start: string; // "08:30"
  end: string; // "12:00"
}

export interface LawyerAvailability {
  id: string; // = providerId
  providerId: string;
  timezone: "America/Costa_Rica";
  weekly: WeeklyWindow[];
  blackoutDates: string[]; // "2026-12-24"
  minLeadHours: number; // default 18
  maxCallsPerDay: number; // default 6
  specialties: string[]; // legal areas, used for routing
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

// ─── Privacy (Costa Rica Ley 8968; US-resident members) ───────────────────
export type ConsentKind = "terms" | "privacy" | "recording" | "marketing_email" | "ai_assistant";

export interface ConsentRecord {
  id: string;
  clientId?: string;
  email: string;
  kind: ConsentKind;
  granted: boolean;
  version: string; // document version accepted, e.g. "privacy-2026-10-26"
  source: string; // "join", "booking", "settings", ...
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
