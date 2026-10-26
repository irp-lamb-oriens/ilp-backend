import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import {
  findHiddenKeys,
  mergeLawyerLineItems,
  PROVIDER_HIDDEN_FIELDS,
  stripProviderResponses,
  toLawyerPayload,
} from "./lawyerView.ts";
import { LAWYER_HIDDEN_FIELDS } from "../../schemas/contracts.ts";

/**
 * W5: no hidden field (LAWYER_HIDDEN_FIELDS + margin inputs) may reach a
 * lawyer. Pure: no Firestore, no network.
 *
 * Run: deno test --allow-env API/provider/lawyerView_test.ts
 */

const quote = {
  quoteId: "q1",
  clientId: "c1",
  title: "S.A. clean-up",
  currency: "USD",
  total: 1740,
  costSubtotal: 1450,
  earnings: 290,
  defaultMarginPct: 20,
  lineItems: [
    { lineId: "l1", label: "Overdue corporation tax x2", amount: 650, marginPct: 20, marginMode: "pct", marginFlat: null, providerId: "p1" },
    { lineId: "l2", label: "Book legalisation", amount: 800, marginPct: 20, marginMode: "flat", marginFlat: 160, providerId: null },
    { lineId: "l3", label: "Notary (other provider)", amount: 300, marginPct: 10, marginMode: "pct", marginFlat: null, providerId: "p2" },
  ],
  lineGroups: [{ groupId: "g1", title: "Services", lineItems: [{ lineId: "l1", amount: 650, marginPct: 20 }] }],
};

// One fixture per provider response shape that can carry commercial data.
const payloads: Record<string, unknown> = {
  "GET /api/provider/clients": {
    clients: [{ id: "c1", name: "Dana", rankIndex: 3, quotes: [quote], charges: [{ amount: 100, margin: 12 }] }],
    total: 1,
  },
  "GET /api/provider/clients/:id/quotes": { quotes: [quote] },
  "GET /api/provider/clients/:id (seed quote shape)": {
    quotes: [{ id: "demo_quote_alvarez_1", title: "S.A. clean-up", lines: [{ label: "Tax", amountMinor: 45000 }], totalMinor: 145000, status: "sent" }],
  },
  "GET /api/provider/clients/:id/quotes/:quoteId": quote,
  "POST /api/provider/clients/:id/quotes": { success: true, quote },
  "GET /api/lawyer/handoffs": {
    items: [{ id: "h1", legalNextSteps: [{ what: "Send books", who: "client" }], commercialNotes: "Upsell S.A. clean-up", platformFee: 5 }],
  },
  "GET /api/provider/finance": {
    totals: { paid: 1800, pending: 2500 },
    payments: [{ amount: 1800, paid: true, platformFee: 180, margin: 0.1 }],
  },
};

for (const [route, body] of Object.entries(payloads)) {
  Deno.test(`${route}: no hidden field after toLawyerPayload`, () => {
    assert(findHiddenKeys(body).length > 0, "fixture should contain hidden fields");
    const out = toLawyerPayload(body, "p1");
    assertEquals(findHiddenKeys(out), []);
    const json = JSON.stringify(out);
    for (const k of LAWYER_HIDDEN_FIELDS) assert(!json.includes(`"${k}"`), `${k} leaked in ${route}`);
  });
}

Deno.test("every contract LAWYER_HIDDEN_FIELD is in the provider list", () => {
  for (const k of LAWYER_HIDDEN_FIELDS) assert(PROVIDER_HIDDEN_FIELDS.includes(k));
});

Deno.test("quotes lose the client price and show the lawyer's own fee", () => {
  const out = toLawyerPayload(quote, "p1") as Record<string, unknown>;
  assertEquals(out.total, undefined);
  assertEquals(out.yourFee, 1450); // l1 (own) + l2 (unassigned); l3 belongs to p2
  assertEquals((out.lineItems as Array<Record<string, unknown>>)[0].amount, 650);
});

Deno.test("seed-shape quotes get yourFee from lines", () => {
  const q = { id: "x", title: "t", status: "sent", totalMinor: 99000, lines: [{ label: "a", amountMinor: 45000 }, { label: "b", amountMinor: 100000 }] };
  const out = toLawyerPayload(q) as Record<string, unknown>;
  assertEquals(out.totalMinor, undefined);
  assertEquals(out.yourFee, 1450);
});

Deno.test("middleware filters res.json for every route", () => {
  let sent: unknown = null;
  const res = { json: (b: unknown) => { sent = b; return res; } } as unknown as Parameters<typeof stripProviderResponses>[1];
  const req = { providerId: "p1" } as unknown as Parameters<typeof stripProviderResponses>[0];
  let called = false;
  stripProviderResponses(req, res, () => { called = true; });
  assert(called);
  (res as unknown as { json: (b: unknown) => void }).json(payloads["GET /api/provider/clients/:id/quotes"]);
  assertEquals(findHiddenKeys(sent), []);
});

Deno.test("lawyer line edits keep stored margins and cannot set new ones", () => {
  const merged = mergeLawyerLineItems(
    [
      { lineId: "l1", label: "Corp tax", amount: 700, marginPct: 0, marginMode: "flat", marginFlat: 0 },
      { lineId: "new", label: "Shareholder update", amount: 200, marginPct: 0 },
    ],
    quote.lineItems,
    20,
  );
  assertEquals(merged[0].amount, 700);
  assertEquals(merged[0].marginPct, 20);
  assertEquals(merged[0].marginMode, "pct");
  assertEquals(merged[1].marginPct, 20);
  assertEquals(merged[1].marginFlat, null);
});
