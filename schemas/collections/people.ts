/**
 * schemas/collections/people.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Document schemas for people/entity collections (providers, profiles,
 * vendors, leads, consultations).
 */
import type { CalendarSlot, Extensible, IsoTimestamp } from "../types.ts";

/** providers — a vetted service provider (lawyer). */
export interface ProviderDoc extends Extensible {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
  website?: string;
  country?: string;
  specialties?: unknown;
  /** Legal service areas this provider covers. */
  legalAreas?: string[];
  /** Countries/regions this provider is admitted to practice in. */
  jurisdictions?: string[];
  /** Languages the provider works in. */
  languages?: unknown;
  insurance?: Record<string, unknown>;
  slaStatus?: string;
  status?: "pending" | "vetted" | "active" | "inactive";
  active?: boolean;
  uid?: string;
  /** Operator quality score, 0–5 in half-star steps. Drives assignment priority. */
  score?: number | null;
  vettedAt?: IsoTimestamp;
  createdAt?: IsoTimestamp;
  updatedAt?: IsoTimestamp;
}

/** provider_field_schema — the known provider field schema (global doc). */
export interface ProviderFieldSchemaDoc extends Extensible {
  id: string;
  knownFields: string[];
}

/** profiles — a user profile. */
export interface ProfileDoc extends Extensible {
  id: string;
  uid?: string;
  email?: string;
  name?: string;
  role?: string;
  createdAt?: IsoTimestamp;
  updatedAt?: IsoTimestamp;
}

/** vendors — a vendor record. */
export interface VendorDoc extends Extensible {
  id: string;
  name?: string;
  email?: string;
  createdAt?: IsoTimestamp;
  updatedAt?: IsoTimestamp;
}

/** leads — a captured lead. */
export interface LeadDoc extends Extensible {
  id: string;
  name?: string;
  email: string;
  country?: string;
  topic?: string;
  consent?: boolean;
  createdAt: IsoTimestamp;
}

/** consultations — a consultation booking. */
export interface ConsultationBookingDoc extends Extensible {
  id: string;
  customerId: string;
  providerId: string;
  slot: CalendarSlot;
  source?: string;
  sourceId?: string | null;
  topic?: string;
  notes?: unknown;
  status: "requested" | "confirmed" | "cancelled";
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}