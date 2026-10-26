import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { build, demoMeetUrl } from "../scripts/seedDemo.ts";
import { normalizeAvailability } from "../API/calls/callLogic.ts";

/**
 * P4: the demo seed carries what Today and booking need (no Firestore).
 * Run: deno test --allow-env --allow-read test/seedDemo_test.ts
 */

const data = build();

Deno.test("seed: each demo lawyer has valid hours and specialties", () => {
  assertEquals(data.availability.map((a) => a.providerId).sort(), ["demo_prov_mora", "demo_prov_solis", "demo_prov_vargas"]);
  for (const a of data.availability) {
    const n = normalizeAvailability(a, a.providerId);
    assertEquals("error" in n, false, `${a.providerId}: ${"error" in n ? n.error : ""}`);
    assertEquals(a.specialties.length > 0, true);
  }
});

Deno.test("seed: every booked call has a Meet link in xxx-xxxx-xxx form", () => {
  const booked = data.consultations.filter((c) => c.status === "booked");
  assertEquals(booked.length > 0, true);
  for (const c of booked) assertEquals(/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(c.meetUrl ?? ""), true, c.id);
  assertEquals(demoMeetUrl("x"), demoMeetUrl("x"));
});

Deno.test("seed: today's 10:00 Hayes call is ready for the 3-click handoff", () => {
  const c = data.consultations.find((x) => x.id === "demo_con_hayes_1");
  assertEquals(c?.consent.recording, "granted");
  assertEquals(c?.summary?.status, "suggested");
  assertEquals(c?.suggestedNextSteps?.length, 2);
  assertEquals(c?.status, "booked");
});

Deno.test("seed: the Alvarez handoff's commercial notes open an opportunity (P5/P7)", () => {
  const withNotes = data.handoffs.filter((h) => h.commercialNotes);
  assertEquals(withNotes.length > 0, true);
  assertEquals(data.opportunities.length, withNotes.length);
  for (const h of withNotes) {
    const o = data.opportunities.find((x) => x.id === `opp_hof_${h.id}`);
    assertEquals(o?.source, { kind: "handoff", id: h.id });
    assertEquals(o?.clientId, h.clientId);
    assertEquals(o?.stage, "identified");
    assertEquals(o?.ownerEmail, o?.ownerEmail?.toLowerCase());
  }
  assertEquals(data.opportunities.some((o) => o.clientId.includes("alvarez")), true);
});
