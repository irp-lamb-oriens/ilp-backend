/**
 * API/consultations/serviceConfig/types.ts
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Shared service definitions for the ILP consultation intake funnel.
 *
 * ILP (International Legal Partner) offers legal services across
 * jurisdictions. These types describe, in one place, what the intake form
 * asks and what a conversational agent asks, so a change to the field list
 * is reflected in both surfaces without editing two code paths.
 *
 * This is deliberately distinct from any CRM field registry: this module
 * controls what the intake funnel collects, not how a persisted client doc
 * is rendered.
 */

export type ServiceType =
  | "legal_consultation"
  | "immigration"
  | "corporate"
  | "real_estate"
  | "notary"
  | "combined"; // synthetic type for a merged multi-select config

/**
 * A declarative, JSON-serializable visibility rule. Supports equality against
 * a single field value or a member check against an array of values. This lets
 * the same config drive the browser renderer and the server agent without
 * shipping executable functions.
 */
export type FieldCondition =
  | { field: string; equals: unknown }
  | { field: string; oneOf: unknown[] };

/**
 * Evaluate a FieldCondition against a flat form-state object. Unknown conditions
 * return true so a malformed rule never hides a field by accident.
 */
export function evaluateCondition(
  cond: FieldCondition | undefined,
  state: Record<string, unknown>,
): boolean {
  if (!cond) return true;
  const value = state[cond.field];
  if ("equals" in cond) return value === cond.equals;
  if ("oneOf" in cond) return (cond.oneOf as unknown[]).includes(value);
  return true;
}

/** The input surface used by the form renderer for a field. */
export type ServiceFieldType =
  | "text" // single-line text
  | "email"
  | "phone"
  | "country" // country search/select component
  | "options" // generic single-select from `options`
  | "people" // repeatable per-person group (uses `fields`)
  | "notes" // multiline text
  | "calendar" // scheduling step
  | "budget" // budget dropdown
  | "legal-area" // legal practice area selector
  | "documents"; // document upload / checklist editor

export interface ServiceFieldOption {
  value: string;
  label: string;
}

export interface ServiceFieldDef {
  /** Stable field id — this is the key on the formStore/consultation doc. */
  id: string;
  type: ServiceFieldType;
  /** Question text shown in the form and used as the agent question. */
  label: string;
  placeholder?: string;
  options?: ServiceFieldOption[];
  required: boolean;
  /**
   * Repeat this group once per person (only meaningful when type === "people").
   * When true, the renderer renders the `fields` block 1..partySize times.
   */
  perPerson?: boolean;
  /** Nested fields for a "people" group. Each child is collected per person. */
  fields?: ServiceFieldDef[];
  /**
   * Whether to show this field given the current form state. Declarative and
   * JSON-serializable so the same rule drives both the frontend renderer and
   * the server-side agent without shipping functions over the wire.
   * Absent => always show.
   */
  showWhen?: FieldCondition;
  /** The exact chat question the conversational agent asks for this field. */
  chatbotQuestion: string;
  /**
   * The service context this field belongs to (e.g. "Immigration",
   * "Corporate formation"). Populated by the resolver so a slide can name
   * the service its question is being asked for. Absent on shared
   * identity/scheduling fields.
   */
  serviceLabel?: string;
  /** Order within the config (ascending). */
  priority: number;
}

export interface ServiceConfig {
  type: ServiceType;
  /** Human-readable service label, surfaced on the service-selection slide. */
  label: string;
  /** Ordered field list for the FORM surface. */
  fields: ServiceFieldDef[];
  /** Ordered field list for the CHATBOT surface (may differ from `fields`). */
  chatbotFields: ServiceFieldDef[];
  /** Pricing and duration metadata used by the booking engine. */
  pricing: {
    /** Currency code (ISO 4217). */
    currency: string;
    /** Base consultation fee in minor units (cents). */
    baseFeeMinor: number;
    /** Default consultation duration in minutes. */
    defaultDurationMinutes: number;
  };
}