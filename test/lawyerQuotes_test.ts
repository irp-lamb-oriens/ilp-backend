import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { installFakeWorld, useFakeEnv } from "./e2e/fakeWorld.ts";
import { FakeApp } from "./e2e/fakeApp.ts";
import { quotePhase } from "../schemas/quoteStatus.ts";

/**
 * REL: a lawyer quotes their fee and nothing else. Their quote starts as a
 * draft, carries their id on every line, cannot change status (no
 * self-approval, no fake acceptance), is locked once submitted, cannot be
 * sent to the member by them, and a copy of an accepted quote is a draft.
 * Run: deno test --allow-env test/lawyerQuotes_test.ts
 */

Deno.test("lawyer quotes: draft only, own lines, no status moves, locked after submit, staff send", async () => {
  await useFakeEnv();
  const world = installFakeWorld("2026-10-21T15:00:00.000Z");
  try {
    const app = new FakeApp();
    (await import("../API/provider/providerDashboardRouter.ts")).default(app as never);
    (await import("../API/provider/providerQuotesRouter.ts")).default(app as never);
    world.put("providers", "A", { name: "Ana", email: "ana@mora-legal.io", status: "active", active: true });
    world.put("provider_sessions", "tokA", { email: "ana@mora-legal.io", providerId: "A", expiresAt: "2030-01-01T00:00:00Z" });
    world.put("clients", "c1", { email: "m@mailbox-e2e.io", assignedProviderId: "A", quotes: [] });
    const h = { authorization: "Bearer tokA" };
    const base = "/api/provider/clients/c1/quotes";
    const quote = (id: string) => (world.doc("clients", "c1")!.quotes as Array<Record<string, any>>).find((q) => q.quoteId === id)!;

    const created = await app.call("POST", base, { headers: h, body: { title: "Will", status: "sent_to_client", providerIds: ["X"], lineItems: [{ label: "Draft the will", amount: 400, providerId: "X", marginPct: 0 }] } });
    assertEquals(created.status, 201, JSON.stringify(created.body));
    const id = created.body.quote.quoteId;
    assertEquals(quote(id).status, "draft");
    assertEquals(quote(id).providerIds, ["A", "X"]);
    assertEquals(quote(id).lineItems[0].providerId, "A");
    assertEquals(quote(id).lineItems[0].marginPct, 20, "margin is never taken from the lawyer");
    assert(!("total" in created.body.quote) && !("costSubtotal" in created.body.quote), "lawyer response hides price and cost");

    for (const status of ["approved", "sent_to_client", "client_accepted"]) {
      const r = await app.call("PATCH", `${base}/${id}`, { headers: h, body: { status } });
      assertEquals(r.status, 400, status);
    }
    assertEquals(quote(id).status, "draft");
    assertEquals((await app.call("PATCH", `${base}/${id}`, { headers: h, body: { title: "Will and testament" } })).status, 200);
    assertEquals((await app.call("POST", `${base}/${id}/submit-for-approval`, { headers: h, body: {} })).status, 200);
    assertEquals((await app.call("PATCH", `${base}/${id}`, { headers: h, body: { lineItems: [{ label: "x", amount: 9000 }] } })).status, 409);
    assertEquals((await app.call("DELETE", `${base}/${id}`, { headers: h })).status, 409);
    assertEquals((await app.call("POST", `${base}/${id}/send-to-client`, { headers: h, body: {} })).status, 403);
    assertEquals(quote(id).status, "pending_approval");

    // A copy of a quote the member accepted (member-flow spelling) is a fresh draft.
    world.put("clients", "c1", { ...world.doc("clients", "c1"), quotes: [{ ...quote(id), status: "accepted", acceptedAt: "2026-10-22T00:00:00Z", typedFullName: "M" }] });
    const dup = await app.call("POST", `${base}/${id}/duplicate`, { headers: h, body: {} });
    assertEquals(dup.status, 201);
    assertEquals(quotePhase(quote(dup.body.quote.quoteId)), "draft");
  } finally {
    world.restore();
  }
});

Deno.test("toLawyerPayload: charges, payments and acceptance (client price) never reach a lawyer", async () => {
  const { findHiddenKeys, toLawyerPayload } = await import("../API/provider/lawyerView.ts");
  const client = {
    id: "c1",
    charges: [{ id: "ch_quote_q1", amountMinor: 130000 }],
    quoteAcceptance: { quoteId: "q1", total: 1300 },
    settlement: { clientPayments: [{ amount: 1300 }], extraCharges: [], providerPayments: [{ providerId: "A", amount: 1000 }] },
  };
  const out = toLawyerPayload(client, "A");
  assertEquals(findHiddenKeys(out), []);
  assert(!JSON.stringify(out).includes("1300"), JSON.stringify(out));
  assertEquals((out as Record<string, any>).settlement.providerPayments, [{ providerId: "A", amount: 1000 }], "their own payout stays");
});
