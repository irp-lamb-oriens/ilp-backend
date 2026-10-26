/**
 * API/privacy/policy.ts — privacy rules as data (P6). Pure: no I/O.
 *
 * Designed with Costa Rica's Ley 8968 (Protección de la Persona frente al
 * Tratamiento de sus Datos Personales) and its regulation, US state privacy
 * laws (CCPA/CPRA notice basics), US state automatic-renewal laws and
 * all-party call-recording consent in mind. This is NOT a compliance
 * guarantee: every period and rule below is a placeholder for ILP's counsel to
 * confirm (see docs/PRIVACY_AND_COMPLIANCE.md).
 *
 *   LEGAL_VERSIONS     current version id of every legal document (keep equal
 *                      to frontend/src/components/legal/versions.ts)
 *   parseConsentInput  validate a consent the browser sends
 *   latestConsents     current state per kind from the append-only history
 *   businessDaysFrom   response deadline for a privacy request
 *   retentionConfig    retention periods (env, documented defaults)
 *   EXPORT_*           what a member's data export leaves out
 *   ERASURE_PLAN       the keep / anonymize / delete matrix for "Run deletion"
 */

import {
  CLIENT_HIDDEN_FIELDS,
  type ConsentKind,
  type ConsentRecord,
  LAWYER_HIDDEN_FIELDS,
  type PrivacyRequestKind,
} from "../../schemas/contracts.ts";

// ─── Document versions ─────────────────────────────────────────────────────
// A ConsentRecord stores the version the person saw. Bump the id when the
// text changes in a way that needs fresh consent.
export const LEGAL_VERSIONS = {
  terms: "terms-2026-10-26-draft1",
  privacy: "privacy-2026-10-26-draft1",
  recording: "recording-ai-2026-10-26-draft1",
  cookies: "cookies-2026-10-26-draft1",
  disclaimer: "disclaimer-2026-10-26-draft1",
  accessibility: "accessibility-2026-10-26-draft1",
  subprocessors: "subprocessors-2026-10-26-draft1",
} as const;

/** The document a consent kind points at. */
export const VERSION_FOR_KIND: Record<ConsentKind, string> = {
  terms: LEGAL_VERSIONS.terms,
  privacy: LEGAL_VERSIONS.privacy,
  recording: LEGAL_VERSIONS.recording,
  ai_assistant: LEGAL_VERSIONS.recording,
  marketing_email: LEGAL_VERSIONS.privacy,
};

export const CONSENT_KINDS: ConsentKind[] = ["terms", "privacy", "recording", "marketing_email", "ai_assistant"];

/** Kinds a member can withdraw on /status/privacy. Terms and privacy end with the account. */
export const WITHDRAWABLE: ConsentKind[] = ["recording", "marketing_email", "ai_assistant"];

export const CONSENT_SOURCES = ["join", "booking", "join_call", "settings", "lily", "privacy_page"] as const;
export type ConsentSource = typeof CONSENT_SOURCES[number];

export interface ConsentInput {
  kind: ConsentKind;
  granted: boolean;
  source: ConsentSource;
  version: string;
  consultationId?: string;
}

/** Validate one consent sent by a browser. Unknown kinds/sources and stale versions are refused. */
export function parseConsentInput(body: Record<string, unknown>): ConsentInput | { error: string } {
  const kind = body.kind as ConsentKind;
  if (!CONSENT_KINDS.includes(kind)) return { error: "Unknown consent." };
  if (typeof body.granted !== "boolean") return { error: "Say yes or no." };
  const source = (typeof body.source === "string" ? body.source : "settings") as ConsentSource;
  if (!CONSENT_SOURCES.includes(source)) return { error: "Unknown source." };
  const version = VERSION_FOR_KIND[kind];
  if (body.version !== undefined && body.version !== version) {
    return { error: "This page is out of date. Reload it and try again." };
  }
  const out: ConsentInput = { kind, granted: body.granted, source, version };
  if (typeof body.consultationId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(body.consultationId)) {
    out.consultationId = body.consultationId;
  }
  return out;
}

/** Current state per kind: the newest record wins. History stays append-only. */
export function latestConsents(records: ConsentRecord[]): Partial<Record<ConsentKind, ConsentRecord>> {
  const out: Partial<Record<ConsentKind, ConsentRecord>> = {};
  for (const r of [...records].sort((a, b) => a.at.localeCompare(b.at))) out[r.kind] = r;
  return out;
}

export function consentId(): string {
  return `cns_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function privacyRequestId(): string {
  return `prq_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

// ─── Privacy requests ──────────────────────────────────────────────────────
export const REQUEST_KINDS: PrivacyRequestKind[] = ["access", "export", "rectify", "delete", "restrict"];

/** Member-facing label, also used in task titles and emails. */
export const REQUEST_LABEL: Record<PrivacyRequestKind, string> = {
  access: "Access to my data",
  export: "Download of my data",
  rectify: "Correction of my data",
  delete: "Deletion of my account and data",
  restrict: "Objection or restriction of a use of my data",
};

/**
 * Response deadline: `days` business days (Mon-Fri) after `from`. Costa Rica
 * public holidays are not skipped, so the date can only be earlier, never
 * later. PRIVACY_RESPONSE_DAYS default 10 is a placeholder: counsel must
 * confirm the Ley 8968 / regulation timeline.
 */
export function businessDaysFrom(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  let left = Math.max(0, Math.floor(days));
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}

export function responseDays(env: (k: string) => string | undefined): number {
  const n = Number(env("PRIVACY_RESPONSE_DAYS"));
  return Number.isFinite(n) && n >= 1 && n <= 60 ? Math.floor(n) : 10;
}

// ─── Retention (jobs/privacyRetention.ts) ─────────────────────────────────
export interface RetentionConfig {
  leadMonths: number; // free-check leads that never became members
  errorLogDays: number;
  funnelMonths: number;
  transcriptMonthsAfterEnd: number; // after the membership ended
  chatbotThreadMonths: number; // public website chatbot, never linked to a member
  emailQueueDays: number; // sent / dead email copies
  sessionGraceDays: number; // expired sessions and login codes
  maxDeletesPerRun: number;
}

/** Defaults are placeholders for counsel; each is overridable by env. */
export const RETENTION_DEFAULTS: RetentionConfig = {
  leadMonths: 12,
  errorLogDays: 90,
  funnelMonths: 13,
  transcriptMonthsAfterEnd: 24,
  chatbotThreadMonths: 6,
  emailQueueDays: 90,
  sessionGraceDays: 1,
  maxDeletesPerRun: 500,
};

const RETENTION_ENV: Record<keyof RetentionConfig, string> = {
  leadMonths: "RETENTION_LEAD_MONTHS",
  errorLogDays: "RETENTION_ERROR_LOG_DAYS",
  funnelMonths: "RETENTION_FUNNEL_MONTHS",
  transcriptMonthsAfterEnd: "RETENTION_TRANSCRIPT_MONTHS",
  chatbotThreadMonths: "RETENTION_CHATBOT_MONTHS",
  emailQueueDays: "RETENTION_EMAIL_QUEUE_DAYS",
  sessionGraceDays: "RETENTION_SESSION_GRACE_DAYS",
  maxDeletesPerRun: "RETENTION_MAX_DELETES_PER_RUN",
};

export function retentionConfig(env: (k: string) => string | undefined): RetentionConfig {
  const out = { ...RETENTION_DEFAULTS };
  for (const key of Object.keys(RETENTION_ENV) as Array<keyof RetentionConfig>) {
    const n = Number(env(RETENTION_ENV[key]));
    if (env(RETENTION_ENV[key]) && Number.isFinite(n) && n >= 1) out[key] = Math.floor(n);
  }
  return out;
}

export function monthsBefore(now: Date, months: number): Date {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

export function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

/** Pure: ISO timestamp strictly older than the cutoff (missing or bad dates are never selected). */
export function olderThan(iso: unknown, cutoff: Date): boolean {
  if (typeof iso !== "string") return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t < cutoff.getTime();
}

// ─── Export (right of access / portability) ───────────────────────────────
/** Never in an export: commercial notes, margins, fees, internal ranks, raw storage. */
export const EXPORT_HIDDEN_FIELDS: readonly string[] = [
  ...new Set([
    ...CLIENT_HIDDEN_FIELDS,
    ...LAWYER_HIDDEN_FIELDS,
    "expectedMarginPct",
    "providerCost",
    "csmTaskIds",
    "dataBase64",
    "objectName",
    "authCode",
    "otp",
    "codeHash",
    "token",
  ]),
];

/** Client-doc keys that are staff work product, not the member's data (internal notes, sales reads). */
export const EXPORT_CLIENT_INTERNAL_KEYS: readonly string[] = [
  "notes",
  "pendingActions",
  "activityLog",
  "transcriptInsights",
  "salesAssessment",
  "priorityRank",
  "conversations",
  // moved to the "messages" section in member-visible form
  "statusChatThread",
  "statusComments",
];

// ─── Erasure ("Run deletion") ─────────────────────────────────────────────
export type ErasureAction = "delete" | "anonymize" | "keep" | "pseudonymize_email";
export type Selector =
  | { by: "docId" } // doc id = clientId
  | { by: "field"; field: string } // field == clientId
  | { by: "email"; field: string } // field == member email
  | { by: "emailDocId" } // doc id = normalized email (push_subscriptions)
  | { by: "anonId" } // funnel events of the member's browser id
  | { by: "leadOf" }; // leads converted into, or given with, this member

export interface ErasureRule {
  collection: string;
  select: Selector[];
  action: ErasureAction;
  /** anonymize: fields kept; everything else is removed. */
  keep?: readonly string[];
  why: string;
}

/**
 * The keep / delete matrix. Order matters: the email queue is purged before
 * the completion email is queued; the client tombstone is written last.
 * Not covered here (manual, listed in ERASURE_MANUAL_STEPS): Stripe, Google
 * Calendar/Drive, mailboxes, backups, Sentry.
 */
export const ERASURE_PLAN: readonly ErasureRule[] = [
  { collection: "matters", select: [{ by: "field", field: "clientId" }], action: "delete", why: "Legal matter content. ILP keeps no copy; the lawyer keeps their own professional file [counsel to confirm]." },
  { collection: "handoffs", select: [{ by: "field", field: "clientId" }], action: "delete", why: "Lawyer next steps and staff commercial notes about the member." },
  { collection: "obligations", select: [{ by: "field", field: "clientId" }], action: "delete", why: "Dates derived from the member's profile." },
  { collection: "csm_tasks", select: [{ by: "field", field: "clientId" }], action: "delete", why: "Staff work items naming the member." },
  { collection: "opportunities", select: [{ by: "field", field: "clientId" }], action: "anonymize", keep: ["id", "clientId", "area", "stage", "valueCents", "providerId", "quoteId", "createdAt", "closedAt"], why: "Legal-fee totals stay for accounting (GMV); titles, next actions and outcomes go." },
  { collection: "consultations", select: [{ by: "field", field: "clientId" }], action: "anonymize", keep: ["id", "clientId", "providerId", "matterId", "scheduledAt", "durationMin", "minutesUsed", "status", "consent", "chargedAt", "createdAt", "endedAt"], why: "Minutes used and lawyer payment basis stay; question, transcript, summary, rating comment and Meet link go. Recording consent stays as proof." },
  { collection: "memberships", select: [{ by: "field", field: "clientId" }], action: "anonymize", keep: ["id", "clientId", "plan", "status", "country", "activationPaidAt", "activatedAt", "periodStart", "periodEnd", "minutesIncluded", "minutesUsed", "callsIncluded", "callsUsed", "paymentRef", "cancelledAt", "createdAt", "updatedAt", "lastInvoiceId"], why: "Billing history for accounting and tax; cancel reason and free text go." },
  { collection: "member_documents", select: [{ by: "field", field: "clientId" }], action: "delete", why: "Uploaded identity and legal documents; the stored file is deleted too." },
  { collection: "member_feedback", select: [{ by: "field", field: "clientId" }], action: "delete", why: "Ratings and comments." },
  { collection: "funnel_events", select: [{ by: "field", field: "clientId" }, { by: "anonId" }], action: "delete", why: "Funnel events linked to the member or their browser id." },
  { collection: "leads", select: [{ by: "leadOf" }], action: "delete", why: "Free-check answers." },
  { collection: "push_subscriptions", select: [{ by: "emailDocId" }], action: "delete", why: "Browser push endpoint." },
  { collection: "client_status_sessions", select: [{ by: "email", field: "email" }], action: "delete", why: "Sign-in sessions." },
  { collection: "client_status_otps", select: [{ by: "emailDocId" }], action: "delete", why: "Pending sign-in codes." },
  { collection: "join_sessions", select: [{ by: "field", field: "clientId" }], action: "delete", why: "Join hand-off tokens." },
  { collection: "email_queue", select: [{ by: "email", field: "to" }], action: "delete", why: "Stored copies of emails sent to the member (purged before the completion email is queued)." },
  { collection: "invoices", select: [{ by: "field", field: "clientId" }], action: "keep", why: "Invoices and payments are kept for the legally required period [N years per counsel/accountant]." },
  { collection: "consents", select: [{ by: "field", field: "clientId" }, { by: "email", field: "email" }], action: "pseudonymize_email", why: "Proof of consent is kept; the email becomes a SHA-256 hash that can be checked against a disputed address." },
  { collection: "privacy_requests", select: [{ by: "field", field: "clientId" }], action: "pseudonymize_email", why: "Proof the request was handled is kept; the email becomes a hash." },
  { collection: "audit_log", select: [], action: "keep", why: "Append-only security record (who accessed what). Kept for [N years per counsel]; not edited." },
  { collection: "clients", select: [{ by: "docId" }], action: "anonymize", keep: ["id", "createdAt", "memberSince", "membershipStatus"], why: "Replaced by a tombstone with no personal data so invoices and minutes still resolve." },
];

export const ERASURE_MANUAL_STEPS: readonly string[] = [
  "Stripe: delete or redact the customer (Stripe keeps payment records it must keep by law).",
  "Google Calendar: past call events list the member's email as a guest; delete them from the organizer calendar.",
  "Google Drive: delete Meet transcripts and notes for the member's calls from the organizer's Drive.",
  "Mailboxes: delete threads with the member in staff and lawyer inboxes where no retention duty applies.",
  "Backups: Firestore exports in BACKUP_BUCKET expire with the bucket lifecycle rule (30-90 days). Do not restore them without re-running this deletion.",
  "Sentry (if used): error events may hold the member's email in request data; they expire with Sentry's retention.",
  "Tell the assigned lawyer(s) about the deletion request; their own professional file is theirs to manage under their bar rules [counsel to confirm].",
];

/** Pure: keep only allowed keys (anonymize). */
export function keepOnly(doc: Record<string, unknown>, keep: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keep) if (doc[k] !== undefined) out[k] = doc[k];
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.trim().toLowerCase()));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
