/**
 * API/journeys/assign.ts — sticky A/B assignment (pure).
 * A visitor's variant is a deterministic hash of experiment key + visitorId
 * over the variant weights: the same visitor always gets the same variant,
 * with nothing stored. Changing weights or variants of a running experiment
 * would move people, so the staff routes refuse it.
 */

import type { Experiment, ExperimentConfig, JourneySource } from "../../schemas/contracts.ts";

/** 32-bit FNV-1a with a murmur3 finalizer (good spread for short ids). */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Unit-interval position of a visitor for an experiment. */
export function unitHash(experimentKey: string, visitorId: string): number {
  return hash32(`${experimentKey}:${visitorId}`) / 4294967296;
}

export function assignVariant(visitorId: string, exp: Pick<Experiment, "key" | "variants">): string | null {
  const variants = exp.variants.filter((v) => v.weight > 0);
  if (!variants.length) return null;
  const total = variants.reduce((s, v) => s + v.weight, 0);
  const u = unitHash(exp.key, visitorId) * total;
  let cum = 0;
  for (const v of variants) {
    cum += v.weight;
    if (u < cum) return v.key;
  }
  return variants[variants.length - 1].key;
}

export function inAudience(exp: Pick<Experiment, "audience">, source: JourneySource): boolean {
  return exp.audience === "all" || exp.audience === source;
}

/** Running experiments the visitor is in → variant keys. */
export function assignmentsFor(
  visitorId: string,
  experiments: Array<Pick<Experiment, "key" | "variants" | "audience" | "status">>,
  source: JourneySource,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of experiments) {
    if (e.status !== "running" || !inAudience(e, source)) continue;
    const v = assignVariant(visitorId, e);
    if (v) out[e.key] = v;
  }
  return out;
}

export function configOf(e: Experiment): ExperimentConfig {
  return { key: e.key, surface: e.surface, variants: e.variants.map((v) => ({ key: v.key, name: v.name, weight: v.weight })), audience: e.audience, status: e.status };
}
