/**
 * schemas/types.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Shared primitive types for the ILP Firestore schema system.
 *
 * Every document schema in `schemas/collections/*` builds on these primitives
 * so that timestamps, ids, and common shapes stay consistent across the whole
 * data model. Firestore is schemaless at runtime; these types are the
 * compile-time contract that keeps routers, jobs, and the dashboard in sync.
 */

/** ISO-8601 timestamp string (Firestore stores timestamps as strings here). */
export type IsoTimestamp = string;

/** A Firestore document id. */
export type DocId = string;

/** A document that carries its own id (denormalized into the body). */
export interface WithId {
  id: DocId;
}

/** Standard audit timestamps present on most mutable documents. */
export interface Timestamped {
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** A document that may carry arbitrary extra fields (schemaless escape hatch). */
export interface Extensible {
  [key: string]: unknown;
}

/** A single consultation slot (start/end/timezone). */
export interface CalendarSlot {
  start: IsoTimestamp;
  end: IsoTimestamp;
  timezone: string;
}

/** A pipeline stage rating submitted by a client (1–5). */
export interface StageRating {
  stage: string;
  rating: number;
  comment?: string;
  createdAt: IsoTimestamp;
}

/** A status-page comment thread entry. */
export interface StatusComment {
  id: DocId;
  author: string;
  authorRole: "client" | "staff";
  body: string;
  createdAt: IsoTimestamp;
}

/** A charge line on a client's project. */
export interface Charge {
  id: DocId;
  label: string;
  amountMinor: number;
  currency: string;
  status: "pending" | "paid" | "void";
  createdAt: IsoTimestamp;
}

/** A quote sent to a client, with acceptance state. */
export interface Quote {
  id: DocId;
  title: string;
  lines: Array<{ label: string; amountMinor: number }>;
  totalMinor: number;
  currency: string;
  status: "draft" | "sent" | "accepted" | "declined";
  acceptanceToken?: string;
  createdAt: IsoTimestamp;
}

/** A note attached to a client record. */
export interface ClientNote {
  id: DocId;
  body: string;
  author: string;
  createdAt: IsoTimestamp;
}

/** A pending action on a client record. */
export interface PendingAction {
  id: DocId;
  label: string;
  dueAt?: IsoTimestamp;
}

/** A journey step (stage transition) on a client record. */
export interface JourneyStep {
  stage: string;
  enteredAt: IsoTimestamp;
}