import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { installFakeWorld, useFakeEnv } from "./e2e/fakeWorld.ts";
import { lawyerFeesOf, onQuoteAccepted, providerIdsOf, settlementFor } from "../API/finance/quoteAccepted.ts";

/**
 * REL: an accepted quote opens its settlement once, with each lawyer's fee
 * pending (never the client price), and providerIds for the lawyer Finance
 * query. Run: deno test --allow-env test/quoteAccepted_test.ts
 */

const QUOTE = {
  quoteId: "q1",
  title: "S.A. clean-up",
  total: 1300,
  costSubtotal: 1000,
  providerIds: ["A"],
  lineItems: [
    { lineId: "l1", label: "Books", amount: 700, marginPct: 30, providerId: "A" },
    { lineId: "l2", label: "Registry filing", amount: 300, marginPct: 30 }, // no provider: the quote's lawyer
    { lineId: "l3", label: "Notary", amount: 200, marginPct: 10, providerId: "N" },
  ],
};

Deno.test("lawyerFeesOf: cost per lawyer, unowned lines to the quote's lawyer, seed `lines` in cents", () => {
  assertEquals(lawyerFeesOf(QUOTE), [{ providerId: "A", amount: 1000 }, { providerId: "N", amount: 200 }]);
  assertEquals(lawyerFeesOf({ lines: [{ label: "x", amountMinor: 45050 }] }, "B"), [{ providerId: "B", amount: 450.5 }]);
  assertEquals(lawyerFeesOf({ lineItems: [{ amount: 100 }] }), [], "nobody to pay");
});

Deno.test("settlementFor: pending payouts, no client price, providerIds", () => {
  const s = settlementFor("c1", QUOTE, new Map([["A", "Ana Mora"]]), null, "2026-10-21T00:00:00.000Z");
  assertEquals(s.providerIds, ["A", "N"]);
  assertEquals((s.providerPayments as Array<Record<string, unknown>>).map((p) => [p.providerId, p.amount, p.paid, p.providerName]), [["A", 1000, false, "Ana Mora"], ["N", 200, false, null]]);
  assert(!JSON.stringify(s).includes("1300"), "settlement never stores the client price");
  assertEquals(providerIdsOf([{ providerId: "A" }, { providerId: "A" }, { providerId: null }, {}]), ["A"]);
});

Deno.test("onQuoteAccepted: opens the settlement once and audits", async () => {
  await useFakeEnv();
  const world = installFakeWorld("2026-10-21T15:00:00.000Z");
  try {
    world.put("clients", "c1", { email: "m@mailbox-e2e.io", assignedProviderId: "A", quotes: [QUOTE] });
    world.put("providers", "A", { name: "Ana Mora" });
    await onQuoteAccepted("c1", { ...QUOTE, status: "accepted" }, { email: "m@mailbox-e2e.io", role: "client" });
    // Staff already recorded a payout; a second acceptance event must not reset it.
    const s = world.doc("quoteSettlements", "q1")!;
    world.put("quoteSettlements", "q1", { ...s, providerPayments: [{ ...s.providerPayments[0], paid: true }] });
    await onQuoteAccepted("c1", { ...QUOTE, status: "accepted" }, { email: "m@mailbox-e2e.io", role: "client" });
    assertEquals(world.all("quoteSettlements").length, 1);
    assertEquals(world.doc("quoteSettlements", "q1")!.providerPayments[0].paid, true);
    assertEquals(world.all("audit_log").filter((a) => a.action === "quote.accepted").length, 2);
  } finally {
    world.restore();
  }
});
