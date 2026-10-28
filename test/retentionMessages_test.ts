import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { checkInMonth, crDaysUntil, nudgeDue, obligationStage, stepFingerprint } from "../API/retention/retentionMessages.ts";
import { monthlyCheckInEmail, obligationsDueEmail } from "../helper/emailTemplates.ts";

/** P2 retention messages: pure rules. Run: deno test --allow-env test/retentionMessages_test.ts */

// 08:00 Costa Rica = 14:00 UTC.
const NOW = new Date("2026-10-26T14:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400_000).toISOString();

Deno.test("CR calendar days, not UTC", () => {
  // 2026-10-27T03:00Z is still Oct 26 in Costa Rica.
  assertEquals(crDaysUntil("2026-10-27T03:00:00Z", NOW), 0);
  assertEquals(crDaysUntil("2026-11-25T18:00:00Z", NOW), 30);
});

Deno.test("obligation reminders at 30 and 7 days, once each", () => {
  assertEquals(obligationStage(31), null);
  assertEquals(obligationStage(30), "30");
  assertEquals(obligationStage(12, ["30"]), null);
  assertEquals(obligationStage(7, ["30"]), "7");
  assertEquals(obligationStage(3, []), "7");
  assertEquals(obligationStage(5, ["30", "7"]), null);
  assertEquals(obligationStage(-1), null);
});

Deno.test("check-in on the monthly anniversary, clamped to month end", () => {
  assertEquals(checkInMonth("2026-09-26T15:00:00Z", NOW), "2026-10");
  assertEquals(checkInMonth("2026-09-27T15:00:00Z", NOW), null); // tomorrow
  assertEquals(checkInMonth("2026-10-10T15:00:00Z", NOW), null); // joined < 25 days ago
  assertEquals(checkInMonth("2026-01-31T15:00:00Z", new Date("2026-02-28T14:00:00Z")), "2026-02");
  assertEquals(checkInMonth(undefined, NOW), null);
});

Deno.test("booking nudge 5 days after joining with no call", () => {
  assertEquals(nudgeDue(daysAgo(5), 0, NOW), true);
  assertEquals(nudgeDue(daysAgo(4), 0, NOW), false);
  assertEquals(nudgeDue(daysAgo(6), 1, NOW), false);
  assertEquals(nudgeDue(daysAgo(20), 0, NOW), false);
});

Deno.test("next-step fingerprint changes with the step", () => {
  const a = stepFingerprint({ what: "Send the S.A. minutes", who: "client", dueAt: "2026-11-02T00:00:00Z" });
  assertEquals(a, stepFingerprint({ what: "Send the S.A. minutes ", who: "client", dueAt: "2026-11-02T18:00:00Z" }));
  assertEquals(a === stepFingerprint({ what: "Send the S.A. minutes", who: "lawyer" }), false);
  assertEquals(stepFingerprint(null), "");
});

Deno.test("retention emails carry the unsubscribe link and calm wording", () => {
  const o = obligationsDueEmail({ firstName: "Linda", items: [{ title: "Corporation tax may require review", dueLabel: "January 31, 2027", daysLeft: 7 }], askUrl: "a", unsubscribeUrl: "U" });
  const c = monthlyCheckInEmail({ firstName: "Linda", minutesLeft: 40, minutesIncluded: 60, callsLeft: 2, renewsOn: "Nov 26", bookUrl: "b", scoreUrl: (n) => `s?score=${n}`, feedbackUrl: "f", unsubscribeUrl: "U" });
  for (const m of [o, c]) {
    assertEquals(m.text.includes("Stop reminder emails: U"), true);
    assertEquals(/urgent|penalt|fine[sd]?\b|!/i.test(m.subject + m.text), false, m.subject);
  }
  assertEquals(o.text.includes("may require review"), true);
  assertEquals(c.html.includes("s?score=0") && c.html.includes("s?score=10"), true);
});

Deno.test("obligations email: a low-confidence date asks the lawyer to confirm instead of showing the date", () => {
  const o = obligationsDueEmail({
    firstName: "Linda",
    items: [{ title: "Maritime zone concession fee (canon) may require review", dueLabel: "December 1, 2026", daysLeft: 7, confirm: true }],
    askUrl: "a",
    unsubscribeUrl: "U",
  });
  assertEquals(o.text.includes("Ask your lawyer to confirm this date."), true);
  assertEquals(o.text.includes("December 1, 2026"), false);
});
