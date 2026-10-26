import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import type { Opportunity } from "../../schemas/contracts.ts";
import {
  applyEdit,
  buildOpportunity,
  filterOpportunities,
  handoffNeedsOpportunity,
  linkQuote,
  moveStage,
  OpportunityError,
  opportunityFromHandoff,
  opportunityIdForHandoff,
  reconcileWithQuote,
  summarize,
  titleFromNotes,
} from "./logic.ts";
import { createOpportunityFromHandoff, type OpportunityDeps } from "./store.ts";

/**
 * Opportunity stage rules, quote linking and the handoff hook. Pure logic plus
 * the hook against an in-memory store: no Firestore, no network.
 *
 * Run: deno test --allow-env API/opportunities/opportunities_test.ts
 */

const NOW = new Date("2026-10-26T15:00:00Z");
const base = (over: Partial<Opportunity> = {}): Opportunity => ({
  id: "opp_1",
  clientId: "cli_alvarez",
  source: { kind: "handoff", id: "hof_1" },
  title: "S.A. clean-up",
  area: "corporate",
  stage: "identified",
  createdAt: "2026-10-01T15:00:00Z",
  updatedAt: "2026-10-01T15:00:00Z",
  ...over,
});

// ─── Create ────────────────────────────────────────────────────────────────

Deno.test("create: source is required (no orphan opportunities)", () => {
  assertThrows(() => buildOpportunity({ clientId: "c1", title: "Will" }), OpportunityError, "source is required");
  assertThrows(() => buildOpportunity({ clientId: "c1", title: "Will", source: { kind: "handoff" } }), OpportunityError, "source.id");
  assertThrows(() => buildOpportunity({ clientId: "c1", title: "Will", source: { kind: "rumour", id: "x" } }), OpportunityError, "Unknown source");
  assertThrows(() => buildOpportunity({ title: "Will", source: { kind: "manual" } }), OpportunityError, "clientId");
});

Deno.test("create: manual source needs no id; defaults stage identified, area general, owner from default", () => {
  const o = buildOpportunity({ clientId: "c1", title: " Will and testament ", source: { kind: "manual" } }, { now: NOW, defaultOwner: "carla@ilp.test" });
  assertEquals(o.stage, "identified");
  assertEquals(o.area, "general");
  assertEquals(o.title, "Will and testament");
  assertEquals(o.ownerEmail, "carla@ilp.test");
  assertEquals(o.source, { kind: "manual" });
  assertEquals(o.createdAt, NOW.toISOString());
});

Deno.test("create: value must be whole non-negative cents", () => {
  const ok = buildOpportunity({ clientId: "c1", title: "Will", source: { kind: "manual" }, valueCents: 185000 });
  assertEquals(ok.valueCents, 185000);
  assertThrows(() => buildOpportunity({ clientId: "c1", title: "Will", source: { kind: "manual" }, valueCents: 12.5 }), OpportunityError);
  assertThrows(() => buildOpportunity({ clientId: "c1", title: "Will", source: { kind: "manual" }, valueCents: -1 }), OpportunityError);
});

Deno.test("create: directly as won needs an outcome", () => {
  assertThrows(() => buildOpportunity({ clientId: "c1", title: "Will", source: { kind: "manual" }, stage: "won" }), OpportunityError, "outcome");
  const o = buildOpportunity({ clientId: "c1", title: "Will", source: { kind: "manual" }, stage: "won", outcome: "Signed on the call" }, { now: NOW });
  assertEquals(o.closedAt, NOW.toISOString());
});

// ─── Stage moves ───────────────────────────────────────────────────────────

Deno.test("stage: identified → quoted → negotiating moves freely", () => {
  const a = moveStage(base(), "quoted", undefined, NOW);
  assertEquals(a.stage, "quoted");
  const b = moveStage(a, "negotiating", undefined, NOW);
  assertEquals(b.stage, "negotiating");
  assertEquals(b.updatedAt, NOW.toISOString());
  assertEquals(moveStage(b, "identified", undefined, NOW).stage, "identified");
});

Deno.test("stage: won and lost require an outcome", () => {
  for (const to of ["won", "lost"] as const) {
    assertThrows(() => moveStage(base({ stage: "negotiating" }), to, "", NOW), OpportunityError, "outcome");
    assertThrows(() => moveStage(base({ stage: "negotiating" }), to, "  ", NOW), OpportunityError, "outcome");
    const o = moveStage(base({ stage: "negotiating" }), to, "Member chose a local notary", NOW);
    assertEquals(o.stage, to);
    assertEquals(o.outcome, "Member chose a local notary");
    assertEquals(o.closedAt, NOW.toISOString());
  }
});

Deno.test("stage: closed only reopens to negotiating, which clears outcome and closedAt", () => {
  const won = moveStage(base(), "won", "Quote accepted", NOW);
  assertThrows(() => moveStage(won, "lost", "Changed mind", NOW), OpportunityError, "reopened");
  assertThrows(() => moveStage(won, "identified", undefined, NOW), OpportunityError);
  const re = moveStage(won, "negotiating", undefined, NOW);
  assertEquals(re.stage, "negotiating");
  assertEquals(re.outcome, undefined);
  assertEquals(re.closedAt, undefined);
});

Deno.test("stage: unknown or same stage is refused", () => {
  assertThrows(() => moveStage(base(), "closed", undefined, NOW), OpportunityError, "Unknown");
  const e = assertThrows(() => moveStage(base(), "identified", undefined, NOW), OpportunityError) as OpportunityError;
  assertEquals(e.status, 409);
});

Deno.test("edit: clears optional fields, refuses an empty title, never touches stage", () => {
  const o = base({ valueCents: 5000, nextAction: { what: "Call" }, stage: "quoted" });
  const e = applyEdit(o, { valueCents: null, nextAction: null, stage: "won", ownerEmail: "Ana@ILP.test" }, NOW);
  assertEquals(e.valueCents, undefined);
  assertEquals(e.nextAction, undefined);
  assertEquals(e.stage, "quoted");
  assertEquals(e.ownerEmail, "ana@ilp.test");
  assertThrows(() => applyEdit(o, { title: "" }, NOW), OpportunityError);
});

// ─── Quotes ────────────────────────────────────────────────────────────────

Deno.test("quote link: sets quoteId, identified → quoted, value from the quote when none", () => {
  const o = linkQuote(base(), { quoteId: "q1", title: "S.A. clean-up", status: "draft", total: 1850 }, NOW);
  assertEquals(o.quoteId, "q1");
  assertEquals(o.stage, "quoted");
  assertEquals(o.valueCents, 185000);
  const n = linkQuote(base({ stage: "negotiating", valueCents: 90000 }), { id: "q2", status: "sent" }, NOW);
  assertEquals(n.stage, "negotiating");
  assertEquals(n.valueCents, 90000);
  assertThrows(() => linkQuote(base({ stage: "lost", outcome: "No" }), { quoteId: "q3" }, NOW), OpportunityError);
});

Deno.test("quote accepted by the member → won with outcome and acceptance time", () => {
  const o = base({ stage: "quoted", quoteId: "q1" });
  const won = reconcileWithQuote(o, { quoteId: "q1", title: "S.A. clean-up", status: "accepted", acceptedAt: "2026-10-20T10:00:00Z", total: 1850 }, NOW);
  assertEquals(won?.stage, "won");
  assertEquals(won?.closedAt, "2026-10-20T10:00:00Z");
  assertEquals(won?.valueCents, 185000);
  assert(won?.outcome?.includes("accepted"));
  // Not linked, already closed, or still open: no change.
  assertEquals(reconcileWithQuote(base({ stage: "quoted" }), { quoteId: "q1", status: "accepted" }, NOW), null);
  assertEquals(reconcileWithQuote(base({ stage: "quoted", quoteId: "q1" }), { quoteId: "q1", status: "sent" }, NOW), null);
  assertEquals(reconcileWithQuote(base({ stage: "lost", quoteId: "q1", outcome: "x" }), { quoteId: "q1", status: "accepted" }, NOW), null);
  // A rejected quote leaves the decision to the CSM.
  assertEquals(reconcileWithQuote(base({ stage: "negotiating", quoteId: "q1" }), { quoteId: "q1", status: "rejected" }, NOW), null);
});

// ─── Summary and filters ───────────────────────────────────────────────────

Deno.test("summary: value by stage, win rate, days to close, GMV apart from platform revenue", () => {
  const items = [
    base({ id: "a", stage: "identified", valueCents: 50000 }),
    base({ id: "b", stage: "quoted", valueCents: 120000 }),
    base({ id: "c", stage: "won", valueCents: 185000, quoteId: "q1", outcome: "ok", createdAt: "2026-10-01T00:00:00Z", closedAt: "2026-10-11T00:00:00Z" }),
    base({ id: "d", stage: "won", valueCents: 60000, outcome: "ok", createdAt: "2026-10-01T00:00:00Z", closedAt: "2026-10-05T00:00:00Z" }),
    base({ id: "e", stage: "lost", valueCents: 40000, outcome: "no", createdAt: "2026-10-01T00:00:00Z", closedAt: "2026-10-04T00:00:00Z" }),
  ];
  const s = summarize(items, new Map([["q1", { quoteId: "q1", status: "accepted", total: 1850, costSubtotal: 1480, earnings: 370 }]]));
  assertEquals(s.byStage.won, { count: 2, valueCents: 245000 });
  assertEquals(s.open, { count: 2, valueCents: 170000 });
  assertEquals(s.winRate, 66.7);
  assertEquals(s.avgDaysToWin, 7);
  assertEquals(s.avgDaysToClose, 5.7);
  assertEquals(s.legalGmvWonCents, 245000);
  assertEquals(s.platformRevenueCents, 37000);
  const empty = summarize([]);
  assertEquals(empty.winRate, null);
  assertEquals(empty.avgDaysToClose, null);
});

Deno.test("filters: stage, owner (case-insensitive), area, member, open only, text", () => {
  const items = [
    base({ id: "a", ownerEmail: "carla@ilp.test" }),
    base({ id: "b", stage: "won", outcome: "ok", area: "property", clientId: "cli_hayes" }),
    base({ id: "c", stage: "quoted", title: "Residency renewal", area: "immigration" }),
  ];
  const ids = (f: Parameters<typeof filterOpportunities>[1]) => filterOpportunities(items, f, new Map([["cli_hayes", "Daniel Hayes"]])).map((o) => o.id);
  assertEquals(ids({ stage: "quoted" }), ["c"]);
  assertEquals(ids({ ownerEmail: "CARLA@ilp.test" }), ["a"]);
  assertEquals(ids({ area: "property" }), ["b"]);
  assertEquals(ids({ clientId: "cli_hayes" }), ["b"]);
  assertEquals(ids({ includeClosed: false }), ["a", "c"]);
  assertEquals(ids({ q: "hayes" }), ["b"]);
  assertEquals(ids({ q: "residency" }), ["c"]);
});

// ─── Handoff hook ──────────────────────────────────────────────────────────

const HANDOFF = {
  id: "hof_alvarez",
  consultationId: "con_1",
  clientId: "cli_alvarez",
  matterId: "mat_1",
  providerId: "prov_rojas",
  legalNextSteps: [{ what: "Send the S.A. books", who: "client" }],
  commercialNotes: "S.A. clean-up quote: books two years behind. Also ask about the Tamarindo lot.",
  approvedAt: "2026-10-26T14:00:00Z",
  csmTaskIds: [],
};

Deno.test("handoff: commercial notes appearing (create or later edit) trigger an opportunity", () => {
  assert(handoffNeedsOpportunity(null, HANDOFF));
  assert(handoffNeedsOpportunity({ ...HANDOFF, commercialNotes: "" }, HANDOFF));
  assert(!handoffNeedsOpportunity(HANDOFF, { ...HANDOFF, commercialNotes: "edited" }));
  assert(!handoffNeedsOpportunity(null, { ...HANDOFF, commercialNotes: "  " }));
  assert(!handoffNeedsOpportunity(null, { ...HANDOFF, clientId: "" }));
});

Deno.test("handoff: title from the first sentence of the notes, 80 characters max", () => {
  assertEquals(titleFromNotes(HANDOFF.commercialNotes), "S.A. clean-up quote: books two years behind");
  assertEquals(titleFromNotes("Will\nand more"), "Will");
  assertEquals(titleFromNotes("x".repeat(100)).length, 78);
});

Deno.test("handoff: opportunity is identified, sourced to the handoff, with a 48 h next action", () => {
  const o = opportunityFromHandoff(HANDOFF, { ownerEmail: "carla@ilp.test", area: "corporate", now: NOW });
  assertEquals(o?.id, opportunityIdForHandoff("hof_alvarez"));
  assertEquals(o?.stage, "identified");
  assertEquals(o?.source, { kind: "handoff", id: "hof_alvarez" });
  assertEquals(o?.matterId, "mat_1");
  assertEquals(o?.providerId, "prov_rojas");
  assertEquals(o?.ownerEmail, "carla@ilp.test");
  assertEquals(o?.nextAction?.dueAt, new Date(NOW.getTime() + 48 * 3600_000).toISOString());
  assertEquals(opportunityFromHandoff({ ...HANDOFF, commercialNotes: "" }), null);
});

function memoryDeps(csm?: string): OpportunityDeps & { saved: Opportunity[] } {
  const store = new Map<string, Opportunity>();
  const saved: Opportunity[] = [];
  return {
    saved,
    getOpportunity: (id) => Promise.resolve(store.get(id) ?? null),
    saveOpportunity: (o) => {
      store.set(o.id, o);
      saved.push(o);
      return Promise.resolve();
    },
    memberCsm: () => Promise.resolve(csm),
    matterArea: () => Promise.resolve("corporate"),
    defaultOwner: () => "default@ilp.test",
  };
}

Deno.test("hook: creates one opportunity per handoff, owned by the membership's CSM", async () => {
  const deps = memoryDeps("carla@ilp.test");
  const first = await createOpportunityFromHandoff(HANDOFF, deps);
  const again = await createOpportunityFromHandoff(HANDOFF, deps);
  assertEquals(deps.saved.length, 1);
  assertEquals(first?.id, again?.id);
  assertEquals(first?.ownerEmail, "carla@ilp.test");
  assertEquals(first?.area, "corporate");
});

Deno.test("hook: falls back to DEFAULT_CSM_EMAIL; no notes or a failing store creates nothing and never throws", async () => {
  const deps = memoryDeps(undefined);
  assertEquals((await createOpportunityFromHandoff(HANDOFF, deps))?.ownerEmail, "default@ilp.test");
  const none = memoryDeps("carla@ilp.test");
  assertEquals(await createOpportunityFromHandoff({ ...HANDOFF, commercialNotes: undefined }, none), null);
  assertEquals(none.saved.length, 0);
  const broken = { ...memoryDeps("x"), getOpportunity: () => Promise.reject(new Error("firestore down")) };
  assertEquals(await createOpportunityFromHandoff(HANDOFF, broken), null);
});
