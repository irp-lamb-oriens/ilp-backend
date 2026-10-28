import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { installFakeWorld, useFakeEnv } from "./e2e/fakeWorld.ts";
import { claimId, claimSlot, holdsSlot, releaseSlot, SLOT_CLAIMS, withLawyerSlots } from "../API/calls/slotClaims.ts";

/**
 * REL: one call per lawyer per start time, even when two members press Book
 * together or two server instances answer. Run: deno test --allow-env test/slotClaims_test.ts
 */

const AT = "2026-10-22T15:00:00.000Z";

Deno.test("holdsSlot: only a booked or running call at that lawyer and time", () => {
  const c = { providerId: "A", scheduledAt: AT, status: "booked" as const };
  assertEquals(holdsSlot(c, "A", AT), true);
  assertEquals(holdsSlot({ ...c, status: "in_progress" }, "A", AT), true);
  assertEquals(holdsSlot({ ...c, status: "cancelled" }, "A", AT), false);
  assertEquals(holdsSlot({ ...c, scheduledAt: "2026-10-22T15:20:00.000Z" }, "A", AT), false, "moved");
  assertEquals(holdsSlot({ ...c, providerId: "B" }, "A", AT), false, "reassigned");
  assertEquals(holdsSlot(null, "A", AT), false);
});

Deno.test("claimSlot: first wins; stale claims are taken over; release by the holder only", async () => {
  await useFakeEnv();
  const world = installFakeWorld("2026-10-20T15:00:00.000Z");
  try {
    assertEquals(await claimSlot("A", AT, "con_1"), true);
    assertEquals(await claimSlot("A", AT, "con_1"), true, "same call again");
    // The holder is being written (no record yet): honoured for two minutes.
    assertEquals(await claimSlot("A", AT, "con_2"), false);
    world.advance(3 * 60_000);
    world.put("consultations", "con_1", { id: "con_1", providerId: "A", scheduledAt: AT, status: "booked" });
    assertEquals(await claimSlot("A", AT, "con_2"), false, "holder booked");
    world.put("consultations", "con_1", { id: "con_1", providerId: "A", scheduledAt: AT, status: "cancelled" });
    assertEquals(await claimSlot("A", AT, "con_2"), true, "holder cancelled: stale");
    assertEquals(world.doc(SLOT_CLAIMS, claimId("A", AT))!.consultationId, "con_2");
    await releaseSlot("A", AT, "con_1");
    assertEquals(world.doc(SLOT_CLAIMS, claimId("A", AT))!.consultationId, "con_2", "not the holder: no-op");
    await releaseSlot("A", AT, "con_2");
    assertEquals(world.doc(SLOT_CLAIMS, claimId("A", AT)), null);
    // Another lawyer at the same time is independent.
    assertEquals(await claimSlot("B", AT, "con_9"), true);
  } finally {
    world.restore();
  }
});

Deno.test("withLawyerSlots: two bookings for one slot at once, one wins", async () => {
  await useFakeEnv();
  const world = installFakeWorld("2026-10-20T15:00:00.000Z");
  try {
    const booked: string[] = [];
    const attempt = (id: string) =>
      withLawyerSlots("A", async () => {
        // Re-check inside the lock, as the booking route does, then claim and write.
        if (booked.length) return false;
        if (!(await claimSlot("A", AT, id))) return false;
        world.put("consultations", id, { id, providerId: "A", scheduledAt: AT, status: "booked" });
        booked.push(id);
        return true;
      });
    const results = await Promise.all([attempt("con_a"), attempt("con_b")]);
    assertEquals(results.sort(), [false, true]);
    assertEquals(world.all("consultations").length, 1);
  } finally {
    world.restore();
  }
});
