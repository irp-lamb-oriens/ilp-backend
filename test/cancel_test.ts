import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { cancelReasonText, membershipView, saveTaskKey } from "../API/payments/cancel.ts";
import type { MembershipDoc } from "../API/payments/lifecycle.ts";

/** P2 self-serve cancel: pure parts. Run: deno test --allow-env test/cancel_test.ts */

const m: MembershipDoc = {
  id: "mem_1", clientId: "c1", plan: "standard", status: "active", country: "CR",
  periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z",
  minutesIncluded: 60, minutesUsed: 20, callsIncluded: 3, callsUsed: 1,
  paymentRef: "sub_ABC123", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
};

Deno.test("cancel reason: label plus comment, or a default", () => {
  assertEquals(cancelReasonText("leaving_country", " Moving to Portugal "), "I am leaving the country — Moving to Portugal");
  assertEquals(cancelReasonText("bogus", ""), "No reason given");
  assertEquals(cancelReasonText(undefined, "Too busy"), "Too busy");
});

Deno.test("membership view hides the payment reference", () => {
  const v = membershipView(m, new Date("2026-10-26T00:00:00Z"));
  assertEquals(JSON.stringify(v).includes("sub_ABC123"), false);
  assertEquals(v.membership?.paidBy, "card");
  assertEquals(v.access.canBook, true);
});

Deno.test("save task key is stable per period", () => {
  assertEquals(saveTaskKey(m), "mem_1_2026-11-01");
});
