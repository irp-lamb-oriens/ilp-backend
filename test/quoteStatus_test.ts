import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { isQuoteAccepted, isQuoteAwaitingClient, quoteKey, quotePhase } from "../schemas/quoteStatus.ts";
import { moneyView } from "../API/clientStatus/memberLogic.ts";
import { isQuoteAccepted as staffAccepted, isQuoteOpen } from "../API/dashboard/staffHome/compute.ts";
import { unansweredQuoteEvents } from "../jobs/taskRuleSweep.ts";

/**
 * One quote-status reading for every view (schemas/quoteStatus.ts): the staff
 * spelling (sent_to_client / client_accepted) and the member spelling
 * (sent / accepted) mean the same thing everywhere.
 * Run: deno test --allow-env --allow-read test/quoteStatus_test.ts
 */

Deno.test("both spellings map to the same phase; timestamps win", () => {
  assertEquals(quotePhase({ status: "sent_to_client" }), "awaiting_client");
  assertEquals(quotePhase({ status: "sent" }), "awaiting_client");
  assertEquals(quotePhase({ status: "client_accepted" }), "accepted");
  assertEquals(quotePhase({ status: "accepted" }), "accepted");
  assertEquals(quotePhase({ status: "sent_to_client", clientAcceptedAt: "2026-10-01T00:00:00Z" }), "accepted");
  assertEquals(quotePhase({ status: "rejected" }), "declined");
  assertEquals(quotePhase({ status: "pending_approval" }), "internal_review");
  assertEquals(quotePhase({ status: "draft" }), "draft");
  assertEquals(quotePhase({ status: "weird" }), null);
  assertEquals(quoteKey({ quoteId: "q1", id: "x" }), "q1");
  assertEquals(quoteKey({ id: "x" }), "x");
});

Deno.test("a quote staff sent (sent_to_client, quoteId only) appears in the member Money view", () => {
  const v = moneyView({
    quotes: [
      { quoteId: "q_staff", title: "S.A. clean-up", status: "sent_to_client", total: 1450, createdAt: "2026-10-20T00:00:00Z" },
      { quoteId: "q_won", title: "Will", status: "client_accepted", clientAcceptedAt: "2026-10-10T00:00:00Z", total: 800 },
      { id: "q_member", title: "Legacy", status: "accepted", acceptedAt: "2026-09-01T00:00:00Z", totalMinor: 30000 },
      { quoteId: "q_draft", title: "Internal", status: "pending_approval", total: 999 },
    ],
  });
  assertEquals(v.quotes.map((q) => [q.id, q.status, q.totalCents]), [
    ["q_staff", "awaiting", 145000],
    ["q_won", "accepted", 80000],
    ["q_member", "accepted", 30000],
  ]);
  assertEquals(v.quotes[1].acceptedAt, "2026-10-10T00:00:00Z");
});

Deno.test("staff KPIs, sweep and member flow agree on both spellings", () => {
  for (const s of ["sent", "sent_to_client"]) {
    assertEquals(isQuoteOpen({ status: s }), true, s);
    assertEquals(isQuoteAwaitingClient({ status: s }), true, s);
  }
  for (const q of [{ status: "accepted" }, { status: "client_accepted" }, { status: "sent", acceptedAt: "2026-10-01" }]) {
    assertEquals(staffAccepted(q), true);
    assertEquals(isQuoteAccepted(q), true);
  }
  const now = new Date("2026-10-27T12:00:00Z");
  const events = unansweredQuoteEvents([{
    id: "c1",
    quotes: [
      { quoteId: "a", status: "sent_to_client", sentToClientAt: "2026-10-10T00:00:00Z", title: "A" },
      { id: "b", status: "sent", sentAt: "2026-10-12T00:00:00Z", title: "B" },
      { quoteId: "c", status: "client_accepted", sentToClientAt: "2026-10-01T00:00:00Z" },
      { quoteId: "d", status: "sent_to_client", sentToClientAt: "2026-10-26T00:00:00Z" },
    ],
  }], now);
  assertEquals(events.map(([, p]) => p.sourceId), ["a", "b"]);
});

Deno.test("server and frontend copies of quoteStatus.ts are byte-identical", async () => {
  const server = await Deno.readTextFile(new URL("../schemas/quoteStatus.ts", import.meta.url));
  const front = await Deno.readTextFile(new URL("../../frontend/src/lib/quoteStatus.ts", import.meta.url)).catch(() => null);
  if (front !== null) assertEquals(front, server);
});
