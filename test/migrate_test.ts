import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { countryOf, matterFromClient, membershipFromClient } from "../scripts/migrateToRecords.ts";

/** Run: deno test --allow-env test/migrate_test.ts */

const NOW = "2026-10-26T12:00:00.000Z";

Deno.test("matterFromClient maps stage, area, provider and first pending action", () => {
  const m = matterFromClient({
    id: "c1",
    stage: "documents",
    stageEnteredAt: "2026-10-01T00:00:00Z",
    createdAt: "2026-09-01T00:00:00Z",
    assignedProviderId: "prov_1",
    clientFields: { legalArea: "property", legalMatter: "Title transfer, Tamarindo lot" },
    jurisdiction: "Costa Rica",
    pendingActions: [{ id: "p1", label: "Upload deed copy", dueAt: "2026-10-30T00:00:00Z" }],
  }, NOW);
  assertEquals(m.id, "mat_mig_c1");
  assertEquals(m.title, "Title transfer, Tamarindo lot");
  assertEquals(m.area, "property");
  assertEquals(m.country, "CR");
  assertEquals(m.stage, "documents");
  assertEquals(m.assignedProviderId, "prov_1");
  assertEquals(m.nextStep, { what: "Upload deed copy", who: "ilp", dueAt: "2026-10-30T00:00:00Z" });
  assertEquals(m.closedAt, undefined);
});

Deno.test("matterFromClient falls back to defaults and closes closed stages", () => {
  const m = matterFromClient({ id: "c2", stage: "closed", updatedAt: "2026-10-02T00:00:00Z" }, NOW);
  assertEquals(m.title, "General matter");
  assertEquals(m.area, "general");
  assertEquals(m.closedAt, "2026-10-02T00:00:00Z");
});

Deno.test("countryOf recognises Panama and Mexico, defaults to CR", () => {
  assertEquals(countryOf({ jurisdiction: "Panamá" }), "PA");
  assertEquals(countryOf({ clientFields: { country: "MX" } }), "MX");
  assertEquals(countryOf({}), "CR");
});

Deno.test("no membership without paid membership data", () => {
  assertEquals(membershipFromClient({ id: "c1", charges: [{ label: "Notary fee", status: "paid", createdAt: NOW }] }, NOW), null);
  assertEquals(membershipFromClient({ id: "c1", charges: [{ label: "Membership", status: "pending", createdAt: NOW }] }, NOW), null);
});

Deno.test("paid membership charges create an active membership", () => {
  const m = membershipFromClient({
    id: "c1",
    charges: [
      { label: "Activation fee", status: "paid", createdAt: "2026-10-10T00:00:00.000Z" },
      { label: "Membership October", status: "paid", createdAt: "2026-10-10T00:00:00.000Z" },
    ],
  }, NOW)!;
  assertEquals(m.id, "mem_mig_c1");
  assertEquals(m.status, "active");
  assertEquals(m.periodEnd, "2026-11-10T00:00:00.000Z");
  assertEquals(m.activationPaidAt, "2026-10-10T00:00:00.000Z");
  assertEquals(m.minutesIncluded, 60);
});

Deno.test("a lapsed period becomes past_due", () => {
  const m = membershipFromClient({
    id: "c1",
    charges: [{ label: "Membership", status: "paid", createdAt: "2026-08-01T00:00:00.000Z" }],
  }, NOW)!;
  assertEquals(m.status, "past_due");
});
