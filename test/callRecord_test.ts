import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { installFakeWorld, useFakeEnv } from "./e2e/fakeWorld.ts";
import { FakeApp } from "./e2e/fakeApp.ts";
import { chargeableMinutes, chargeConsultation } from "../API/members/service.ts";
import { eventsFor } from "../API/members/events.ts";
import type { Consultation } from "../schemas/contracts.ts";

/**
 * REL: what the lawyer writes on a call. Minutes are charged once and never
 * above the booked length; a transcript needs recording consent; a call
 * cannot be completed before it starts; a handoff needs the confirmed
 * summary; staff commercial notes added later open the proposal task.
 * Run: deno test --allow-env test/callRecord_test.ts
 */

Deno.test("chargeableMinutes: recorded minutes, capped at the booked length, never negative", () => {
  assertEquals(chargeableMinutes({ minutesUsed: 12, durationMin: 20 }), 12);
  assertEquals(chargeableMinutes({ minutesUsed: 500, durationMin: 20 }), 20);
  assertEquals(chargeableMinutes({ minutesUsed: -5, durationMin: 20 }), 0);
  assertEquals(chargeableMinutes({ minutesUsed: undefined, durationMin: 20 }), 20);
  assertEquals(chargeableMinutes({ minutesUsed: 7.6, durationMin: 0 }), 8, "default length 20");
});

Deno.test("eventsFor: commercial notes added by staff later open the proposal task once", () => {
  const h = { id: "h1", clientId: "c1", matterId: "m1" };
  assertEquals(eventsFor("handoffs", null, h).map(([n]) => n), ["handoff.approved"]);
  assertEquals(eventsFor("handoffs", h, { ...h, commercialNotes: "Quote the S.A. clean-up" }).map(([n]) => n), ["handoff.opportunity"]);
  assertEquals(eventsFor("handoffs", { ...h, commercialNotes: "a" }, { ...h, commercialNotes: "b" }).map(([n]) => n), []);
  assertEquals(eventsFor("handoffs", null, { ...h, commercialNotes: "x" }).map(([n]) => n), ["handoff.approved", "handoff.opportunity"]);
});

Deno.test("chargeConsultation: two completions at once charge once", async () => {
  await useFakeEnv();
  const world = installFakeWorld("2026-10-21T15:30:00.000Z");
  try {
    world.put("memberships", "mem1", { id: "mem1", clientId: "c1", status: "active", minutesIncluded: 60, minutesUsed: 0, callsIncluded: 3, callsUsed: 0, createdAt: "2026-10-01T00:00:00Z" });
    const c = { id: "con1", clientId: "c1", providerId: "A", scheduledAt: "2026-10-21T15:00:00.000Z", durationMin: 20, minutesUsed: 15, status: "completed", consent: { recording: "pending" }, createdAt: "2026-10-20T00:00:00Z" } as Consultation;
    world.put("consultations", "con1", c as unknown as Record<string, unknown>);
    await Promise.all([chargeConsultation(c), chargeConsultation(c), chargeConsultation(c)]);
    assertEquals([world.doc("memberships", "mem1")!.minutesUsed, world.doc("memberships", "mem1")!.callsUsed], [15, 1]);
    assert(world.doc("consultations", "con1")!.chargedAt);
  } finally {
    world.restore();
  }
});

Deno.test("lawyer PATCH / handoff: consent for transcripts, no early completion, confirmed summary first", async () => {
  await useFakeEnv();
  const world = installFakeWorld("2026-10-21T14:00:00.000Z");
  try {
    const app = new FakeApp();
    (await import("../API/provider/providerDashboardRouter.ts")).default(app as never);
    (await import("../API/members/membersRouter.ts")).default(app as never);
    world.put("provider_sessions", "tokA", { email: "ana@mora-legal.io", providerId: "A", expiresAt: "2030-01-01T00:00:00Z" });
    world.put("memberships", "mem1", { id: "mem1", clientId: "c1", status: "active", minutesIncluded: 60, minutesUsed: 0, callsIncluded: 3, callsUsed: 0, createdAt: "2026-10-01T00:00:00Z" });
    const base = { clientId: "c1", providerId: "A", scheduledAt: "2026-10-21T15:00:00.000Z", durationMin: 20, status: "booked", createdAt: "2026-10-20T00:00:00Z" };
    world.put("consultations", "noConsent", { ...base, id: "noConsent", consent: { recording: "declined" } });
    world.put("consultations", "ok", { ...base, id: "ok", consent: { recording: "granted" } });
    const h = { authorization: "Bearer tokA" };
    const patch = (id: string, body: unknown) => app.call("PATCH", `/api/lawyer/consultations/${id}`, { headers: h, body });

    assertEquals((await patch("noConsent", { transcript: "words" })).status, 409, "no consent, no transcript");
    assertEquals(world.doc("consultations", "noConsent")!.transcript, undefined);
    assertEquals((await patch("ok", { status: "completed" })).status, 409, "an hour before the call");
    assertEquals((await patch("ok", { minutesUsed: "lots" })).status, 400);
    assertEquals((await patch("ok", { summary: { text: "", status: "confirmed" } })).status, 400);

    world.setNow("2026-10-21T15:21:00.000Z");
    assertEquals((await patch("ok", { transcript: "Lawyer: hello. Member: hi." })).status, 200);
    assertEquals(world.doc("consultations", "ok")!.transcriptSource, "pasted");
    const early = await app.call("POST", "/api/lawyer/handoffs", { headers: h, body: { consultationId: "ok", legalNextSteps: [{ what: "Send the deed" }] } });
    assertEquals(early.status, 409, "summary not confirmed");
    const done = await patch("ok", { status: "completed", minutesUsed: 90, summary: { text: "Discussed the deed.", status: "confirmed" } });
    assertEquals(done.status, 200, JSON.stringify(done.body));
    assertEquals(world.doc("memberships", "mem1")!.minutesUsed, 20, "capped at the booked 20");
    assertEquals((await patch("ok", { summary: { text: "Rewrite", status: "suggested" } })).status, 409, "a confirmed summary stays confirmed");
    const hof = await app.call("POST", "/api/lawyer/handoffs", { headers: h, body: { consultationId: "ok", legalNextSteps: [{ what: "Send the deed", who: "boss", dueAt: "soon" }], commercialNotes: "upsell" } });
    assertEquals(hof.status, 201, JSON.stringify(hof.body));
    const stored = world.doc("handoffs", hof.body.id)!;
    assertEquals(stored.legalNextSteps, [{ what: "Send the deed", who: "client" }]);
    assertEquals(stored.commercialNotes, undefined);
    assert(world.all("audit_log").some((a) => a.action === "consultation.summary_confirmed"));
    assert(world.all("audit_log").some((a) => a.action === "handoff.created"));
  } finally {
    world.restore();
  }
});
