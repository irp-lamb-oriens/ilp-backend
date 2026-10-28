import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { installFakeWorld, useFakeEnv } from "./e2e/fakeWorld.ts";
import { assignBlock, assignMember, ensureAssigned, offboardLawyer } from "../API/members/assignment.ts";
import { routeLawyer, slotsFor } from "../API/calls/callService.ts";
import { markCancelled } from "../API/payments/lifecycle.ts";

/**
 * REL: who a member's lawyer is. Routing persists at activation/booking, only
 * active lawyers licensed in the member's country (never seed lawyers for
 * real members), matters follow, and upcoming calls move or are cancelled on
 * reassignment, offboarding and membership end.
 * Run: deno test --allow-env test/assignment_test.ts
 */

const WEEK = [1, 2, 3, 4, 5].map((day) => ({ day, start: "08:00", end: "12:00" }));

async function seed() {
  await useFakeEnv();
  const world = installFakeWorld("2026-10-20T15:00:00.000Z");
  const lawyer = (id: string, country: string, extra: Record<string, unknown> = {}) => {
    world.put("providers", id, { name: id, email: `${id.toLowerCase()}@lawyers-e2e.io`, status: "active", active: true, jurisdictions: [country], legalAreas: ["immigration"], ...extra });
    world.put("lawyer_availability", id, { id, providerId: id, timezone: "America/Costa_Rica", weekly: WEEK, blackoutDates: [], minLeadHours: 0, maxCallsPerDay: 6, specialties: ["immigration"] });
  };
  lawyer("A", "CR");
  lawyer("C", "CR");
  lawyer("E", "ES");
  lawyer("ph_seed", "CR", { placeholder: true });
  lawyer("P", "CR", { status: "pending_review", active: false });
  world.put("clients", "m1", { email: "m1@mailbox-e2e.io", fullName: "Member One", legalCountry: "CR", country: "CR" });
  world.put("memberships", "mem1", { id: "mem1", clientId: "m1", status: "active", country: "CR", periodStart: "2026-10-20T15:00:00.000Z", periodEnd: "2026-11-20T15:00:00.000Z", minutesIncluded: 60, minutesUsed: 0, callsIncluded: 3, callsUsed: 0, paymentRef: "manual", createdAt: "2026-10-20T15:00:00.000Z" });
  world.put("matters", "mat1", { id: "mat1", clientId: "m1", title: "Residency", area: "immigration", country: "CR", stage: "intake", stageEnteredAt: "2026-10-20T15:00:00.000Z", openedAt: "2026-10-20T15:00:00.000Z" });
  return world;
}

const call = (id: string, providerId: string, scheduledAt: string) => ({
  id, clientId: "m1", providerId, scheduledAt, durationMin: 20, status: "booked", consent: { recording: "pending" }, createdAt: "2026-10-20T15:00:00.000Z",
});

Deno.test("assignBlock: inactive, other country, seed lawyer", async () => {
  const world = await seed();
  try {
    assertEquals(await assignBlock("m1", "A"), null);
    assertEquals((await assignBlock("m1", "E"))?.status, 409, "licensed in Spain");
    assertEquals((await assignBlock("m1", "P"))?.status, 409, "in review");
    assertEquals((await assignBlock("m1", "ph_seed"))?.status, 409, "seed lawyer");
    assertEquals((await assignBlock("m1", "nobody"))?.status, 404);
  } finally {
    world.restore();
  }
});

Deno.test("ensureAssigned: routes by country, persists, matters follow; inactive lawyers are skipped", async () => {
  const world = await seed();
  try {
    const first = await ensureAssigned("m1");
    assert(first === "A" || first === "C", `routed to ${first}`);
    assertEquals(world.doc("clients", "m1")!.assignedProviderId, first);
    assertEquals(world.doc("matters", "mat1")!.assignedProviderId, first);
    assertEquals(await ensureAssigned("m1"), first, "idempotent");
    // Switched off without offboarding (older data): neither routing nor slots use it.
    world.put("providers", first!, { ...world.doc("providers", first!), active: false });
    assertEquals(await slotsFor(first!), []);
    const other = first === "A" ? "C" : "A";
    assertEquals(await routeLawyer("m1"), other);
  } finally {
    world.restore();
  }
});

Deno.test("assignMember: calls move when the new lawyer is free, else cancel; never charged", async () => {
  const world = await seed();
  try {
    await assignMember("m1", "A", { email: "sam@internationallegalpartner.com", role: "staff" });
    world.put("consultations", "free", call("free", "A", "2026-10-22T15:00:00.000Z"));
    world.put("consultations", "busy", call("busy", "A", "2026-10-23T15:00:00.000Z"));
    world.put("consultations", "c_other", { ...call("c_other", "C", "2026-10-23T15:00:00.000Z"), clientId: "m9" }); // C is busy then
    const r = await assignMember("m1", "C", { email: "sam@internationallegalpartner.com", role: "staff" });
    assertEquals([r.moved, r.cancelled, r.matters], [["free"], ["busy"], ["mat1"]]);
    assertEquals([world.doc("consultations", "free")!.providerId, world.doc("consultations", "free")!.status], ["C", "booked"]);
    assertEquals(world.doc("consultations", "busy")!.status, "cancelled");
    assertEquals(world.doc("memberships", "mem1")!.callsUsed, 0);
    assert(world.all("audit_log").some((a) => a.action === "member.reassigned"));
  } finally {
    world.restore();
  }
});

Deno.test("offboardLawyer: members re-matched in their country or flagged; membership end cancels calls", async () => {
  const world = await seed();
  try {
    world.put("clients", "m2", { email: "m2@mailbox-e2e.io", fullName: "Member Two", legalCountry: "ES", country: "ES", assignedProviderId: "E" });
    world.put("memberships", "mem2", { id: "mem2", clientId: "m2", status: "active", country: "ES", periodEnd: "2026-11-20T15:00:00.000Z", createdAt: "2026-10-20T15:00:00.000Z" });
    await assignMember("m1", "A", { email: "sam@internationallegalpartner.com", role: "staff" });
    world.put("providers", "A", { ...world.doc("providers", "A"), active: false });
    world.put("providers", "E", { ...world.doc("providers", "E"), active: false });
    const a = await offboardLawyer("A", { email: "sam@internationallegalpartner.com", role: "staff" });
    assertEquals(a.members.map((m) => [m.clientId, m.providerId]), [["m1", "C"]]);
    const e = await offboardLawyer("E", { email: "sam@internationallegalpartner.com", role: "staff" });
    assertEquals(e.members.map((m) => [m.clientId, m.providerId]), [["m2", null]]);
    assert(world.all("csm_tasks").some((t) => t.clientId === "m2" && String(t.title).startsWith("Match a lawyer licensed")));

    world.put("consultations", "later", call("later", "C", "2026-11-25T15:00:00.000Z"));
    world.put("consultations", "past", { ...call("past", "C", "2026-10-19T15:00:00.000Z"), status: "completed" });
    await markCancelled(world.doc("memberships", "mem1") as never, { uid: "system", email: "system", role: "system" }, "test");
    assertEquals(world.doc("consultations", "later")!.status, "cancelled");
    assertEquals(world.doc("consultations", "past")!.status, "completed");
  } finally {
    world.restore();
  }
});
