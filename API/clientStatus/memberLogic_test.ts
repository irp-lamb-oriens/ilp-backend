/**
 * memberLogic_test.ts — W4 member home rules.
 * Run: deno test API/clientStatus/memberLogic_test.ts
 * (No std imports, so it also runs under node with a `Deno.test` shim.)
 */
import {
  bookingCapacity,
  generateSlots,
  mergeThread,
  moneyView,
  nextStepFor,
  normalizeQuote,
} from "./memberLogic.ts";
import type { Handoff, Matter } from "../../schemas/contracts.ts";

function eq(a: unknown, b: unknown, msg = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg} expected ${y}, got ${x}`);
}
function ok(v: unknown, msg = "") {
  if (!v) throw new Error(`assertion failed ${msg}`);
}

const active = { status: "active" as const, minutesIncluded: 60, minutesUsed: 0, callsIncluded: 3, callsUsed: 0, periodEnd: "2026-11-20T06:00:00.000Z" };

Deno.test("capacity: fresh member can book, a booked call reserves 20 minutes", () => {
  const c = bookingCapacity(active, [{ status: "booked", durationMin: 20 }]);
  eq([c.minutesLeft, c.minutesAvailable, c.callsAvailable, c.canBook], [60, 40, 2, true]);
});

Deno.test("capacity: completed call charged → 40 left (demo step 7)", () => {
  const c = bookingCapacity({ ...active, minutesUsed: 20, callsUsed: 1 }, [{ status: "completed", durationMin: 20 }]);
  eq([c.minutesLeft, c.callsLeft, c.minutesBooked], [40, 2, 0]);
});

Deno.test("capacity: blocks when calls are exhausted, with a reason", () => {
  const c = bookingCapacity({ ...active, minutesUsed: 40, callsUsed: 2 }, [{ status: "booked", durationMin: 20 }]);
  eq(c.canBook, false);
  ok(c.reason?.includes("3 calls"), c.reason);
});

Deno.test("capacity: blocks when fewer than 20 minutes remain", () => {
  const c = bookingCapacity({ ...active, minutesUsed: 45, callsUsed: 1 }, []);
  eq(c.canBook, false);
  ok(c.reason?.includes("15 minutes"), c.reason);
});

Deno.test("capacity: past_due and missing membership cannot book", () => {
  eq(bookingCapacity({ ...active, status: "past_due" }, []).canBook, false);
  eq(bookingCapacity(null, []).canBook, false);
});

Deno.test("slots: weekdays only, CR business hours, 20 minutes apart, taken removed", () => {
  // Friday 2026-10-30 10:00 CR = 16:00Z
  const now = new Date("2026-10-30T16:00:00.000Z");
  const all = generateSlots({ now, days: 2 });
  ok(all.length > 0);
  for (const s of all) {
    const d = new Date(s);
    const crHour = (d.getUTCHours() + 24 - 6) % 24;
    ok(crHour >= 8 && crHour < 17 && crHour !== 12, s);
    const dow = new Date(d.getTime() - 6 * 3600_000).getUTCDay();
    ok(dow !== 0 && dow !== 6, `weekend ${s}`);
    ok(d.getTime() >= now.getTime() + 18 * 3600_000, `lead ${s}`);
  }
  eq(new Date(all[1]).getTime() - new Date(all[0]).getTime(), 20 * 60_000);
  const without = generateSlots({ now, days: 2, taken: [all[0]] });
  eq(without[0], all[1]);
});

const matter = { id: "m1", clientId: "c", title: "T", area: "corporate", country: "CR", stage: "legal_review", stageEnteredAt: "2026-10-20T00:00:00Z", openedAt: "2026-10-01T00:00:00Z", nextStep: { what: "Send the S.A. books", who: "client", dueAt: "2026-10-31T00:00:00Z" } } as Matter;

Deno.test("next step: the matter's own step when no newer handoff", () => {
  const n = nextStepFor(matter, []);
  eq([n?.what, n?.source], ["Send the S.A. books", "matter"]);
});

Deno.test("next step: a newer handoff wins, client action first (demo step 7)", () => {
  const h = { id: "h", consultationId: "x", clientId: "c", matterId: "m1", providerId: "p", approvedAt: "2026-10-26T15:00:00Z", csmTaskIds: [],
    legalNextSteps: [{ what: "Lawyer files RTBF", who: "lawyer", dueAt: "2026-11-05" }, { what: "Upload the corporate ID", who: "client", dueAt: "2026-11-02" }] } as Handoff;
  const n = nextStepFor(matter, [h]);
  eq([n?.what, n?.source, n?.more.length], ["Upload the corporate ID", "handoff", 1]);
});

Deno.test("money: balance first, legacy dollar charges and minor-unit charges both read", () => {
  const v = moneyView({
    charges: [
      { id: "a", label: "Activation", amountMinor: 10000, status: "paid", createdAt: "2026-10-01" },
      { id: "b", label: "Month 2", amountMinor: 7999, status: "pending", createdAt: "2026-10-25" },
      { label: "Old style", total: 120.5, payments: [{ amount: 20.5 }] },
    ],
    quotes: [],
  });
  eq(v.balanceDueCents, 7999 + 10000);
});

Deno.test("quotes: no per-line amounts or margins, plain scope only", () => {
  const q = normalizeQuote({ id: "q", title: "S.A. clean-up", status: "sent", totalMinor: 145000, costSubtotal: 900, lines: [{ label: "Overdue filings", amountMinor: 45000, marginPct: 30 }] });
  eq(q?.scope, ["Overdue filings"]);
  eq(q?.status, "awaiting");
  const s = JSON.stringify(q);
  ok(!s.includes("marginPct") && !s.includes("costSubtotal") && !s.includes("amountMinor"), s);
  eq(normalizeQuote({ id: "d", status: "draft" }), null);
});

Deno.test("messages: team, member and AI merged in time order", () => {
  const items = mergeThread({
    statusComments: [{ id: "1", author: "mariela.solis@internationallegalpartner.com", authorType: "staff", body: "Hi", createdAt: "2026-10-02" }],
    statusChatThread: [{ role: "user", content: "Q", createdAt: "2026-10-01" }, { role: "assistant", content: "A", createdAt: "2026-10-01T00:00:01Z" }],
  }, "Robert Hayes");
  eq(items.map((i) => i.kind), ["member", "ai", "team"]);
  eq(items[2].author, "Mariela Solis (ILP team)");
  eq(items[1].author, "AI assistant");
});
