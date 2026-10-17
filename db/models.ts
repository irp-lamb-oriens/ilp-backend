/**
 * db/models.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Document-shape types for the ILP Firestore data model.
 *
 * These are advisory TypeScript shapes (Firestore is schemaless), used to keep
 * the CRM, client-portal, and automation routers consistent. Ported from
 * IRP-funnel's client/consultation model, retargeted to ILP's legal taxonomy.
 */

/** A single consultation record (the latest is the "current" intake). */
export interface Consultation {
  name?: string;
  surname?: string;
  email?: string;
  phone?: string;
  legalArea?: string;
  legalMatter?: string;
  jurisdiction?: string;
  documents?: string[];
  notes?: string;
  serviceType?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/** A pipeline stage rating submitted by a client (1–5). */
export interface StageRating {
  stage: string;
  rating: number;
  comment?: string;
  createdAt: string;
}

/** A status-page comment thread entry. */
export interface StatusComment {
  id: string;
  author: string;
  authorRole: "client" | "staff";
  body: string;
  createdAt: string;
}

/** A charge line on the client's project. */
export interface Charge {
  id: string;
  label: string;
  amountMinor: number;
  currency: string;
  status: "pending" | "paid" | "void";
  createdAt: string;
}

/** A quote sent to a client, with acceptance state. */
export interface Quote {
  id: string;
  title: string;
  lines: Array<{ label: string; amountMinor: number }>;
  totalMinor: number;
  currency: string;
  status: "draft" | "sent" | "accepted" | "declined";
  acceptanceToken?: string;
  createdAt: string;
}

/** The canonical client document (CRM core). */
export interface ClientDoc {
  id: string;
  email: string;
  stage: string;
  stageEnteredAt?: string;
  clientFields: Record<string, unknown>;
  consultations: Consultation[];
  journey: Array<{ stage: string; enteredAt: string }>;
  stageRatings: StageRating[];
  charges: Charge[];
  quotes: Quote[];
  notes: Array<{ id: string; body: string; author: string; createdAt: string }>;
  pendingActions: Array<{ id: string; label: string; dueAt?: string }>;
  conversations: string[];
  statusChatThread?: string;
  createdAt: string;
  updatedAt: string;
}

/** A dashboard or client-status session doc. */
export interface SessionDoc {
  email: string;
  createdAt: string;
  expiresAt: string;
}

/** An OTP doc (dashboard or client-status). */
export interface OtpDoc {
  code: string;
  email: string;
  createdAt: string;
  expiresAt: string;
}