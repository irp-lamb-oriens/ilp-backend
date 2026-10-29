/**
 * scripts/journeyPlaceholderData.ts — JOURNEYS placeholder data (pure, no IO).
 * ──────────────────────────────────────────────────────────────────────────
 * addJourneyData(seed) adds ~6 weeks of first-party journeys to a placeholder
 * seed (scripts/placeholderData.ts output), so the staff Journeys pages are
 * full in a demo:
 *   - several thousand visitors over six countries, inbound channels (organic,
 *     direct, referral, utm campaigns) and outbound campaigns (outreach emails,
 *     an imported lead list, CSM call-backs) with sent → open → click;
 *   - realistic drop-offs: a big one inside the check at question 5 (form
 *     errors and exits), and between results and sign-up; time on pages and
 *     between steps drawn from skewed distributions;
 *   - the seed's own leads and members walk the same funnel (members up to
 *     activation, calls, handoffs and renewals from their real records), so
 *     "stuck people" are the seed's leads and members with `journeyTrack`;
 *   - two running experiments (hero-headline, check-length) and one ended with
 *     a winner (results-cta); assignment uses the real hash (API/journeys/assign.ts).
 * Daily rows and exposures are built with the real aggregator for every day;
 * raw events are kept only for the last RAW_DAYS days (fewer documents to
 * write; the job re-aggregates only today/yesterday). Every doc has a ph_ id,
 * placeholder: true and the seed's batch. Same seed + same day → same docs.
 */

import { COLLECTIONS, type CountryCode, type Experiment, FUNNEL_STEPS, type FunnelStepId, JOURNEY_TRACK_FIELD, type JourneyChannel, type JourneyDaily, type JourneyDevice, type JourneyEvent, type JourneyExposure, type JourneySource, type JourneyTrack, type Outreach } from "../schemas/contracts.ts";
import { assignVariant } from "../API/journeys/assign.ts";
import { buildDay, memberRank, mergeExposures } from "../API/journeys/aggregate.ts";
import { type Doc, Rng, type SeedData } from "./placeholderData.ts";

const DAY = 86_400_000;
const MIN = 60_000;
const SEC = 1000;
export const JOURNEY_WINDOW_DAYS = 42;
export const RAW_DAYS = 14;
const VISITORS_BY_MEMBERS = (members: number) => (members <= 20 ? 900 : members <= 80 ? 3200 : 6500);

const COUNTRY_W: Array<[CountryCode, number]> = [["CR", 38], ["MX", 20], ["PA", 15], ["CO", 11], ["ES", 9], ["PT", 7]];
const DEVICE_W: Array<[JourneyDevice, number]> = [["phone", 58], ["desktop", 34], ["tablet", 8]];
const INBOUND_W: Array<[JourneyChannel, number]> = [["organic", 40], ["direct", 20], ["referral", 15], ["campaign", 25]];
const UTM_CAMPAIGNS = ["cr-retirement-guide", "pa-friendly-nations", "mx-fideicomiso-explainer", "expat-tax-season"];
const REFERRERS = ["expat-forum", "newsletter", "partner-blog"];
const OUTBOUND_CAMPAIGNS: Array<{ campaign: string; channel: Outreach["channel"]; weight: number; open: number; click: number }> = [
  { campaign: "cr-retirees-nov", channel: "email_outreach", weight: 40, open: 0.52, click: 0.34 },
  { campaign: "pa-property-owners", channel: "email_outreach", weight: 20, open: 0.41, click: 0.22 },
  { campaign: "import-expat-fair-oct", channel: "import", weight: 25, open: 0.33, click: 0.18 },
  { campaign: "csm-callbacks", channel: "csm_call", weight: 15, open: 0.9, click: 0.7 },
];
const SLUG: Record<CountryCode, string> = { CO: "colombia", CR: "costa-rica", MX: "mexico", PA: "panama", PT: "portugal", ES: "spain" };

export interface JourneySeed {
  experiments: Experiment[];
  events: JourneyEvent[]; // raw events kept (last RAW_DAYS days)
  allEvents: number; // events generated before trimming (the aggregates count them all)
  daily: JourneyDaily[];
  exposures: JourneyExposure[];
  outreach: Outreach[];
  tracks: number;
}

/** Log-normal draw with a median and a spread. */
function lognormal(rng: Rng, median: number, sigma: number): number {
  let u = 0;
  while (u === 0) u = rng.next();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
  return Math.max(1, Math.round(median * Math.exp(sigma * z)));
}

const iso = (ms: number) => new Date(ms).toISOString();

function experimentsFor(now: number, by: string, stamp: Doc): Experiment[] {
  const mk = (id: string, e: Omit<Experiment, "id" | "createdBy" | "createdAt" | "updatedAt">, created: number): Experiment =>
    ({ id, ...e, createdBy: by, createdAt: iso(created), updatedAt: iso(e.endedAt ? Date.parse(e.endedAt) : created), ...stamp } as Experiment);
  return [
    mk("ph_exp_hero_headline", {
      key: "hero-headline", name: "Home hero: plain promise vs. deadline fear", hypothesis: "A plain promise (\"Know what applies to you abroad\") gets more people to start the free check than the deadline-fear headline.",
      surface: "home.hero", variants: [{ key: "control", name: "Deadline headline", weight: 1 }, { key: "plain", name: "Plain promise", weight: 1 }],
      primaryStep: "check_start", guardrailSteps: ["check_finish"], audience: "all", status: "running", startedAt: iso(now - 20 * DAY),
    }, now - 22 * DAY),
    mk("ph_exp_check_length", {
      key: "check-length", name: "Free check: 5 questions vs. 8", hypothesis: "A 5-question check loses fewer people at question 5 without fewer sign-ups.",
      surface: "/check", variants: [{ key: "full", name: "8 questions", weight: 1 }, { key: "short", name: "5 questions", weight: 1 }],
      primaryStep: "check_finish", guardrailSteps: ["signup_start", "account_created"], audience: "inbound", status: "running", startedAt: iso(now - 12 * DAY),
    }, now - 13 * DAY),
    mk("ph_exp_results_cta", {
      key: "results-cta", name: "Results page: save deadlines vs. book a call", hypothesis: "\"Save my deadlines\" gets more free accounts than \"Book a call\".",
      surface: "/check/results", variants: [{ key: "book", name: "Book a call", weight: 1 }, { key: "save", name: "Save my deadlines", weight: 1 }],
      primaryStep: "signup_start", audience: "all", status: "ended", startedAt: iso(now - 41 * DAY), endedAt: iso(now - 23 * DAY), winner: "save",
    }, now - 42 * DAY),
  ];
}

interface Person {
  kind: "client" | "lead";
  id: string;
  doc: Doc;
  /** Server-side steps from the seed's records, with times. */
  later: Array<[FunnelStepId, number]>;
  /** The member funnel up to here happens in the browser at `at`. */
  browserUpTo: FunnelStepId;
  at: number;
  country?: CountryCode;
}

/** Pure: add the journey collections to a seed (mutates `data`, returns what was added). */
export function addJourneyData(data: SeedData, opts: { seed: number; visitors?: number }): JourneySeed {
  const now = Date.parse(data.now);
  const stamp = { placeholder: true, placeholderBatch: data.batch };
  const rng = new Rng(opts.seed * 131 + 7);
  const C = (name: string) => (data.collections[name] ?? []) as Doc[];
  const start = now - JOURNEY_WINDOW_DAYS * DAY;
  const staffEmail = String(C(COLLECTIONS.csmTasks).find((t) => t.ownerEmail)?.ownerEmail ?? "mariana.quesada@example.com");
  const experiments = experimentsFor(now, staffEmail, stamp);
  const events: JourneyEvent[] = [];
  const outreach: Outreach[] = [];
  let evN = 0;
  let vN = 0;
  let oN = 0;

  const activeExps = (t: number) => experiments.filter((e) => Date.parse(e.startedAt!) <= t && (!e.endedAt || Date.parse(e.endedAt) > t));

  /** One visitor's browser session walking the member funnel as far as `upTo` (or as far as the dice allow). */
  function walk(v: { id: string; source: JourneySource; channel: JourneyChannel; country: CountryCode; device: JourneyDevice; outreachId?: string; utm?: JourneyEvent["utm"] }, t0: number, upTo: FunnelStepId | null, maxStep?: FunnelStepId): { reached: FunnelStepId | null; at: number; variants: Record<string, string> } {
    // Assigned up front; an experiment joins `variants` (and the exposure heartbeat is sent) only when its surface is seen.
    const assigned: Record<string, string> = {};
    for (const e of activeExps(t0)) {
      if (e.audience !== "all" && e.audience !== v.source) continue;
      const k = assignVariant(v.id, e);
      if (k) assigned[e.key] = k;
    }
    const variants: Record<string, string> = {};
    const sid = `${v.id}_s1`;
    let t = t0;
    let reached: FunnelStepId | null = null;
    const push = (type: JourneyEvent["type"], path: string, extra: Partial<JourneyEvent> = {}) => {
      const e: JourneyEvent = { id: `ph_jev_${String(++evN).padStart(7, "0")}`, visitorId: v.id, sessionId: sid, source: v.source, channel: v.channel, type, path, variants: { ...variants }, device: v.device, country: v.country, at: iso(Math.min(t, now - MIN)), ...extra, ...stamp } as JourneyEvent;
      if (v.outreachId) e.outreachId = v.outreachId;
      if (v.utm) e.utm = v.utm;
      events.push(e);
    };
    const page = (path: string, medianMs: number) => {
      push("page_view", path);
      const d = lognormal(rng, medianMs, 0.8);
      t += d;
      push("heartbeat", path, { durationMs: Math.min(d, 6 * 3600_000) });
    };
    const stepAt = (s: FunnelStepId, path: string) => {
      push("step", path, { step: s });
      reached = s;
    };
    const expose = (key: string, path: string) => {
      if (!assigned[key] || variants[key]) return;
      variants[key] = assigned[key];
      push("heartbeat", path, { durationMs: 0, target: `exposure.${key}` });
    };
    const forced = (s: FunnelStepId) => upTo !== null && memberRank(s) <= memberRank(upTo);
    const go = (s: FunnelStepId, p: number) => forced(s) || (upTo === null && (!maxStep || memberRank(s) <= memberRank(maxStep)) && rng.chance(p));
    const landing = v.channel === "campaign" || rng.chance(0.3) ? `/${SLUG[v.country]}` : "/";
    page(landing, 35 * SEC);
    stepAt("landing_view", landing);
    if (landing === "/") expose("hero-headline", landing);
    const done = () => ({ reached, at: t, variants });
    if (!go("check_start", variants["hero-headline"] === "plain" ? 0.53 : 0.45)) {
      if (rng.chance(0.3)) page(rng.pick(["/pricing", "/guides", `/${SLUG[v.country]}`]), 50 * SEC);
      return done();
    }
    t += lognormal(rng, 6 * SEC, 0.5);
    stepAt("check_start", "/check");
    push("click", landing, { target: "home.hero.cta", step: "landing_view" });
    expose("check-length", "/check");
    const short = variants["check-length"] === "short";
    page("/check", (short ? 95 : 150) * SEC);
    // Question 5 (property and company) is where people leave.
    if (!go("check_finish", short ? 0.74 : 0.61)) {
      if (rng.chance(0.55)) push("form_error", "/check", { target: rng.weighted([["q5", 70], ["q3", 15], ["q7", 15]] as const), step: "check_start" });
      push("exit", "/check", { durationMs: lognormal(rng, 40 * SEC, 0.6) });
      return done();
    }
    if (!short && rng.chance(0.18)) push("form_error", "/check", { target: "q5", step: "check_start" });
    stepAt("check_finish", "/check");
    t += lognormal(rng, 3 * SEC, 0.4);
    if (!go("results_view", 0.95)) return done();
    stepAt("results_view", "/check/results");
    page("/check/results", 85 * SEC);
    expose("results-cta", "/check/results");
    if (!go("deadlines_select", 0.47)) {
      push("exit", "/check/results", { durationMs: lognormal(rng, 20 * SEC, 0.6) });
      return done();
    }
    stepAt("deadlines_select", "/check/results");
    const ctaSave = variants["results-cta"] !== "book";
    if (!go("signup_start", ctaSave ? 0.55 : 0.33)) return done();
    push("click", "/check/results", { target: ctaSave ? "results.save" : "results.book", step: "deadlines_select" });
    stepAt("signup_start", "/deadlines/save");
    page("/deadlines/save", 55 * SEC);
    if (!go("account_created", 0.8)) {
      if (rng.chance(0.4)) push("form_error", "/deadlines/save", { target: "email", step: "signup_start" });
      return done();
    }
    stepAt("account_created", "/(server)");
    if (!go("join_start", 0.22)) return done();
    t += upTo ? lognormal(rng, 40 * MIN, 0.8) : lognormal(rng, 2 * DAY, 1.2);
    stepAt("join_start", "/join");
    page("/join", 4 * MIN);
    if (!forced("activation_paid")) push("exit", "/join", { durationMs: lognormal(rng, MIN, 0.6) });
    return done();
  }

  // ── Outreach records for outbound visitors ──
  const newOutreach = (camp: (typeof OUTBOUND_CAMPAIGNS)[number], at: number, person?: { clientId?: string; leadId?: string }) => {
    const o: Outreach = { id: `ph_o_${String(++oN).padStart(6, "0")}seed`, email: "", channel: camp.channel, campaign: camp.campaign, sentBy: staffEmail, sentAt: iso(at), ...person, ...stamp } as Outreach;
    // A stable fake hash (no address is hashed for placeholder data).
    o.email = (`ph${oN}`.padEnd(64, "0")).slice(0, 64);
    outreach.push(o);
    return o;
  };
  const serverStep = (vid: string, s: FunnelStepId, at: number, base: Pick<JourneyEvent, "source" | "channel" | "device" | "variants"> & { country?: CountryCode; outreachId?: string; clientId?: string; leadId?: string }) => {
    if (at > now) return;
    events.push({ id: `ph_jev_${String(++evN).padStart(7, "0")}`, visitorId: vid, sessionId: "server_side", type: "step", step: s, path: "/(server)", at: iso(at), ...base, ...stamp } as JourneyEvent);
  };

  function visitor(dayStart: number, person?: Person) {
    rng.reseed("visitor", ++vN);
    // Random-looking ids like the browser's (sequential ids correlate with the seeded streams).
    const id = `ph_vis_${String(vN).padStart(5, "0")}${Math.floor(rng.next() * 2 ** 32).toString(36)}${Math.floor(rng.next() * 2 ** 32).toString(36)}`;
    const outbound = person ? rng.chance(0.15) : rng.chance(0.16);
    const country = person?.country ?? rng.weighted(COUNTRY_W);
    const device = rng.weighted(DEVICE_W);
    const t0 = dayStart + (rng.int(7, 21) + 6) * 3600_000 + rng.int(0, 59) * MIN; // CR daytime (UTC-6)
    let channel: JourneyChannel;
    let outreachId: string | undefined;
    let utm: JourneyEvent["utm"];
    if (outbound) {
      const camp = rng.weighted(OUTBOUND_CAMPAIGNS.map((c) => [c, c.weight] as const));
      const sentAt = t0 - rng.int(2, 72) * 3600_000;
      const o = newOutreach(camp, Math.max(start, sentAt), person ? { [person.kind === "client" ? "clientId" : "leadId"]: person.id } : undefined);
      channel = camp.channel;
      const base = { source: "outbound" as const, channel, device, variants: {}, country, outreachId: o.id };
      const svid = `ph_srv_${o.id}`;
      serverStep(svid, "outreach_sent", Date.parse(o.sentAt), base);
      const opened = !!person || rng.chance(camp.open);
      if (!opened) return null;
      o.openedAt = iso(Math.min(now - MIN, Date.parse(o.sentAt) + rng.int(1, 30) * 3600_000));
      serverStep(svid, "outreach_opened", Date.parse(o.openedAt), base);
      if (!person && !rng.chance(camp.click / camp.open)) return null;
      o.clickedAt = iso(Math.min(now - MIN, Math.max(Date.parse(o.openedAt), t0 - MIN)));
      serverStep(svid, "outreach_clicked", Date.parse(o.clickedAt), base);
      outreachId = o.id;
    } else {
      channel = rng.weighted(INBOUND_W);
      if (channel === "campaign") utm = { source: rng.pick(["google", "facebook", "newsletter"]), medium: "cpc", campaign: rng.pick(UTM_CAMPAIGNS) };
      if (channel === "referral") utm = { source: rng.pick(REFERRERS) };
    }
    const v = { id, source: (outbound ? "outbound" : "inbound") as JourneySource, channel, country, device, outreachId, utm };
    const r = walk(v, t0, person ? person.browserUpTo : null, "join_start");
    const o = outreachId ? outreach.find((x) => x.id === outreachId) : undefined;
    if (o && r.reached) o.convertedStep = r.reached;
    return { v, r, o };
  }

  // ── The seed's own people: leads in the window and members who joined in it ──
  const people: Person[] = [];
  const memberships = C(COLLECTIONS.memberships);
  const cons = C(COLLECTIONS.consultations);
  const hofs = C(COLLECTIONS.handoffs);
  const opps = C(COLLECTIONS.opportunities);
  for (const c of C(COLLECTIONS.clients)) {
    const m = memberships.find((x) => x.clientId === c.id && x.activatedAt);
    if (!m) continue;
    const act = Date.parse(String(m.activatedAt));
    const later: Array<[FunnelStepId, number]> = [["activation_paid", act]];
    const months = Math.floor((now - act) / (30.44 * DAY));
    if (months >= 1 && m.status !== "cancelled") later.push(["renewed_m2", act + Math.round(30.44 * DAY)]);
    if (months >= 2 && m.status === "active") later.push(["renewed_m3", act + Math.round(60.88 * DAY)]);
    const mine = cons.filter((x) => x.clientId === c.id).sort((a, b) => String(a.createdAt ?? a.scheduledAt).localeCompare(String(b.createdAt ?? b.scheduledAt)));
    const booked = mine[0];
    if (booked) later.push(["call_booked", Date.parse(String(booked.createdAt ?? booked.scheduledAt))]);
    const done = mine.find((x) => x.status === "completed");
    if (done) later.push(["call_done", Date.parse(String(done.endedAt ?? done.scheduledAt))]);
    const h = hofs.filter((x) => x.clientId === c.id).map((x) => Date.parse(String(x.approvedAt))).filter(Number.isFinite).sort()[0];
    if (h) later.push(["handoff_confirmed", h]);
    if (done && !opps.some((x) => x.clientId === c.id && x.stage === "won") && rng.chance(0.3)) {
      later.push(["paid_work_accepted", Date.parse(String(done.endedAt ?? done.scheduledAt)) + rng.int(2, 9) * DAY]);
    }
    if (opps.some((x) => x.clientId === c.id && x.stage === "won")) {
      const w = opps.find((x) => x.clientId === c.id && x.stage === "won")!;
      later.push(["paid_work_accepted", Date.parse(String(w.closedAt ?? w.updatedAt))]);
    }
    if (booked || rng.chance(0.75)) later.push(["profile_ready", act + rng.int(2, 72) * 3600_000]);
    people.push({ kind: "client", id: String(c.id), doc: c, later: later.filter(([, t]) => Number.isFinite(t) && t <= now), browserUpTo: "join_start", at: act - rng.int(1, 6) * DAY, country: (c.country ?? undefined) as CountryCode | undefined });
  }
  for (const l of C(COLLECTIONS.leads)) {
    if (l.convertedClientId) continue;
    const at = Date.parse(String(l.createdAt));
    if (!(at >= start && at <= now)) continue;
    const upTo: FunnelStepId = rng.weighted([["results_view", 55], ["deadlines_select", 30], ["signup_start", 15]] as const);
    people.push({ kind: "lead", id: String(l.id), doc: l, later: [], browserUpTo: upTo, at: at - 5 * MIN, country: l.country as CountryCode });
  }

  // ── Anonymous visitors over the window (weekday-heavy, growing) ──
  const total = opts.visitors ?? VISITORS_BY_MEMBERS(C(COLLECTIONS.clients).length);
  const dayWeights: number[] = [];
  for (let d = 0; d < JOURNEY_WINDOW_DAYS; d++) {
    const dow = new Date(start + d * DAY).getUTCDay();
    dayWeights.push((dow === 0 || dow === 6 ? 0.6 : 1) * (0.75 + 0.5 * (d / JOURNEY_WINDOW_DAYS)));
  }
  const wsum = dayWeights.reduce((s, x) => s + x, 0);
  for (let d = 0; d < JOURNEY_WINDOW_DAYS; d++) {
    const dayStart = Date.parse(iso(start + d * DAY).slice(0, 10) + "T00:00:00Z");
    const count = Math.round((total * dayWeights[d]) / wsum);
    for (let k = 0; k < count; k++) visitor(dayStart);
  }

  // People: their browser journey, then the server steps from their records.
  let tracks = 0;
  for (const p of people) {
    const inWindow = p.at >= start;
    let track: JourneyTrack;
    if (inWindow) {
      const dayStart = Date.parse(iso(p.at).slice(0, 10) + "T00:00:00Z");
      const res = visitor(dayStart, p)!;
      const vid = res.v.id;
      for (const e of events) if (e.visitorId === vid) e[p.kind === "client" ? "clientId" : "leadId"] = p.id;
      const base = { source: res.v.source, channel: res.v.channel, device: res.v.device, variants: res.r.variants, country: res.v.country, ...(res.v.outreachId ? { outreachId: res.v.outreachId } : {}), [p.kind === "client" ? "clientId" : "leadId"]: p.id };
      for (const [s, t] of p.later) serverStep(vid, s, t, base);
      const reached = [...(res.r.reached ? [[res.r.reached, res.r.at] as [FunnelStepId, number]] : []), ...p.later.map(([s, t]) => [s, t] as [FunnelStepId, number])]
        .sort((a, b) => memberRank(b[0]) - memberRank(a[0]))[0];
      track = { visitorId: vid, source: res.v.source, channel: res.v.channel, firstAt: iso(p.at), country: res.v.country, device: res.v.device, ...(res.v.outreachId ? { outreachId: res.v.outreachId } : {}), ...(Object.keys(res.r.variants).length ? { variants: res.r.variants } : {}) };
      if (reached) Object.assign(track, { furthestStep: reached[0], furthestAt: iso(Math.min(reached[1], now - MIN)) });
      if (res.o && reached && memberRank(reached[0]) > memberRank(res.o.convertedStep)) res.o.convertedStep = reached[0];
    } else {
      // Joined before the window: only the link and the furthest step from their records.
      rng.reseed("old", p.id);
      const best = [...p.later].sort((a, b) => memberRank(b[0]) - memberRank(a[0]))[0] ?? ["activation_paid", p.at];
      track = { visitorId: `ph_srv_${p.id}`.slice(0, 64), source: "inbound", channel: rng.weighted(INBOUND_W), firstAt: iso(p.at), furthestStep: best[0], furthestAt: iso(best[1]), ...(p.country ? { country: p.country } : {}) };
    }
    p.doc[JOURNEY_TRACK_FIELD] = track;
    tracks++;
  }

  // ── Aggregate every day with the real builder; keep raw events for the last RAW_DAYS ──
  const byDay = new Map<string, JourneyEvent[]>();
  for (const e of events) {
    const d = e.at.slice(0, 10);
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(e);
  }
  const daily: JourneyDaily[] = [];
  const exposures = new Map<string, JourneyExposure>();
  const builtAt = iso(now);
  for (const day of [...byDay.keys()].sort()) {
    const dayMs = Date.parse(`${day}T00:00:00Z`);
    const keys = new Set(experiments.filter((e) => Date.parse(e.startedAt!) < dayMs + DAY && (!e.endedAt || Date.parse(e.endedAt) >= dayMs)).map((e) => e.key));
    const built = buildDay(byDay.get(day)!, day, builtAt, keys);
    for (const r of built.daily) daily.push({ ...r, ...stamp });
    for (const x of mergeExposures(exposures, built.exposures)) exposures.set(x.id, { ...x, ...stamp });
  }
  const rawFrom = iso(now - RAW_DAYS * DAY);
  const kept = events.filter((e) => e.at >= rawFrom);

  const add = (col: string, docs: object[]) => (data.collections[col] ??= []).push(...(docs as Doc[]));
  add(COLLECTIONS.experiments, experiments);
  add(COLLECTIONS.journeyEvents, kept);
  add(COLLECTIONS.journeyDaily, daily);
  add(COLLECTIONS.journeyExposures, [...exposures.values()]);
  add(COLLECTIONS.outreach, outreach);
  return { experiments, events: kept, allEvents: events.length, daily, exposures: [...exposures.values()], outreach, tracks };
}

/** The member funnel ids (for reports). */
export const MEMBER_STEP_IDS = FUNNEL_STEPS.map((s) => s.id);
