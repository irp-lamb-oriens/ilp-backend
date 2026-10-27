import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import {
  accessFor,
  daysPastDue,
  GRACE_DAYS,
  invoiceMembershipId,
  invoicePeriod,
  invoiceSubscriptionId,
  manualSweepAction,
  type MembershipDoc,
  nextPeriod,
  renewalFields,
} from "../API/payments/lifecycle.ts";
import { portalSessionBody, stripeKeyAllowed } from "../API/payments/membership.ts";

/**
 * P2 payments lifecycle: pure rules only (no Firestore, no Stripe).
 * Run: deno test --allow-env test/lifecycle_test.ts
 */

const NOW = new Date("2026-10-26T12:00:00Z");
const days = (d: number) => new Date(NOW.getTime() + d * 86400_000).toISOString();

function mem(over: Partial<MembershipDoc> = {}): MembershipDoc {
  return {
    id: "mem_1", clientId: "c1", plan: "standard", status: "active", country: "CR",
    periodStart: days(-30), periodEnd: days(1), minutesIncluded: 60, minutesUsed: 40,
    callsIncluded: 3, callsUsed: 2, paymentRef: "manual:marked-paid", createdAt: days(-60), updatedAt: days(-1),
    ...over,
  };
}

Deno.test("nextPeriod keeps the anniversary when paid a few days late", () => {
  const p = nextPeriod({ periodEnd: days(-3) }, NOW);
  assertEquals(p.periodStart, days(-3));
  assertEquals(p.periodEnd > NOW.toISOString(), true);
});

Deno.test("nextPeriod starts now when paid more than a month late", () => {
  const p = nextPeriod({ periodEnd: days(-45) }, NOW);
  assertEquals(p.periodStart, NOW.toISOString());
});

Deno.test("nextPeriod uses the Stripe invoice period when given", () => {
  const p = nextPeriod({ periodEnd: days(-1) }, NOW, { start: days(0), end: days(30) });
  assertEquals(p, { periodStart: days(0), periodEnd: days(30) });
});

Deno.test("renewalFields resets usage and clears past due", () => {
  const f = renewalFields({ periodEnd: days(-1) }, NOW);
  assertEquals([f.status, f.minutesUsed, f.callsUsed, f.pastDueSince, f.renewalPaidFor], ["active", 0, 0, null, null]);
});

Deno.test("accessFor: active can book", () => {
  assertEquals(accessFor(mem(), NOW).canBook, true);
});

Deno.test(`accessFor: past due keeps access for ${GRACE_DAYS} days`, () => {
  const a = accessFor(mem({ status: "past_due", pastDueSince: days(-6) }), NOW);
  assertEquals([a.canBook, a.inGrace], [true, true]);
  const b = accessFor(mem({ status: "past_due", pastDueSince: days(-7) }), NOW);
  assertEquals([b.canBook, b.inGrace], [false, false]);
  assertEquals(b.message?.includes("paused"), true);
});

Deno.test("accessFor: cancelled, pending and missing cannot book", () => {
  assertEquals(accessFor(mem({ status: "cancelled" }), NOW).canBook, false);
  assertEquals(accessFor(mem({ status: "pending" }), NOW).canBook, false);
  assertEquals(accessFor(null, NOW).canBook, false);
});

Deno.test("manual sweep: lapsed period goes past due, cancel-at-end cancels, prepaid renews", () => {
  assertEquals(manualSweepAction(mem({ periodEnd: days(-0.1) }), NOW), "past_due");
  assertEquals(manualSweepAction(mem({ periodEnd: days(-0.1), cancelAtPeriodEnd: true }), NOW), "cancelled");
  assertEquals(manualSweepAction(mem({ periodEnd: days(-0.1), renewalPaidFor: days(-0.1) }), NOW), "renewed");
  assertEquals(manualSweepAction(mem({ periodEnd: days(2) }), NOW), null);
});

Deno.test("manual sweep ignores Stripe memberships and non-active ones", () => {
  assertEquals(manualSweepAction(mem({ periodEnd: days(-1), paymentRef: "sub_123" }), NOW), null);
  assertEquals(manualSweepAction(mem({ periodEnd: days(-1), status: "past_due" }), NOW), null);
});

Deno.test("daysPastDue counts whole days", () => {
  assertEquals(daysPastDue({ pastDueSince: days(-3) }, NOW), 3);
  assertEquals(daysPastDue({}, NOW), null);
});

Deno.test("invoice readers handle old and new Stripe shapes", () => {
  const old = { id: "in_1", subscription: "sub_A", subscription_details: { metadata: { membershipId: "mem_A" } } };
  const neu = { id: "in_2", parent: { subscription_details: { subscription: "sub_B", metadata: { membershipId: "mem_B" } } } };
  assertEquals([invoiceSubscriptionId(old), invoiceMembershipId(old)], ["sub_A", "mem_A"]);
  assertEquals([invoiceSubscriptionId(neu), invoiceMembershipId(neu)], ["sub_B", "mem_B"]);
  const withLines = { lines: { data: [{ type: "subscription", period: { start: 1793016000, end: 1795694400 } }] } };
  assertEquals(invoicePeriod(withLines)?.start, new Date(1793016000 * 1000).toISOString());
});

Deno.test("live Stripe keys need STRIPE_ALLOW_LIVE", () => {
  assertEquals(stripeKeyAllowed("sk_test_abc", false), true);
  assertEquals(stripeKeyAllowed("sk_live_abc", false), false);
  assertEquals(stripeKeyAllowed("sk_live_abc", true), true);
  assertEquals(stripeKeyAllowed("pk_live_abc", true), false);
});

Deno.test("join portal session: the body always carries token and expiresAt (Bearer auth)", () => {
  const issued = { token: "secret", expiresAt: "2026-11-02T12:00:00.000Z" };
  const s = { clientId: "c1", email: "a@b.co" };
  assertEquals(portalSessionBody(issued, s), { token: "secret", expiresAt: issued.expiresAt, projectId: "c1", email: "a@b.co" });
});
