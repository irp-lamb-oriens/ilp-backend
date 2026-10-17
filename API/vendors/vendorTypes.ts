/**
 * API/vendors/vendorTypes.ts
 *
 * Canonical types for the ILP legal-professional vendor registry.
 *
 * LegalArea maps directly to the legal-area taxonomy used by the
 * transcript-insights extractor, so vendors can be automatically matched
 * to clients:
 *
 *   immigration  ↔  immigration
 *   corporate    ↔  corporate
 *   real_estate  ↔  real_estate
 *   notary       ↔  notary
 *   family_estate↔  family_estate
 *   litigation   ↔  litigation
 *   compliance   ↔  compliance
 */

// ─── Legal areas ─────────────────────────────────────────────────────────────

export type LegalArea =
  | "immigration"
  | "corporate"
  | "real_estate"
  | "notary"
  | "family_estate"
  | "litigation"
  | "compliance"
  | "other";

export const LEGAL_AREAS: LegalArea[] = [
  "immigration",
  "corporate",
  "real_estate",
  "notary",
  "family_estate",
  "litigation",
  "compliance",
  "other",
];

export const LEGAL_AREA_LABEL: Record<LegalArea, { icon: string; label: string }> = {
  immigration: { icon: "🛂", label: "Immigration" },
  corporate: { icon: "🏢", label: "Corporate" },
  real_estate: { icon: "🏠", label: "Real Estate" },
  notary: { icon: "🖋️", label: "Notary" },
  family_estate: { icon: "👨‍👩‍👧", label: "Family & Estate" },
  litigation: { icon: "⚖️", label: "Litigation" },
  compliance: { icon: "🛡️", label: "Compliance" },
  other: { icon: "📋", label: "Other" },
};

/**
 * Mapping from the transcript extractor's legal-area output → LegalArea.
 * Used by the /match/:clientId endpoint. Identity for the standard areas.
 */
export const LEGAL_AREA_TO_LEGAL_AREA: Record<string, LegalArea> = {
  immigration: "immigration",
  corporate: "corporate",
  real_estate: "real_estate",
  notary: "notary",
  family_estate: "family_estate",
  litigation: "litigation",
  compliance: "compliance",
  other: "other",
};

// ─── Core vendor shape ───────────────────────────────────────────────────────

export interface Vendor {
  /** Firestore id set by the server on creation. */
  id: string;

  companyName: string;
  contactName: string;
  email: string;
  phone?: string;
  website?: string;

  /** At least one legal area is required. */
  legalAreas: LegalArea[];

  /**
   * ISO Alpha-2 country codes of jurisdictions this vendor is admitted to
   * practice in. Empty array = no restriction (services all jurisdictions).
   */
  jurisdictions: string[];

  /** Languages the vendor works in (free-text tags). */
  languages: string[];

  /** Professional credentials (bar admission, notary license, etc.). */
  credentials?: string;

  notes?: string;

  /** Soft-delete — inactive vendors are hidden from match results. */
  active: boolean;

  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

// ─── Request shapes ──────────────────────────────────────────────────────────

export type VendorCreatePayload = Omit<Vendor, "id" | "createdAt" | "updatedAt">;

export type VendorUpdatePayload = Partial<
  Omit<Vendor, "id" | "createdAt" | "updatedAt">
>;