import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { isMonthKey, parseScore, pendingRating } from "../API/retention/feedback.ts";
import type { Consultation } from "../schemas/contracts.ts";

/** P2 feedback: pure parts. Run: deno test --allow-env test/feedback_test.ts */

const NOW = new Date("2026-10-26T14:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * 86400_000).toISOString();
const con = (id: string, over: Partial<Consultation>): Consultation => ({
  id, clientId: "c1", providerId: "p1", scheduledAt: ago(1), durationMin: 20, status: "completed",
  consent: { recording: "granted" }, createdAt: ago(10), ...over,
});

Deno.test("pending rating: latest completed unrated call within 30 days", () => {
  const list = [
    con("old", { endedAt: ago(40) }),
    con("rated", { endedAt: ago(1), rating: { score: 5, at: ago(1) } }),
    con("a", { endedAt: ago(3) }),
    con("b", { endedAt: ago(2) }),
    con("booked", { status: "booked", scheduledAt: ago(-1) }),
  ];
  assertEquals(pendingRating(list, NOW)?.id, "b");
  assertEquals(pendingRating([list[0], list[1]], NOW), null);
});

Deno.test("scores are integers inside the scale", () => {
  assertEquals(parseScore(3, 1, 5), 3);
  assertEquals(parseScore("10", 0, 10), 10);
  assertEquals(parseScore(0, 1, 5), null);
  assertEquals(parseScore(4.5, 1, 5), null);
  assertEquals(parseScore("x", 0, 10), null);
});

Deno.test("month keys", () => {
  assertEquals(isMonthKey("2026-11"), true);
  assertEquals(isMonthKey("2026-13"), false);
  assertEquals(isMonthKey("../x"), false);
});
