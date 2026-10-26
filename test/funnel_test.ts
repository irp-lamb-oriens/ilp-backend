import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { parseFunnelEvent, summarize } from "../API/analytics/funnel.ts";
import type { FunnelEvent, MemberFeedback } from "../schemas/contracts.ts";

/** P2 funnel + PMF summary: pure parts. Run: deno test --allow-env test/funnel_test.ts */

const NOW = new Date("2026-10-26T14:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * 86400_000).toISOString();

Deno.test("funnel beacons: known steps only, no server-only step, ids and sources cleaned", () => {
  const ok = parseFunnelEvent({ step: "check_started", anonId: "a1b2c3d4e5", source: "Facebook.com", email: "x@y.z" }, NOW);
  assertEquals(ok, { id: "check_started_a1b2c3d4e5", step: "check_started", anonId: "a1b2c3d4e5", at: NOW.toISOString(), source: "facebook.com" });
  assertEquals("error" in parseFunnelEvent({ step: "first_call_booked", anonId: "a1b2c3d4e5" }), true);
  assertEquals("error" in parseFunnelEvent({ step: "nope", anonId: "a1b2c3d4e5" }), true);
  assertEquals("error" in parseFunnelEvent({ step: "join_paid", anonId: "../../x" }), true);
  const bad = parseFunnelEvent({ step: "join_paid", anonId: "a1b2c3d4e5", source: "<script>", leadId: "lead_1" }, NOW) as FunnelEvent;
  assertEquals([bad.source, bad.leadId], [undefined, "lead_1"]);
});

const ev = (step: FunnelEvent["step"], n: number, at = ago(2), source?: string): FunnelEvent[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${step}_${i}`, step, anonId: `anon${i}xxxx`, at, ...(source ? { source } : {}) }));

Deno.test("summary: counts, step conversion and window", () => {
  const events = [
    ...ev("check_started", 40, ago(2), "google"), ...ev("check_completed", 30), ...ev("check_email_given", 12),
    ...ev("join_started", 6), ...ev("join_paid", 3, ago(2), "google"), ...ev("first_call_booked", 2),
    ...ev("check_started", 9, ago(45)),
  ];
  const s = summarize(events, [], NOW, 30);
  assertEquals(s.funnel.map((f) => f.count), [40, 30, 12, 6, 3, 2]);
  assertEquals(s.funnel[0].fromPrevious, null);
  assertEquals(s.funnel[1].fromPrevious, 0.75);
  assertEquals(s.sources[0], { source: "google", checks: 40, paid: 3 });
});

Deno.test("summary: post-call average, NPS and cancel reasons", () => {
  const fb = (kind: MemberFeedback["kind"], score: number | undefined, comment?: string): MemberFeedback =>
    ({ id: Math.random().toString(), clientId: "c", kind, score, comment, at: ago(1) });
  const s = summarize([], [
    fb("post_call", 5), fb("post_call", 4), fb("post_call", 2),
    fb("monthly", 10), fb("monthly", 9), fb("monthly", 8), fb("monthly", 3),
    fb("cancel", undefined, "I am leaving Costa Rica — moving to Lisbon"), fb("cancel", undefined, "I am leaving Costa Rica"),
  ], NOW, 30);
  assertEquals([s.postCall.count, s.postCall.low, Number(s.postCall.average!.toFixed(2))], [3, 1, 3.67]);
  assertEquals([s.nps.promoters, s.nps.passives, s.nps.detractors, s.nps.score], [2, 1, 1, 25]);
  assertEquals(s.cancels.reasons, [{ reason: "I am leaving Costa Rica", count: 2 }]);
});
