/**
 * API/journeys/aggregate.ts — raw events → journey_daily + journey_exposures,
 * and journey_daily rows → the staff read models (pure, no IO).
 * ──────────────────────────────────────────────────────────────────────────
 * buildDay(): one UTC day of events. Visitors are grouped by visitorId; their
 * dimensions come from their first event that day. Each visitor counts once
 * per row: the "-" row, and one row per experiment variant they carried.
 * Step-to-step times are measured inside the day (the previous step in the
 * same ordered list reached earlier that day). Same events → same docs, so
 * re-running a day is idempotent.
 *
 * Read side: summing a range adds distinct-per-day counts (a visitor who
 * reaches the same step on two days counts twice; steps are mostly once per
 * person). Experiment results do not use these rows: they read
 * journey_exposures, which count each visitor once.
 */

import {
  ALL_JOURNEY_STEPS,
  type CountryCode,
  type ExperimentResult,
  type Experiment,
  FUNNEL_STEPS,
  type FunnelStepId,
  type JourneyChannel,
  type JourneyDaily,
  type JourneyDevice,
  type JourneyEvent,
  type JourneyExposure,
  type JourneyFilters,
  type JourneyFunnelKind,
  type JourneyFunnelRow,
  type JourneyPath,
  type JourneySource,
  type JourneyStuck,
  journeyStepLabel,
  LAWYER_STEPS,
  OUTBOUND_STEPS,
  type Outreach,
  type OutboundRow,
  type PageTime,
  PLAN_STANDARD,
} from "../../schemas/contracts.ts";
import { histAdd, histMerge, histPercentile, probabilityBest, sampleSizePerVariant, SRM_P, srmPValue, wilson } from "./stats.ts";

const MEMBER_IDS = FUNNEL_STEPS.map((s) => s.id) as FunnelStepId[];
const OUTBOUND_IDS = OUTBOUND_STEPS.map((s) => s.id) as FunnelStepId[];
const LAWYER_IDS = LAWYER_STEPS.map((s) => s.id) as FunnelStepId[];

/** Ordered step ids of a funnel. The outbound funnel continues into the member funnel. */
export function funnelSteps(kind: JourneyFunnelKind): FunnelStepId[] {
  if (kind === "lawyer") return LAWYER_IDS;
  if (kind === "outbound") return [...OUTBOUND_IDS, ...MEMBER_IDS];
  return MEMBER_IDS;
}

/** The step before `id` in its own ordered list (outreach_clicked → landing_view continues the chain). */
export function prevStep(id: FunnelStepId): FunnelStepId | null {
  const lists = [[...OUTBOUND_IDS, ...MEMBER_IDS], LAWYER_IDS];
  for (const l of lists) {
    const i = l.indexOf(id);
    if (i > 0) return l[i - 1];
    if (i === 0) return null;
  }
  return null;
}

export function nextStep(id: FunnelStepId): FunnelStepId | null {
  for (const l of [[...OUTBOUND_IDS, ...MEMBER_IDS], LAWYER_IDS]) {
    const i = l.indexOf(id);
    if (i >= 0) return l[i + 1] ?? null;
  }
  return null;
}

/** Rank of a member-funnel step (−1 for others). */
export const memberRank = (id: string | undefined): number => (id ? MEMBER_IDS.indexOf(id as FunnelStepId) : -1);

export const dayOf = (iso: string): string => iso.slice(0, 10);

export function dailyId(d: Pick<JourneyDaily, "day" | "source" | "channel" | "country" | "device" | "experiment" | "variant">, placeholder: boolean): string {
  return `${placeholder ? "ph_" : ""}${d.day}_${d.source}_${d.channel}_${d.country}_${d.device}_${d.experiment}~${d.variant}`;
}

export const exposureId = (experiment: string, visitorId: string, placeholder: boolean): string =>
  `${placeholder ? "ph_" : ""}${experiment}__${visitorId}`;

interface Visitor {
  id: string;
  placeholder: boolean;
  source: JourneySource;
  channel: JourneyChannel;
  country: CountryCode | "-";
  device: JourneyDevice;
  variants: Record<string, string>;
  variantFirstAt: Record<string, string>;
  events: JourneyEvent[];
}

function blankRow(v: Visitor, day: string, experiment: string, variant: string, builtAt: string): JourneyDaily {
  const row: JourneyDaily = {
    id: "",
    day,
    source: v.source,
    channel: v.channel,
    country: v.country,
    device: v.device,
    experiment,
    variant,
    visitors: 0,
    steps: {},
    stepMs: {},
    pages: {},
    transitions: {},
    exits: {},
    stepExits: {},
    dwellMs: {},
    formErrors: {},
    builtAt,
  };
  row.id = dailyId(row, v.placeholder);
  if (v.placeholder) row.placeholder = true;
  return row;
}

const inc = (o: Record<string, number>, k: string, n = 1) => (o[k] = (o[k] ?? 0) + n);

/** What one visitor contributes to a row (computed once, added to each of their rows). */
interface Contribution {
  steps: Partial<Record<FunnelStepId, number>>;
  stepMs: Partial<Record<FunnelStepId, number>>;
  pages: Record<string, { views: number; exits: number; ms: number[] }>;
  transitions: Set<string>;
  exits: Record<string, number>;
  stepExit?: { step: FunnelStepId; path: string; dwell: number };
  formErrors: Record<string, Record<string, number>>;
}

function contributionOf(v: Visitor): Contribution {
  const evs = v.events;
  const c: Contribution = { steps: {}, stepMs: {}, pages: {}, transitions: new Set(), exits: {}, formErrors: {} };
  // Steps: first time each was reached today.
  const reached = new Map<FunnelStepId, number>();
  for (const e of evs) {
    if (e.type === "step" && e.step && !reached.has(e.step)) reached.set(e.step, Date.parse(e.at));
  }
  for (const [s, t] of reached) {
    c.steps[s] = 1;
    const p = prevStep(s);
    const tp = p ? reached.get(p) : undefined;
    if (tp !== undefined && tp <= t) c.stepMs[s] = t - tp;
  }
  const ordered = [...reached.entries()].sort((a, b) => a[1] - b[1]);
  for (let i = 1; i < ordered.length; i++) c.transitions.add(`s:${ordered[i - 1][0]}>${ordered[i][0]}`);
  // Pages: per session, views in order; time on a view = heartbeat/exit durations, else gap to the next event.
  const bySession = new Map<string, JourneyEvent[]>();
  for (const e of evs) (bySession.get(e.sessionId) ?? bySession.set(e.sessionId, []).get(e.sessionId)!).push(e);
  for (const list of bySession.values()) {
    let lastView: string | null = null;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.type !== "page_view") continue;
      const page = (c.pages[e.path] ??= { views: 0, exits: 0, ms: [] });
      page.views++;
      let ms = 0;
      let j = i + 1;
      let sawDuration = false;
      for (; j < list.length && list[j].type !== "page_view"; j++) {
        if ((list[j].type === "heartbeat" || list[j].type === "exit") && list[j].path === e.path && typeof list[j].durationMs === "number") {
          ms += list[j].durationMs!;
          sawDuration = true;
        }
      }
      if (!sawDuration && i + 1 < list.length) ms = Math.min(30 * 60_000, Math.max(0, Date.parse(list[i + 1].at) - Date.parse(e.at)));
      if (sawDuration || i + 1 < list.length) page.ms = histAdd(page.ms.length ? page.ms : undefined, ms);
      if (!lastView) c.transitions.add(`p:(entry)>${e.path}`); // where visits start
      else if (lastView !== e.path) c.transitions.add(`p:${lastView}>${e.path}`);
      lastView = e.path;
    }
    if (lastView) {
      inc(c.exits, lastView);
      c.pages[lastView].exits++;
    }
  }
  // Where the furthest step of the day was left, and how long they stayed.
  if (ordered.length) {
    const [step, t] = ordered[ordered.length - 1];
    const last = evs[evs.length - 1];
    const lastPath = [...evs].reverse().find((e) => e.type === "page_view")?.path ?? last.path;
    c.stepExit = { step, path: lastPath, dwell: Math.max(0, Date.parse(last.at) - t) };
  }
  for (const e of evs) {
    if (e.type !== "form_error" || !e.target) continue;
    const k = e.step ?? "-";
    inc((c.formErrors[k] ??= {}), e.target);
  }
  return c;
}

function addTo(row: JourneyDaily, c: Contribution): void {
  row.visitors++;
  for (const [s, n] of Object.entries(c.steps)) inc(row.steps as Record<string, number>, s, n!);
  for (const [s, ms] of Object.entries(c.stepMs)) {
    const k = s as FunnelStepId;
    row.stepMs[k] = histAdd(row.stepMs[k], ms!);
  }
  for (const [path, p] of Object.entries(c.pages)) {
    const r = (row.pages[path] ??= { views: 0, exits: 0, ms: [] });
    r.views += p.views;
    r.exits += p.exits;
    if (p.ms.length) r.ms = histMerge(r.ms.length ? r.ms : undefined, p.ms);
  }
  for (const t of c.transitions) inc(row.transitions, t);
  for (const [p, n] of Object.entries(c.exits)) inc(row.exits, p, n);
  if (c.stepExit) {
    inc((row.stepExits[c.stepExit.step] ??= {}), c.stepExit.path);
    row.dwellMs[c.stepExit.step] = histAdd(row.dwellMs[c.stepExit.step], c.stepExit.dwell);
  }
  for (const [s, targets] of Object.entries(c.formErrors)) for (const [t, n] of Object.entries(targets)) inc((row.formErrors[s] ??= {}), t, n);
}

export interface DayBuild {
  daily: JourneyDaily[];
  /** Exposures seen this day (first exposure today and steps today), to merge with stored ones. */
  exposures: JourneyExposure[];
}

/** Pure: one day of events → daily rows and exposures. */
export function buildDay(events: JourneyEvent[], day: string, builtAt: string, runningKeys?: ReadonlySet<string>): DayBuild {
  const visitors = new Map<string, Visitor>();
  const sorted = events.filter((e) => dayOf(e.at) === day).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  for (const e of sorted) {
    const ph = e.placeholder === true;
    const key = `${ph ? "ph" : "r"}:${e.visitorId}`;
    let v = visitors.get(key);
    if (!v) {
      v = { id: e.visitorId, placeholder: ph, source: e.source, channel: e.channel, country: e.country ?? "-", device: e.device, variants: {}, variantFirstAt: {}, events: [] };
      visitors.set(key, v);
    }
    if (v.country === "-" && e.country) v.country = e.country;
    for (const [k, x] of Object.entries(e.variants ?? {})) {
      if (runningKeys && !runningKeys.has(k)) continue;
      if (!v.variants[k]) {
        v.variants[k] = x;
        v.variantFirstAt[k] = e.at;
      }
    }
    v.events.push(e);
  }
  const rows = new Map<string, JourneyDaily>();
  const exposures: JourneyExposure[] = [];
  for (const v of visitors.values()) {
    const c = contributionOf(v);
    const keys: Array<[string, string]> = [["-", "-"], ...Object.entries(v.variants)];
    for (const [exp, variant] of keys) {
      const proto = blankRow(v, day, exp, variant, builtAt);
      const row = rows.get(proto.id) ?? (rows.set(proto.id, proto), proto);
      addTo(row, c);
    }
    for (const [exp, variant] of Object.entries(v.variants)) {
      const firstAt = v.variantFirstAt[exp];
      const steps: JourneyExposure["steps"] = {};
      for (const e of v.events) if (e.type === "step" && e.step && e.at >= firstAt && !steps[e.step]) steps[e.step] = e.at;
      const x: JourneyExposure = { id: exposureId(exp, v.id, v.placeholder), experiment: exp, variant, visitorId: v.id, source: v.source, firstAt, steps };
      if (v.placeholder) x.placeholder = true;
      exposures.push(x);
    }
  }
  return { daily: [...rows.values()].sort((a, b) => a.id.localeCompare(b.id)), exposures };
}

/**
 * Pure: merge a day's exposures into the stored ones. The earliest firstAt
 * and variant win; each step keeps its earliest time at or after firstAt.
 * Returns only the docs that changed.
 */
export function mergeExposures(stored: ReadonlyMap<string, JourneyExposure>, fresh: JourneyExposure[]): JourneyExposure[] {
  const changed: JourneyExposure[] = [];
  for (const f of fresh) {
    const s = stored.get(f.id);
    if (!s) {
      changed.push(f);
      continue;
    }
    const base = s.firstAt <= f.firstAt ? s : { ...f, steps: {} };
    const steps: JourneyExposure["steps"] = { ...(base === s ? s.steps : {}) };
    for (const src of [s.steps, f.steps]) {
      for (const [k, at] of Object.entries(src ?? {})) {
        const id = k as FunnelStepId;
        if (!at || at < base.firstAt) continue;
        if (!steps[id] || at < steps[id]!) steps[id] = at;
      }
    }
    const next: JourneyExposure = { ...base, steps };
    if (JSON.stringify(next) !== JSON.stringify(s)) changed.push(next);
  }
  return changed;
}

// ─── Read side ────────────────────────────────────────────────────────────

export function matchesFilters(r: JourneyDaily, f: JourneyFilters): boolean {
  if (f.source && r.source !== f.source) return false;
  if (f.channel && r.channel !== f.channel) return false;
  if (f.country && r.country !== f.country) return false;
  if (f.device && r.device !== f.device) return false;
  if (f.excludePlaceholder && r.placeholder) return false;
  if (f.experiment) {
    if (r.experiment !== f.experiment) return false;
    if (f.variant && r.variant !== f.variant) return false;
  } else if (r.experiment !== "-") return false;
  return true;
}

export function funnelRows(rows: JourneyDaily[], kind: JourneyFunnelKind): JourneyFunnelRow[] {
  const ids = funnelSteps(kind);
  const out: JourneyFunnelRow[] = [];
  let start = 0;
  let prev = 0;
  ids.forEach((step, i) => {
    let visitors = 0;
    let hist: number[] | undefined;
    for (const r of rows) {
      visitors += r.steps[step] ?? 0;
      if (r.stepMs[step]) hist = histMerge(hist, r.stepMs[step]);
    }
    if (i === 0) start = visitors;
    out.push({
      step,
      label: journeyStepLabel(step),
      visitors,
      conversionFromPrev: i === 0 ? 1 : prev > 0 ? visitors / prev : 0,
      conversionFromStart: start > 0 ? visitors / start : 0,
      medianMsFromPrev: i === 0 ? null : histPercentile(hist, 0.5),
      p75MsFromPrev: i === 0 ? null : histPercentile(hist, 0.75),
      dropOff: i === 0 ? 0 : Math.max(0, prev - visitors),
    });
    prev = visitors;
  });
  return out;
}

const top = (o: Record<string, number>, n: number) =>
  Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);

export function pathsOf(rows: JourneyDaily[], limit = 30): { steps: JourneyPath[]; pages: JourneyPath[]; exits: { path: string; count: number }[] } {
  const t: Record<string, number> = {};
  const exits: Record<string, number> = {};
  for (const r of rows) {
    for (const [k, n] of Object.entries(r.transitions)) inc(t, k, n);
    for (const [k, n] of Object.entries(r.exits)) inc(exits, k, n);
  }
  const split = (prefix: string) =>
    top(Object.fromEntries(Object.entries(t).filter(([k]) => k.startsWith(prefix))), limit).map(([k, visitors]) => {
      const [from, to] = k.slice(prefix.length).split(">");
      return { from, to, visitors };
    });
  return { steps: split("s:"), pages: split("p:"), exits: top(exits, 20).map(([path, count]) => ({ path, count })) };
}

export function stuckOf(rows: JourneyDaily[], kind: JourneyFunnelKind): JourneyStuck[] {
  const ids = funnelSteps(kind);
  return ids.map((step) => {
    let reached = 0;
    let next = 0;
    let hist: number[] | undefined;
    const exits: Record<string, number> = {};
    const errors: Record<string, number> = {};
    const nx = nextStep(step);
    for (const r of rows) {
      reached += r.steps[step] ?? 0;
      if (nx) next += r.steps[nx] ?? 0;
      if (r.dwellMs[step]) hist = histMerge(hist, r.dwellMs[step]);
      for (const [p, n] of Object.entries(r.stepExits[step] ?? {})) inc(exits, p, n);
      for (const [t, n] of Object.entries(r.formErrors[step] ?? {})) inc(errors, t, n);
    }
    return {
      step,
      label: journeyStepLabel(step),
      stuckCount: nx ? Math.max(0, reached - next) : 0,
      medianDwellMs: histPercentile(hist, 0.5),
      topExitPaths: top(exits, 5).map(([path, count]) => ({ path, count })),
      topFormErrors: top(errors, 5).map(([target, count]) => ({ target, count })),
    };
  });
}

export function pagesOf(rows: JourneyDaily[], limit = 50): PageTime[] {
  const acc = new Map<string, { views: number; exits: number; ms?: number[] }>();
  for (const r of rows) {
    for (const [path, p] of Object.entries(r.pages)) {
      const a = acc.get(path) ?? { views: 0, exits: 0 };
      a.views += p.views;
      a.exits += p.exits;
      if (p.ms?.length) a.ms = histMerge(a.ms, p.ms);
      acc.set(path, a);
    }
  }
  return [...acc.entries()]
    .map(([path, a]) => ({ path, views: a.views, medianMs: histPercentile(a.ms, 0.5), p75Ms: histPercentile(a.ms, 0.75), exitRate: a.views ? a.exits / a.views : 0 }))
    .sort((a, b) => b.views - a.views || a.path.localeCompare(b.path))
    .slice(0, limit);
}

export const MEMBER_REVENUE_CENTS = PLAN_STANDARD.activationCents + PLAN_STANDARD.monthlyCents;

export function outboundRows(list: Outreach[]): OutboundRow[] {
  const groups = new Map<string, OutboundRow>();
  const reached = (o: Outreach, step: FunnelStepId) => memberRank(o.convertedStep) >= memberRank(step);
  for (const o of list) {
    const k = `${o.campaign}|${o.channel}`;
    const g = groups.get(k) ?? { campaign: o.campaign, channel: o.channel, sent: 0, opened: 0, clicked: 0, checkStarted: 0, accountCreated: 0, activationPaid: 0, revenueCents: 0 };
    g.sent++;
    if (o.openedAt) g.opened++;
    if (o.clickedAt) g.clicked++;
    if (reached(o, "check_start")) g.checkStarted++;
    if (reached(o, "account_created")) g.accountCreated++;
    if (reached(o, "activation_paid")) {
      g.activationPaid++;
      g.revenueCents += MEMBER_REVENUE_CENTS;
    }
    groups.set(k, g);
  }
  return [...groups.values()].sort((a, b) => b.sent - a.sent || a.campaign.localeCompare(b.campaign));
}

/** Pure: experiment results from its exposures (one per visitor). The first variant is the control. */
export function experimentResult(exp: Pick<Experiment, "id" | "variants" | "primaryStep" | "guardrailSteps">, exposures: JourneyExposure[], opts: { excludePlaceholder?: boolean; draws?: number } = {}): ExperimentResult {
  const rows = exposures.filter((x) => !opts.excludePlaceholder || !x.placeholder);
  const arms = exp.variants.map((v) => {
    const mine = rows.filter((x) => x.variant === v.key);
    const conversions = mine.filter((x) => !!x.steps?.[exp.primaryStep]).length;
    const guardrails = (exp.guardrailSteps ?? []).map((step) => ({ step, rate: mine.length ? mine.filter((x) => !!x.steps?.[step]).length / mine.length : 0 }));
    return { v, visitors: mine.length, conversions, guardrails };
  });
  const pb = probabilityBest(arms.map((a) => ({ visitors: a.visitors, conversions: a.conversions })), opts.draws);
  const control = arms[0];
  const controlRate = control && control.visitors ? control.conversions / control.visitors : 0;
  const needed = sampleSizePerVariant(controlRate);
  const p = srmPValue(arms.map((a) => a.visitors), exp.variants.map((v) => v.weight));
  return {
    experimentId: exp.id,
    variants: arms.map((a, i) => {
      const rate = a.visitors ? a.conversions / a.visitors : 0;
      return {
        key: a.v.key,
        name: a.v.name,
        visitors: a.visitors,
        conversions: a.conversions,
        rate,
        liftVsControl: i === 0 || controlRate === 0 ? null : (rate - controlRate) / controlRate,
        probabilityBest: pb[i] ?? 0,
        ci95: wilson(a.conversions, a.visitors),
        ...(a.guardrails.length ? { guardrails: a.guardrails } : {}),
      };
    }),
    sampleSizeNeeded: needed,
    enoughData: arms.length > 1 && arms.every((a) => a.visitors >= needed),
    srmWarning: p < SRM_P,
  };
}

/** Every step id the module knows (for validation in routes). */
export const KNOWN_STEPS: ReadonlySet<string> = new Set(ALL_JOURNEY_STEPS.map((s) => s.id));
