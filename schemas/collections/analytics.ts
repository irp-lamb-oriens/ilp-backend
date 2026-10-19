/**
 * schemas/collections/analytics.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Document schemas for LLM/analytics collections.
 */
import type { Extensible, IsoTimestamp } from "../types.ts";

/** llm_costs — a recorded LLM cost entry. */
export interface LlmCostDoc extends Extensible {
  id: string;
  costUSD: number;
  model?: string;
  provider?: string;
  createdAt: IsoTimestamp;
}

/** evo_assignments — an evolution assignment. */
export interface EvoAssignmentDoc extends Extensible {
  id: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** evo_exposures — an evolution exposure. */
export interface EvoExposureDoc extends Extensible {
  id: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** evo_interactions — an evolution interaction. */
export interface EvoInteractionDoc extends Extensible {
  id: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** metrics — a metrics counter document. */
export interface MetricsDoc extends Extensible {
  id: string;
  [key: string]: unknown;
}