import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { pickProviderProfile } from "../API/providers/selfProfile.ts";

/** QA round 1: a lawyer cannot vet themselves or write staff fields. Run: deno test test/providerSelfProfile_test.ts */

Deno.test("provider self profile: staff-owned fields are dropped", () => {
  const out = pickProviderProfile({
    name: "Ana",
    country: "CR",
    languages: ["es", "en"],
    status: "vetted",
    score: 5,
    insurance: "verified",
    slaStatus: "ok",
    notes: "internal",
    commissionPct: 0,
    active: true,
  });
  assertEquals(out, { name: "Ana", country: "CR", languages: ["es", "en"] });
});
