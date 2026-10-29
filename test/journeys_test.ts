import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { type FakeWorld, installFakeWorld, useFakeEnv } from "./e2e/fakeWorld.ts";
import { type CallResult, FakeApp } from "./e2e/fakeApp.ts";
import { isBot, normalizePath, parseBatch, parseEvent, privacySignal, resolveAttribution, safeRedirectPath } from "../API/journeys/validate.ts";
import { assignmentsFor, assignVariant } from "../API/journeys/assign.ts";
import { histAdd, histPercentile, probabilityBest, quantile, sampleSizePerVariant, srmPValue, wilson } from "../API/journeys/stats.ts";
import { buildDay, experimentResult, funnelRows, matchesFilters, mergeExposures, pagesOf, pathsOf, stuckOf } from "../API/journeys/aggregate.ts";
import { applyPatch, transition } from "../API/journeys/experiments.ts";
import { tagEmailHtml } from "../API/journeys/outreach.ts";
import { stuckPersonOf } from "../API/journeys/journeysRouter.ts";
import { aggregateDay, type AggregateStore } from "../jobs/journeyAggregate.ts";
import { renewalNumber } from "../API/payments/lifecycle.ts";
import type { Experiment, JourneyDaily, JourneyEvent, JourneyExposure } from "../schemas/contracts.ts";

/**
 * JOURNEYS: event validation and stripping, privacy signals, sticky
 * assignment, statistics, funnel math, stuck detection, the open-redirect
 * guard, role checks, aggregation idempotency and the server-side steps,
 * through the real routers against the in-memory Firestore (test/e2e/fakeWorld.ts).
 *
 * Run: deno test --allow-env --allow-read test/journeys_test.ts
 */

// deno-lint-ignore no-explicit-any
type Any = any;
type Doc = Record<string, Any>;
const NOW = "2026-10-28T15:00:00.000Z";
const DAY = "2026-10-28";
const UA = { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1" };
const ADMIN = "ana@internationallegalpartner.com";
const OWNER = "owner@internationallegalpartner.com";
const STAFF = "sam@internationallegalpartner.com";

const at = (min: number) => new Date(Date.parse(`${DAY}T10:00:00Z`) + min * 60_000).toISOString();
let n = 0;
function ev(v: string, type: JourneyEvent["type"], min: number, extra: Partial<JourneyEvent> = {}): JourneyEvent {
  return { id: `e${++n}`, visitorId: v, sessionId: `s_${v}`, source: "inbound", channel: "organic", type, path: "/check", variants: {}, device: "phone", at: at(min), ...extra };
}
const step = (v: string, s: Any, min: number, extra: Partial<JourneyEvent> = {}) => ev(v, "step", min, { step: s, ...extra });

// ─── Validation ──────────────────────────────────────────────────────────

Deno.test("validate: only contract fields are stored; paths, targets and utm are stripped of free text", () => {
  const now = new Date(NOW);
  const e = parseEvent({
    visitorId: "v_12345678", sessionId: "s_12345678", type: "click", path: "/status/alice@example.com/matters/mat_123?email=a@b.com#x",
    target: "join.cta", step: "results_view", device: "phone", country: "CR", variants: { "hero-headline": "b", "Bad Key": "x" },
    utm: { source: "Google", campaign: "cr retirees", medium: "cpc" }, email: "a@b.com", ip: "1.2.3.4", note: "free text here", at: NOW,
  }, now)!;
  assertEquals(e.path, "/status/:id/matters/:id");
  assertEquals(e.target, "join.cta");
  assertEquals(e.variants, { "hero-headline": "b" });
  assertEquals(e.utm, { source: "google", medium: "cpc" }); // "cr retirees" has a space: dropped
  assertEquals(Object.keys(e).sort(), ["at", "country", "device", "path", "sessionId", "step", "target", "type", "utm", "variants", "visitorId"]);
  assert(!JSON.stringify(e).includes("@"));
  // A server-only step from the browser is refused; a form error needs a field id.
  assertEquals(parseEvent({ visitorId: "v_12345678", sessionId: "s_12345678", type: "step", step: "activation_paid", path: "/join" }, now), null);
  assertEquals(parseEvent({ visitorId: "v_12345678", sessionId: "s_12345678", type: "form_error", target: "has spaces!", path: "/check" }, now), null);
  assertEquals(parseEvent({ visitorId: "short", sessionId: "s_12345678", type: "page_view", path: "/" }, now), null);
  assertEquals(parseEvent({ visitorId: "v_12345678", sessionId: "s_12345678", type: "page_view", path: "https://evil.com/" }, now), null);
  // Clock: a far-future time is replaced by the server time.
  assertEquals(parseEvent({ visitorId: "v_12345678", sessionId: "s_12345678", type: "page_view", path: "/", at: "2030-01-01T00:00:00Z" }, now)!.at, NOW);
  assertEquals(normalizePath("/check/question-5"), "/check/question-5");
  const exposure = parseEvent({ visitorId: "v_12345678", sessionId: "s_12345678", type: "heartbeat", durationMs: 0, target: "exposure.hero-headline", variants: { "hero-headline": "b" }, path: "/" }, now)!;
  assertEquals([exposure.target, exposure.durationMs, exposure.variants], ["exposure.hero-headline", 0, { "hero-headline": "b" }]);
  assertEquals(normalizePath("/join/2f6c1a0e-3d4b-4e5f-9a8b-7c6d5e4f3a2b"), "/join/:id");
  const batch = parseBatch({ events: Array.from({ length: 60 }, () => ({ visitorId: "v_12345678", sessionId: "s_12345678", type: "page_view", path: "/" })) }, now);
  assert(!("error" in batch));
  assertEquals((batch as Any).events.length, 50);
  assertEquals((batch as Any).dropped, 10);
});

Deno.test("validate: outbound needs a real outreach; privacy signals and bots", () => {
  const p = parseEvent({ visitorId: "v_12345678", sessionId: "s_12345678", type: "page_view", path: "/", source: "outbound", channel: "email_outreach", outreachId: "o_abcdef123456" }, new Date(NOW))!;
  assertEquals(resolveAttribution(p, null), { source: "inbound", channel: "direct" });
  assertEquals(resolveAttribution(p, { id: "o_abcdef123456", channel: "csm_call" }), { source: "outbound", channel: "csm_call", outreachId: "o_abcdef123456" });
  assertEquals(privacySignal({ dnt: "1" }, {}), "dnt");
  assertEquals(privacySignal({ "sec-gpc": "1" }, {}), "gpc");
  assertEquals(privacySignal({}, { optOut: true }), "opt_out");
  assertEquals(privacySignal({}, {}), null);
  assert(isBot("Googlebot/2.1 (+http://www.google.com/bot.html)"));
  assert(isBot("HeadlessChrome/120"));
  assert(isBot(""));
  assert(!isBot(UA["user-agent"]));
});

Deno.test("redirect: only allowlisted site paths; everything else lands on /", () => {
  assertEquals(safeRedirectPath("/check"), "/check");
  assertEquals(safeRedirectPath("/costa-rica/residency?x=1"), "/costa-rica/residency");
  for (const bad of ["https://evil.com", "//evil.com", "/\\evil.com", "javascript:alert(1)", "/admin", "/check/../../x", "/%2F%2Fevil.com", "", "/http:evil"]) {
    assertEquals(safeRedirectPath(bad), "/", bad);
  }
});

// ─── Assignment and statistics ───────────────────────────────────────────

Deno.test("assign: sticky per visitor, follows the weights, honours the audience", () => {
  const exp = { key: "hero-headline", variants: [{ key: "a", name: "A", weight: 1 }, { key: "b", name: "B", weight: 3 }] };
  const first = assignVariant("v_sticky_001", exp);
  for (let i = 0; i < 5; i++) assertEquals(assignVariant("v_sticky_001", exp), first);
  let b = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) if (assignVariant(`visitor_${i.toString(36)}_x`, exp) === "b") b++;
  assert(Math.abs(b / N - 0.75) < 0.015, `share of b ${b / N}`);
  const list: Any[] = [
    { ...exp, audience: "outbound", status: "running" },
    { key: "check-length", variants: exp.variants, audience: "all", status: "paused" },
  ];
  assertEquals(assignmentsFor("v_sticky_001", list, "inbound"), {});
  assertEquals(Object.keys(assignmentsFor("v_sticky_001", list, "outbound")), ["hero-headline"]);
});

Deno.test("stats: SRM, probability best, Wilson, sample size, percentiles", () => {
  assert(srmPValue([5000, 5000], [1, 1]) > 0.5);
  assert(srmPValue([5050, 4950], [1, 1]) > 0.01);
  assert(srmPValue([5300, 4700], [1, 1]) < 0.01);
  assert(srmPValue([2500, 7500], [1, 3]) > 0.5);
  const same = probabilityBest([{ visitors: 1000, conversions: 100 }, { visitors: 1000, conversions: 100 }]);
  assert(Math.abs(same[0] - 0.5) < 0.03, String(same));
  const clear = probabilityBest([{ visitors: 2000, conversions: 200 }, { visitors: 2000, conversions: 300 }]);
  assert(clear[1] > 0.99, String(clear));
  assert(Math.abs(clear[0] + clear[1] - 1) < 1e-9);
  const [lo, hi] = wilson(50, 100);
  assert(lo > 0.39 && lo < 0.41 && hi > 0.59 && hi < 0.61, `${lo} ${hi}`);
  const nn = sampleSizePerVariant(0.1);
  assert(nn > 3500 && nn < 4200, String(nn));
  let h: number[] | undefined;
  const xs = [800, 2000, 4000, 9000, 15000, 25000, 50000, 70000, 100000, 200000];
  for (const x of xs) h = histAdd(h, x);
  const med = histPercentile(h, 0.5)!;
  assert(med >= 10000 && med <= 30000, String(med)); // exact median is 20000; the sketch stays in its bucket
  assertEquals(quantile([1, 2, 3, 4], 0.5), 2.5);
});

// ─── Funnel math, stuck, pages, aggregation ──────────────────────────────

function sampleDay(): JourneyEvent[] {
  n = 0;
  const out: JourneyEvent[] = [];
  // 4 visitors land; 3 start the check; 2 finish (1 errors on q5 and leaves); 1 sees results.
  for (const v of ["va_000001", "vb_000002", "vc_000003", "vd_000004"]) {
    out.push(ev(v, "page_view", 0, { path: "/" }), step(v, "landing_view", 0, { path: "/" }));
  }
  out.push(ev("va_000001", "heartbeat", 1, { path: "/", durationMs: 15000 }));
  for (const [v, m] of [["va_000001", 1], ["vb_000002", 2], ["vc_000003", 3]] as const) out.push(ev(v, "page_view", m), step(v, "check_start", m));
  out.push(step("va_000001", "check_finish", 5), step("vb_000002", "check_finish", 7));
  out.push(ev("vc_000003", "form_error", 6, { step: "check_start", target: "q5" }), ev("vc_000003", "exit", 8, { durationMs: 120000 }));
  out.push(step("va_000001", "results_view", 6, { path: "/check/results", variants: { "hero-headline": "b" } }));
  out.push({ ...step("vb_000002", "results_view", 9), placeholder: true, visitorId: "ph_vis_0001" });
  return out;
}

Deno.test("funnel: counts, conversion from previous and start, drop-off, medians", () => {
  const { daily } = buildDay(sampleDay(), DAY, NOW, new Set(["hero-headline"]));
  const rows = funnelRows(daily.filter((r) => matchesFilters(r, { excludePlaceholder: true })), "member");
  const by = Object.fromEntries(rows.map((r) => [r.step, r]));
  assertEquals(by.landing_view.visitors, 4);
  assertEquals(by.check_start.visitors, 3);
  assertEquals(by.check_finish.visitors, 2);
  assertEquals(by.results_view.visitors, 1);
  assertEquals(by.check_start.conversionFromPrev, 0.75);
  assertEquals(by.check_finish.conversionFromStart, 0.5);
  assertEquals(by.check_finish.dropOff, 1);
  // check_start → check_finish took 4 and 5 minutes.
  // The median is read from the duration histogram: it stays inside the bucket holding the true one (2-5 min).
  const med = by.check_finish.medianMsFromPrev!;
  assert(med > 120000 && med <= 300000, String(med));
  // The experiment rows hold only the visitor that carried the variant.
  const exp = daily.filter((r) => matchesFilters(r, { experiment: "hero-headline", variant: "b" }));
  assertEquals(funnelRows(exp, "member").find((r) => r.step === "results_view")!.visitors, 1);
  // The placeholder visitor is its own ph_ row.
  assert(daily.some((r) => r.placeholder && r.id.startsWith("ph_")));
});

Deno.test("stuck: who stopped where, their exit page and form errors", () => {
  const { daily } = buildDay(sampleDay(), DAY, NOW);
  const st = stuckOf(daily.filter((r) => matchesFilters(r, { excludePlaceholder: true })), "member");
  const cs = st.find((s) => s.step === "check_start")!;
  assertEquals(cs.stuckCount, 1);
  assertEquals(cs.topFormErrors, [{ target: "q5", count: 1 }]);
  assertEquals(cs.topExitPaths[0].path, "/check");
  const pages = pagesOf(daily.filter((r) => matchesFilters(r, {})));
  const entries = pathsOf(daily.filter((r) => matchesFilters(r, {}))).pages.filter((p) => p.from === "(entry)");
  assertEquals(entries.find((p) => p.to === "/")!.visitors, 4);
  const home = pages.find((p) => p.path === "/")!;
  assertEquals(home.views, 4);
  // People: reached results_view 9 days ago and did not move on → stuck at 7 days, not at 10.
  const doc = { id: "lead_1", name: "Test Lead", journeyTrack: { visitorId: "va_000001", source: "inbound", channel: "organic", firstAt: NOW, furthestStep: "results_view", furthestAt: "2026-10-19T12:00:00.000Z" } };
  const p = stuckPersonOf("lead", doc, "results_view", 7, new Date(NOW))!;
  assertEquals([p.id, p.daysStuck, p.leadId, p.name], ["lead:lead_1", 9, "lead_1", "Test Lead"]);
  assertEquals(stuckPersonOf("lead", doc, "results_view", 10, new Date(NOW)), null);
  assertEquals(stuckPersonOf("lead", { ...doc, convertedClientId: "c1" }, "results_view", 7, new Date(NOW)), null);
  assertEquals(stuckPersonOf("lead", doc, "check_start", 7, new Date(NOW)), null);
});

Deno.test("aggregation: re-running a day gives the same rows; exposures merge once per visitor", async () => {
  const events = sampleDay();
  const daily = new Map<string, JourneyDaily>();
  const exposures = new Map<string, JourneyExposure>();
  const store: AggregateStore = {
    eventsOfDay: () => Promise.resolve(events),
    replaceDay: (day, rows) => {
      let removed = 0;
      for (const k of [...daily.keys()]) if (daily.get(k)!.day === day && !rows.some((r) => r.id === k)) (daily.delete(k), removed++);
      for (const r of rows) daily.set(r.id, JSON.parse(JSON.stringify(r)));
      return Promise.resolve({ written: rows.length, removed });
    },
    experiments: () => Promise.resolve([{ key: "hero-headline", status: "running" }] as Any),
    exposures: () => Promise.resolve([...exposures.values()]),
    saveExposures: (list) => (list.forEach((x) => exposures.set(x.id, x)), Promise.resolve()),
  };
  const r1 = await aggregateDay(DAY, store, new Date(NOW));
  const snap = JSON.stringify([...daily.values()]);
  const r2 = await aggregateDay(DAY, store, new Date(NOW));
  assertEquals(JSON.stringify([...daily.values()]), snap);
  assertEquals(r1.rows, r2.rows);
  assertEquals(exposures.size, 1);
  assertEquals(r2.exposures, 0); // nothing changed the second time
  // An earlier exposure wins; later steps are kept at their first time.
  const x = [...exposures.values()][0];
  const merged = mergeExposures(new Map([[x.id, x]]), [{ ...x, firstAt: at(-100), steps: {} }]);
  assertEquals(merged[0].firstAt, at(-100));
  assertEquals(merged[0].steps.results_view, x.steps.results_view);
});

Deno.test("experiment results: rate, lift, probability best, SRM flag", () => {
  const exp = { id: "exp_1", variants: [{ key: "a", name: "A", weight: 1 }, { key: "b", name: "B", weight: 1 }], primaryStep: "signup_start" as const };
  const xs: JourneyExposure[] = [];
  for (let i = 0; i < 1000; i++) xs.push({ id: `a${i}`, experiment: "k", variant: "a", visitorId: `a${i}`, source: "inbound", firstAt: NOW, steps: i < 100 ? { signup_start: NOW } : {} });
  for (let i = 0; i < 1000; i++) xs.push({ id: `b${i}`, experiment: "k", variant: "b", visitorId: `b${i}`, source: "inbound", firstAt: NOW, steps: i < 150 ? { signup_start: NOW } : {} });
  const r = experimentResult(exp, xs, { draws: 4000 });
  assertEquals(r.variants[0].rate, 0.1);
  assertEquals(r.variants[0].liftVsControl, null);
  assert(Math.abs(r.variants[1].liftVsControl! - 0.5) < 1e-9);
  assert(r.variants[1].probabilityBest > 0.99);
  assertEquals(r.srmWarning, false);
  const skewed = experimentResult(exp, xs.slice(0, 1600), { draws: 1000 }); // 1000 vs 600 on 50/50
  assertEquals(skewed.srmWarning, true);
});

Deno.test("experiments: variants are locked once started; status moves", () => {
  const base: Experiment = {
    id: "exp_1", key: "hero-headline", name: "Hero", hypothesis: "", surface: "home.hero", variants: [{ key: "a", name: "A", weight: 1 }, { key: "b", name: "B", weight: 1 }],
    primaryStep: "check_start", audience: "all", status: "draft", createdBy: ADMIN, createdAt: NOW, updatedAt: NOW,
  };
  assertEquals(applyPatch(base, { variants: [{ key: "a", weight: 1 }, { key: "c", weight: 2 }] }, NOW).variants[1].key, "c");
  const running = transition(base, "start", NOW);
  assertEquals([running.status, running.startedAt], ["running", NOW]);
  let refused = false;
  try {
    applyPatch(running, { variants: [{ key: "a", weight: 1 }, { key: "b", weight: 3 }] }, NOW);
  } catch (e) {
    refused = (e as Any).status === 409;
  }
  assert(refused);
  assertEquals(applyPatch(running, { name: "Hero v2" }, NOW).name, "Hero v2");
  assertEquals(transition(running, "declare-winner", NOW, "b").winner, "b");
});

Deno.test("outreach email: site links go through the click redirect, other links stay, pixel added", () => {
  const html = '<p><a href="https://app.e2e-ilp.io/check?utm=x">Check</a> <a href="mailto:x@y.z">Mail</a> <a href="https://evil.com/">E</a></p></body>';
  const out = tagEmailHtml(html, "o_abc123def456", "https://app.e2e-ilp.io", "https://api.e2e-ilp.io");
  assert(out.includes('href="https://api.e2e-ilp.io/api/journey/c/o_abc123def456?to=%2Fcheck"'));
  assert(out.includes('href="mailto:x@y.z"') && out.includes('href="https://evil.com/"'));
  assert(out.includes('src="https://api.e2e-ilp.io/api/journey/o/o_abc123def456.gif"'));
  assertEquals(renewalNumber("2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z"), 1);
  assertEquals(renewalNumber("2026-08-01T00:00:00Z", "2026-10-01T00:00:00Z"), 2);
});

// ─── Through the routes (in-memory Firestore) ────────────────────────────

let world: FakeWorld;
let app: FakeApp;
const H = (token?: string, extra: Record<string, string> = {}) => ({ ...UA, ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra });
const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = H()): Promise<CallResult> => app.call(method, url, { body, headers });

function staff(email: string): string {
  const t = `stf_${email.split("@")[0]}`;
  world.put("dashboard_sessions", t, { email, expiresAt: "2030-01-01T00:00:00Z" });
  return t;
}

Deno.test("routes 0: setup", async () => {
  await useFakeEnv({ ADMIN_EMAILS: ADMIN, OWNER_EMAILS: OWNER, CSM_EMAILS: "", DEFAULT_CSM_EMAIL: "carla@internationallegalpartner.com", PUBLIC_API_URL: "https://api.e2e-ilp.io" });
  world = installFakeWorld(NOW);
  app = new FakeApp();
  (await import("../API/journeys/journeysRouter.ts")).default(app as Any);
});

const browserEvents = (v: string, extra: Doc = {}) => ({
  events: [
    { visitorId: v, sessionId: `s_${v}`, type: "page_view", path: "/", device: "phone", country: "CR", ...extra },
    { visitorId: v, sessionId: `s_${v}`, type: "step", step: "landing_view", path: "/", device: "phone", ...extra },
    { visitorId: v, sessionId: `s_${v}`, type: "step", step: "check_start", path: "/check", device: "phone", ...extra },
  ],
});

Deno.test("routes: events are stored; DNT, GPC, opt-out and bots store nothing", async () => {
  const ok = await call("POST", "/api/journey/events", browserEvents("vis_route_01"));
  assertEquals([ok.status, ok.body.accepted], [202, 3]);
  const stored = world.all("journey_events").filter((e) => e.visitorId === "vis_route_01");
  assertEquals(stored.length, 3);
  assert(stored.every((e) => e.source === "inbound" && e.channel === "direct" && !("ip" in e)));
  for (const [headers, why] of [[H(undefined, { dnt: "1" }), "dnt"], [H(undefined, { "sec-gpc": "1" }), "gpc"], [{ "user-agent": "curl/8.0" }, "bot"]] as const) {
    const r = await call("POST", "/api/journey/events", browserEvents("vis_route_02"), headers as Any);
    assertEquals([r.status, r.body.ignored, r.body.accepted], [202, why, 0]);
  }
  const opt = await call("POST", "/api/journey/events", { ...browserEvents("vis_route_02"), optOut: true });
  assertEquals(opt.body.ignored, "opt_out");
  // text/plain JSON (sendBeacon)
  const beacon = await call("POST", "/api/journey/events", JSON.stringify(browserEvents("vis_route_03")));
  assertEquals(beacon.body.accepted, 3);
  assertEquals(world.all("journey_events").filter((e) => e.visitorId === "vis_route_02").length, 0);
  // A server-only step from the browser is dropped.
  const forged = await call("POST", "/api/journey/events", { events: [{ visitorId: "vis_route_04", sessionId: "s_vis_route_04", type: "step", step: "activation_paid", path: "/join" }] });
  assertEquals([forged.body.accepted, forged.body.dropped], [0, 1]);
});

Deno.test("routes: outreach click redirects only to site paths and marks the visitor outbound", async () => {
  const admin = staff(ADMIN);
  const made = await call("POST", "/api/dashboard/journeys/outreach", { channel: "csm_call", campaign: "CR Retirees Nov", email: "lead@example.com" }, H(admin));
  assertEquals(made.status, 201);
  const id = made.body.outreach.id;
  assertEquals(made.body.outreach.campaign, "cr-retirees-nov");
  assert(!("email" in made.body.outreach));
  assert(/^[0-9a-f]{64}$/.test(world.doc("outreach", id)!.email));
  const evil = await call("GET", `/api/journey/c/${id}?to=https://evil.com/x`);
  assertEquals(evil.status, 302);
  assertEquals(evil.headers.location, `https://app.e2e-ilp.io/?o=${id}`);
  const good = await call("GET", `/api/journey/c/${id}?to=/check`);
  assertEquals(good.headers.location, `https://app.e2e-ilp.io/check?o=${id}`);
  assert(world.doc("outreach", id)!.clickedAt);
  const pixel = await call("GET", `/api/journey/o/${id}.gif`);
  assertEquals([pixel.status, pixel.headers["content-type"]], [200, "image/gif"]);
  const r = await call("POST", "/api/journey/events", browserEvents("vis_outbound_1", { outreachId: id, source: "outbound" }));
  assertEquals(r.body.accepted, 3);
  const e = world.all("journey_events").find((x) => x.visitorId === "vis_outbound_1")!;
  assertEquals([e.source, e.channel, e.outreachId], ["outbound", "csm_call", id]);
  assertEquals(world.doc("outreach", id)!.convertedStep, "check_start");
  const steps = world.all("journey_events").filter((x) => x.outreachId === id && x.sessionId === "server_side").map((x) => x.step).sort();
  assertEquals(steps, ["outreach_clicked", "outreach_opened", "outreach_sent"]);
  const ob = await call("GET", "/api/dashboard/journeys/outbound", undefined, H(admin));
  const row = ob.body.rows.find((x: Doc) => x.campaign === "cr-retirees-nov");
  assertEquals([row.sent, row.opened, row.clicked, row.checkStarted], [1, 1, 1, 1]);
});

Deno.test("routes: roles: staff reads, admins and owners write experiments, running variants are locked", async () => {
  const s = staff(STAFF);
  const admin = staff(ADMIN);
  const owner = staff(OWNER);
  assertEquals((await call("GET", "/api/dashboard/journeys/funnel")).status, 401);
  const f = await call("GET", "/api/dashboard/journeys/funnel?from=2026-10-01", undefined, H(s));
  assertEquals(f.status, 200);
  assertEquals(f.body.rows.find((r: Doc) => r.step === "landing_view").visitors >= 2, true); // today, live from raw events
  const body = { key: "hero-headline", name: "Hero headline", hypothesis: "Plain words win", surface: "home.hero", primaryStep: "check_start", audience: "all", variants: [{ key: "a", name: "Now", weight: 1 }, { key: "b", name: "New", weight: 1 }] };
  assertEquals((await call("POST", "/api/dashboard/journeys/experiments", body, H(s))).status, 403);
  const made = await call("POST", "/api/dashboard/journeys/experiments", body, H(owner));
  assertEquals(made.status, 201);
  const id = made.body.experiment.id;
  assertEquals((await call("POST", "/api/dashboard/journeys/experiments", body, H(admin))).status, 409); // same key
  assertEquals((await call("POST", `/api/dashboard/journeys/experiments/${id}/start`, {}, H(s))).status, 403);
  assertEquals((await call("POST", `/api/dashboard/journeys/experiments/${id}/start`, {}, H(admin))).body.experiment.status, "running");
  const locked = await call("PATCH", `/api/dashboard/journeys/experiments/${id}`, { variants: [{ key: "a", weight: 1 }, { key: "b", weight: 9 }] }, H(admin));
  assertEquals(locked.status, 409);
  assert(world.all("audit_log").some((a) => a.action === "experiment.started" && a.actor.email === ADMIN));
  const asg = await call("GET", "/api/journey/assign?visitorId=vis_assign_01");
  assertEquals(asg.status, 200);
  assert(["a", "b"].includes(asg.body.assignments["hero-headline"]));
  assertEquals(asg.headers["cache-control"], "public, max-age=60");
  const again = await call("GET", "/api/journey/assign?visitorId=vis_assign_01");
  assertEquals(again.body.assignments, asg.body.assignments);
  const res = await call("GET", `/api/dashboard/journeys/experiments/${id}/results`, undefined, H(s));
  assertEquals([res.status, res.body.variants.length], [200, 2]);
});

Deno.test("routes: server steps are idempotent; stuck people get a CSM task", async () => {
  const { identify, trackServerStep } = await import("../API/journeys/track.ts");
  world.put("clients", "bob_example_com", { name: "Bob Stuck", email: "bob@example.com", csmEmail: "carla@internationallegalpartner.com" });
  await call("POST", "/api/journey/events", browserEvents("vis_bob_0001"));
  await identify("vis_bob_0001", { clientId: "bob_example_com" });
  const linked = world.all("journey_events").filter((e) => e.visitorId === "vis_bob_0001");
  assert(linked.every((e) => e.clientId === "bob_example_com"));
  await trackServerStep("account_created", { clientId: "bob_example_com" });
  await trackServerStep("account_created", { clientId: "bob_example_com" });
  const acc = world.all("journey_events").filter((e) => e.step === "account_created" && e.clientId === "bob_example_com");
  assertEquals(acc.length, 1);
  assertEquals(acc[0].visitorId, "vis_bob_0001");
  const track = world.doc("clients", "bob_example_com")!.journeyTrack;
  assertEquals(track.furthestStep, "account_created");
  // Ten days later he has not moved on.
  world.advance(10 * 86_400_000);
  const s = staff(STAFF);
  const list = await call("GET", "/api/dashboard/journeys/stuck/people?step=account_created&days=7&limit=10", undefined, H(s));
  assertEquals(list.status, 200);
  const bob = list.body.items.find((p: Doc) => p.clientId === "bob_example_com");
  assertEquals([bob.daysStuck, bob.name, bob.csmEmail], [10, "Bob Stuck", "carla@internationallegalpartner.com"]);
  const t = await call("POST", `/api/dashboard/journeys/stuck/${encodeURIComponent(bob.id)}/task`, {}, H(s));
  assertEquals(t.status, 201);
  assertEquals([t.body.task.type, t.body.task.ownerEmail, t.body.task.clientId], ["follow_up", "carla@internationallegalpartner.com", "bob_example_com"]);
  const t2 = await call("POST", `/api/dashboard/journeys/stuck/${encodeURIComponent(bob.id)}/task`, {}, H(s));
  assertEquals([t2.status, t2.body.task.id], [200, t.body.task.id]);
  const list2 = await call("GET", "/api/dashboard/journeys/stuck/people?step=account_created&days=7&limit=10", undefined, H(s));
  assertEquals(list2.body.items.find((p: Doc) => p.clientId === "bob_example_com").openTaskId, t.body.task.id);
  assertEquals((await call("GET", "/api/dashboard/journeys/stuck/people?step=nope", undefined, H(s))).status, 400);
});

Deno.test("routes: TASK_RULES events record their funnel step", async () => {
  const { emitEvent } = await import("../API/members/events.ts");
  world.put("clients", "cara_example_com", { name: "Cara", email: "cara@example.com" });
  await emitEvent("membership.activated", { clientId: "cara_example_com", sourceId: "mem_1" });
  const e = world.all("journey_events").find((x) => x.step === "activation_paid" && x.clientId === "cara_example_com");
  assert(e);
  assert(String(e.visitorId).startsWith("srv_")); // no browser linked: a hashed, non-personal id
  assertEquals(world.doc("clients", "cara_example_com")!.journeyTrack.furthestStep, "activation_paid");
});

Deno.test("routes 9: teardown", () => {
  world.restore();
});

Deno.test("seed: journeys are ph_ placeholder docs, deterministic, with two running experiments and one winner", async () => {
  const { buildPlaceholderData } = await import("../scripts/placeholderData.ts");
  const { addJourneyData } = await import("../scripts/journeyPlaceholderData.ts");
  const build = () => {
    const data = buildPlaceholderData({ size: "demo", seed: 3, now: new Date("2026-10-28T16:00:00Z") });
    return { data, j: addJourneyData(data, { seed: 3 }) };
  };
  const a = build();
  const b = build();
  assertEquals(JSON.stringify(a.j.daily.slice(0, 50)), JSON.stringify(b.j.daily.slice(0, 50)));
  for (const col of ["journey_events", "journey_daily", "journey_exposures", "experiments", "outreach"]) {
    const docs = a.data.collections[col] ?? [];
    assert(docs.length > 0, col);
    assert(docs.every((d: Doc) => String(d.id).startsWith("ph_") && d.placeholder === true && d.placeholderBatch === a.data.batch), col);
  }
  assertEquals(a.j.experiments.map((e) => e.status).sort(), ["ended", "running", "running"]);
  assertEquals(a.j.experiments.find((e) => e.status === "ended")!.winner, "save");
  assert(new Set(a.j.daily.map((r) => r.country)).size >= 6);
  assert(a.j.daily.some((r) => r.source === "outbound"));
  assert((a.data.collections.leads ?? []).some((l: Doc) => l.journeyTrack?.furthestStep));
  assert(!JSON.stringify(a.data.collections.journey_events).includes("@"));
});
