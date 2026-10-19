/**
 * schemas/collections/pipeline.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Document schemas for pipeline/stage configuration collections.
 */
import type { Extensible, IsoTimestamp } from "../types.ts";

/** stage_config — a pipeline stage definition. */
export interface StageConfigDoc extends Extensible {
  id: string;
  key: string;
  label: string;
  order: number;
  color?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** stage_gates — a stage gate rule. */
export interface StageGateDoc extends Extensible {
  id: string;
  stage: string;
  gate: string;
  condition?: string;
  enabled: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** stage_gate_rules — a stage gate rule (alternate collection name). */
export interface StageGateRuleDoc extends Extensible {
  id: string;
  stage: string;
  gate: string;
  condition?: string;
  enabled: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** overview_fields — an overview field definition. */
export interface OverviewFieldDoc extends Extensible {
  id: string;
  key: string;
  label: string;
  type?: string;
  order?: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}