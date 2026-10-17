/**
 * API/dashboard/stageGates/types.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Types for the generic, chainable STAGE-GATE rule engine.
 *
 * Ported from IRP-funnel's `stageGates/types.ts`, retargeted to ILP's legal
 * taxonomy. A Stage Gate blocks moving a client INTO a target pipeline stage
 * until a chain of conditions is satisfied. This is ADDITIVE to (and
 * independent of) the Stage Email Automation rules (`stage_email_rules`).
 *
 * Each condition compares a FACT (a value derived from the client doc or its
 * sub-resources) against a VALUE using an OPERATOR. Conditions in a rule are
 * chained with either "all" (AND) or "any" (OR) logic. A single stage can have
 * multiple rules; ALL enabled rules for the target stage must pass.
 */

/** How a single condition compares a fact to its value. */
export type GateOperator =
  | "exists"
  | "not_exists"
  | "is_empty"
  | "is_not_empty"
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "not_contains";

/** All operators, in UI display order. */
export const GATE_OPERATORS: GateOperator[] = [
  "exists",
  "not_exists",
  "is_empty",
  "is_not_empty",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "not_contains",
];

/** Operators that do NOT require a comparison value. */
export const VALUELESS_OPERATORS: GateOperator[] = [
  "exists",
  "not_exists",
  "is_empty",
  "is_not_empty",
];

/** Chaining logic across a rule's conditions. */
export type GateLogic = "all" | "any";
export const GATE_LOGICS: GateLogic[] = ["all", "any"];

/**
 * A fact descriptor — the catalogue of values a condition may reference. The
 * `key` is stored on the condition; `numeric` hints the UI toward number inputs.
 * `field:<dottedPath>` is a special dynamic key allowing ANY client field.
 */
export interface GateFact {
  key: string;
  label: string;
  numeric: boolean;
  /** Short "what is this" helper text for the editor. */
  hint?: string;
}

/**
 * The curated, non-field facts. Field facts (`field:<path>`) are constructed
 * dynamically by the operator, so they are not enumerated here. Retargeted to
 * ILP's legal pipeline (quotes, notes, documents, transcript insights).
 */
export const CURATED_FACTS: GateFact[] = [
  {
    key: "quotes_total",
    label: "Quotes created",
    numeric: true,
    hint: "Total quotes created for this client.",
  },
  {
    key: "quotes_sent_to_client",
    label: "Quotes sent to client",
    numeric: true,
    hint: "Quotes with status sent_to_client or client_accepted.",
  },
  {
    key: "notes_count",
    label: "Agent notes",
    numeric: true,
    hint: "Number of internal agent notes on the client.",
  },
  {
    key: "documents_count",
    label: "Documents uploaded",
    numeric: true,
    hint: "Number of documents the client has uploaded.",
  },
  {
    key: "has_transcript_insights",
    label: "Has transcript insights",
    numeric: true,
    hint: "1 when AI transcript insights exist, else 0.",
  },
];

/** One condition in a gate rule's chain. */
export interface GateCondition {
  /** Fact key: a curated key or `field:<dottedPath>`. */
  fact: string;
  operator: GateOperator;
  /** Comparison value (ignored for valueless operators). */
  value?: string | number | null;
}

/**
 * A stage-gate rule. Stored one-per-doc in `stage_gate_rules` (doc id === id).
 */
export interface StageGateRule {
  /** Stable doc id. */
  id: string;
  /** The stage a client is being moved INTO that this rule guards. */
  targetStage: string;
  /** AND ("all") or OR ("any") across `conditions`. */
  logic: GateLogic;
  conditions: GateCondition[];
  /** Message shown to the operator when the move is blocked. */
  message: string;
  /** Master on/off. */
  enabled: boolean;
  /** Human label for the editor UI. */
  label: string;
  updatedBy?: string;
  updatedAt?: string;
  createdAt?: string;
}