import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { buildTask, eventsFor, taskIdFor } from "../API/members/events.ts";
import { missingDocumentEvents, renewalEvents, unansweredQuoteEvents } from "../jobs/taskRuleSweep.ts";
import { type Membership, TASK_RULES } from "../schemas/contracts.ts";

/**
 * One test per TASK_RULES entry plus the transition and sweep selectors.
 * Pure functions only: no Firestore, no network.
 *
 * Run: deno test --allow-env test/taskRules_test.ts
 */

const NOW = new Date("2026-10-26T12:00:00Z");
const hours = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();

for (const [name, rule] of Object.entries(TASK_RULES)) {
  Deno.test(`rule ${name} creates a ${rule.type} task due in ${rule.dueInHours}h`, () => {
    const t = buildTask(name, { clientId: "c1", sourceId: "s1" }, NOW, "csm@internationallegalpartner.com");
    assertEquals(t?.type, rule.type);
    assertEquals(t?.title, rule.title);
    assertEquals(t?.dueAt, hours(rule.dueInHours));
    assertEquals(t?.status, "open");
    assertEquals(t?.clientId, "c1");
    assertEquals(t?.ownerEmail, "csm@internationallegalpartner.com");
    assertEquals(t?.source.id, "s1");
    assertEquals(t?.id, taskIdFor(name, { clientId: "c1", sourceId: "s1" }));
  });
}

Deno.test("unknown events and missing clientId produce no task", () => {
  assertEquals(buildTask("nope.event", { clientId: "c1" }, NOW), null);
  assertEquals(buildTask("membership.activated", { clientId: "" }, NOW), null);
});

Deno.test("task ids are deterministic per event and source (idempotent emit)", () => {
  const a = taskIdFor("membership.activated", { clientId: "c1", sourceId: "mem_1" });
  const b = taskIdFor("membership.activated", { clientId: "c1", sourceId: "mem_1" });
  const c = taskIdFor("consultation.booked", { clientId: "c1", sourceId: "mem_1" });
  assertEquals(a, b);
  assertEquals(a === c, false);
});

Deno.test("detail and source kind are carried onto the task", () => {
  const t = buildTask("quote.unanswered_5d", { clientId: "c1", sourceId: "q1", detail: "S.A. clean-up" }, NOW);
  assertEquals(t?.title, "Follow up on open proposal: S.A. clean-up");
  assertEquals(t?.source.kind, "quote");
  assertEquals(t?.ownerEmail, undefined);
});

Deno.test("eventsFor: membership becoming active emits membership.activated once", () => {
  const after = { id: "m1", clientId: "c1", status: "active" };
  assertEquals(eventsFor("memberships", { ...after, status: "pending" }, after).map((e) => e[0]), ["membership.activated"]);
  assertEquals(eventsFor("memberships", after, after).length, 0);
  assertEquals(eventsFor("memberships", null, after).map((e) => e[0]), ["membership.activated"]);
});

Deno.test("eventsFor: new booked consultation emits consultation.booked", () => {
  const c = { id: "k1", clientId: "c1", status: "booked", matterId: "mt1" };
  const ev = eventsFor("consultations", null, c);
  assertEquals(ev.map((e) => e[0]), ["consultation.booked"]);
  assertEquals(ev[0][1].matterId, "mt1");
  assertEquals(eventsFor("consultations", c, { ...c, status: "completed" }).length, 0);
});

Deno.test("eventsFor: handoff emits approved, plus opportunity when commercial notes exist", () => {
  const h = { id: "h1", clientId: "c1" };
  assertEquals(eventsFor("handoffs", null, h).map((e) => e[0]), ["handoff.approved"]);
  assertEquals(
    eventsFor("handoffs", null, { ...h, commercialNotes: "S.A. clean-up quote" }).map((e) => e[0]),
    ["handoff.approved", "handoff.opportunity"],
  );
});

const mem = (over: Partial<Membership>): Membership => ({
  id: "m1",
  clientId: "c1",
  plan: "standard",
  status: "active",
  country: "CR",
  periodStart: "2026-10-01T00:00:00Z",
  periodEnd: "2026-11-01T00:00:00Z",
  minutesIncluded: 60,
  minutesUsed: 0,
  callsIncluded: 3,
  callsUsed: 0,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  ...over,
});

Deno.test("renewal sweep picks active memberships ending within 7 days", () => {
  const ev = renewalEvents([
    mem({ id: "a" }), // ends in ~5.5 days
    mem({ id: "b", periodEnd: "2026-12-01T00:00:00Z" }),
    mem({ id: "c", status: "cancelled" }),
    mem({ id: "d", periodEnd: "2026-10-20T00:00:00Z" }), // already past
  ], NOW);
  assertEquals(ev.map((e) => e[1].sourceId), ["a_2026-11-01"]);
  assertEquals(ev[0][0], "membership.renewal_7d");
});

Deno.test("quote sweep picks quotes sent 5+ days ago", () => {
  const ev = unansweredQuoteEvents([
    {
      id: "c1",
      quotes: [
        { id: "q1", status: "sent", createdAt: "2026-10-20T00:00:00Z", title: "S.A. clean-up" },
        { id: "q2", status: "sent", createdAt: "2026-10-25T00:00:00Z" },
        { id: "q3", status: "accepted", createdAt: "2026-10-01T00:00:00Z" },
      ],
    },
  ], NOW);
  assertEquals(ev.map((e) => e[1].sourceId), ["q1"]);
  assertEquals(ev[0][0], "quote.unanswered_5d");
});

Deno.test("document sweep picks document actions overdue by 3+ days", () => {
  const ev = missingDocumentEvents([
    {
      id: "c1",
      pendingActions: [
        { id: "p1", label: "Upload passport copy", dueAt: "2026-10-20T00:00:00Z" },
        { id: "p2", label: "Upload passport copy", dueAt: "2026-10-25T00:00:00Z" },
        { id: "p3", label: "Call the bank", dueAt: "2026-10-01T00:00:00Z" },
      ],
    },
  ], NOW);
  assertEquals(ev.map((e) => e[1].sourceId), ["p1"]);
  assertEquals(ev[0][0], "document.missing_3d");
});
