/**
 * API/journeys/experiments.ts — experiment input checks and status moves (pure).
 * Status: draft → running ⇄ paused → ended. Variants, weights and the key
 * can change only while the experiment is a draft (sticky assignment hashes
 * the key over the weights, so changing them would move people).
 */

import {
  type Experiment,
  type ExperimentAudience,
  type ExperimentInput,
  type ExperimentStatus,
  type ExperimentVariant,
  type FunnelStepId,
  isFunnelStepId,
} from "../../schemas/contracts.ts";

type Doc = Record<string, unknown>;

export const EXPERIMENT_KEY_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const VARIANT_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SURFACE_RE = /^[A-Za-z0-9/._:-]{1,80}$/;
const AUDIENCES: readonly ExperimentAudience[] = ["all", "inbound", "outbound"];

export class ExperimentError extends Error {
  constructor(readonly status: number, message: string, readonly field?: string) {
    super(message);
  }
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function variantsOf(v: unknown): ExperimentVariant[] {
  if (!Array.isArray(v) || v.length < 2 || v.length > 4) throw new ExperimentError(400, "Give 2 to 4 variants; the first is the control.", "variants");
  const seen = new Set<string>();
  return v.map((raw, i) => {
    const o = (raw ?? {}) as Doc;
    const key = text(o.key, 32).toLowerCase();
    if (!VARIANT_KEY_RE.test(key) || seen.has(key)) throw new ExperimentError(400, `Variant ${i + 1} needs a unique short key (a-z, 0-9, - or _).`, "variants");
    seen.add(key);
    const name = text(o.name, 60) || key;
    const weight = Number(o.weight ?? 1);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 100) throw new ExperimentError(400, `Variant ${key}: weight must be above 0 and at most 100.`, "variants");
    return { key, name, weight };
  });
}

function stepOf(v: unknown, field: string): FunnelStepId {
  if (!isFunnelStepId(v)) throw new ExperimentError(400, "Pick a step from the funnel.", field);
  return v;
}

/** Pure: a full input for a new experiment. */
export function parseExperimentInput(body: unknown): ExperimentInput {
  const b = (body ?? {}) as Doc;
  const key = text(b.key, 48).toLowerCase();
  if (!EXPERIMENT_KEY_RE.test(key)) throw new ExperimentError(400, "The key is a short slug used in code, e.g. hero-headline.", "key");
  const name = text(b.name, 120);
  if (!name) throw new ExperimentError(400, "Give the experiment a name.", "name");
  const surface = text(b.surface, 80);
  if (!SURFACE_RE.test(surface)) throw new ExperimentError(400, "Surface is a page path (/check) or a component id (home.hero).", "surface");
  const audience = (b.audience ?? "all") as ExperimentAudience;
  if (!AUDIENCES.includes(audience)) throw new ExperimentError(400, "Audience is all, inbound or outbound.", "audience");
  const out: ExperimentInput = {
    key,
    name,
    hypothesis: text(b.hypothesis, 1000),
    surface,
    variants: variantsOf(b.variants),
    primaryStep: stepOf(b.primaryStep, "primaryStep"),
    audience,
  };
  if (Array.isArray(b.guardrailSteps)) {
    const g = [...new Set(b.guardrailSteps.slice(0, 5).map((s) => stepOf(s, "guardrailSteps")))].filter((s) => s !== out.primaryStep);
    if (g.length) out.guardrailSteps = g;
  }
  return out;
}

/** Pure: apply a PATCH. Name, hypothesis, surface wording, steps and audience can change; key and variants only in draft. */
export function applyPatch(e: Experiment, body: unknown, now: string): Experiment {
  const b = (body ?? {}) as Doc;
  const locked = e.status !== "draft";
  if (locked && (b.key !== undefined && b.key !== e.key)) throw new ExperimentError(409, "The key cannot change once the experiment has started.", "key");
  if (locked && b.variants !== undefined && JSON.stringify(variantsOf(b.variants)) !== JSON.stringify(e.variants)) {
    throw new ExperimentError(409, "Variants and weights cannot change once the experiment has started. End it and start a new one.", "variants");
  }
  if (locked && b.audience !== undefined && b.audience !== e.audience) throw new ExperimentError(409, "The audience cannot change once the experiment has started.", "audience");
  if (e.status === "ended") throw new ExperimentError(409, "This experiment has ended.");
  const merged = parseExperimentInput({ ...e, ...b, key: b.key ?? e.key, variants: b.variants ?? e.variants });
  return { ...e, ...merged, ...(merged.guardrailSteps ? {} : { guardrailSteps: undefined }), updatedAt: now };
}

export type ExperimentAction = "start" | "pause" | "end" | "declare-winner";

/** Pure: a status move. */
export function transition(e: Experiment, action: ExperimentAction, now: string, winner?: unknown): Experiment {
  const to = (status: ExperimentStatus, extra: Partial<Experiment> = {}): Experiment => ({ ...e, status, updatedAt: now, ...extra });
  switch (action) {
    case "start":
      if (e.status !== "draft" && e.status !== "paused") throw new ExperimentError(409, `A ${e.status} experiment cannot start.`);
      return to("running", e.startedAt ? {} : { startedAt: now });
    case "pause":
      if (e.status !== "running") throw new ExperimentError(409, "Only a running experiment can pause.");
      return to("paused");
    case "end":
      if (e.status !== "running" && e.status !== "paused") throw new ExperimentError(409, "Only a running or paused experiment can end.");
      return to("ended", { endedAt: now });
    case "declare-winner": {
      if (e.status === "draft") throw new ExperimentError(409, "A draft has no results yet.");
      const key = typeof winner === "string" ? winner : "";
      if (!e.variants.some((v) => v.key === key)) throw new ExperimentError(400, "Pick one of the experiment's variants.", "variant");
      return to("ended", { winner: key, endedAt: e.endedAt ?? now });
    }
  }
}
