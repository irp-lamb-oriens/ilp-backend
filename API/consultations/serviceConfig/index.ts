/**
 * API/consultations/serviceConfig/index.ts
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Service-config resolver for the ILP consultation intake.
 *
 * ILP's full per-service field configs (legal, immigration, corporate,
 * real_estate, notary) are not yet ported; only the shared `types.ts` contract
 * exists. The conversational agent resolves a config here so a future port can
 * drop in real field lists without touching the agent. Until then, the resolver
 * returns an empty-field config, which makes the agent's service-aware layer
 * degrade gracefully to the base legal intake defined in agent-context.ts.
 */

import type { ServiceConfig } from "./types.ts";

export { evaluateCondition } from "./types.ts";
export type {
  ServiceConfig,
  ServiceFieldDef,
  ServiceType,
  ServiceFieldType,
  ServiceFieldOption,
  FieldCondition,
} from "./types.ts";

const EMPTY_CONFIG: ServiceConfig = {
  type: "legal_consultation",
  label: "Legal consultation",
  fields: [],
  chatbotFields: [],
  pricing: {
    currency: "USD",
    baseFeeMinor: 0,
    defaultDurationMinutes: 30,
  },
};

/**
 * Resolve a config from a single type string, a comma/plus-separated list, or
 * an array of types. Returns an empty-field config until the per-service field
 * lists are ported, so callers always receive a valid `ServiceConfig`.
 */
export function getServiceConfig(
  _type: string | string[] | undefined | null,
): ServiceConfig {
  return EMPTY_CONFIG;
}