import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { dunningStage } from "../API/retention/lifecycleEmails.ts";
import { queueKey } from "../API/retention/mailer.ts";
import {
  accessPausedEmail,
  cancellationConfirmedEmail,
  memberEmailLayout,
  paymentFailedEmail,
  renewalReceiptEmail,
} from "../helper/emailTemplates.ts";

/** P2 lifecycle emails: stage math + templates. Run: deno test --allow-env test/lifecycleEmails_test.ts */

Deno.test("dunning stages: 0, 3, 6, then paused at 7", () => {
  assertEquals([-1, 0, 2, 3, 5, 6, 7, 12].map(dunningStage), [null, 0, 0, 3, 3, 6, 7, 7]);
  assertEquals(dunningStage(null), null);
});

Deno.test("queue keys are safe Firestore ids", () => {
  assertEquals(queueKey("dunning_mem_1_2026-10-26_d3"), "dunning_mem_1_2026-10-26_d3");
  assertEquals(queueKey("a/b c"), "a_b_c");
});

Deno.test("every lifecycle email links to /status/money and has no fear words", () => {
  const url = "https://ilp.example/status/money";
  const mails = [
    paymentFailedEmail({ firstName: "Robert", day: 0, pausesOn: "November 2, 2026", moneyUrl: url, byCard: true }),
    paymentFailedEmail({ firstName: "Robert", day: 3, pausesOn: "November 2, 2026", moneyUrl: url, byCard: false }),
    paymentFailedEmail({ firstName: "Robert", day: 6, pausesOn: "November 2, 2026", moneyUrl: url, byCard: true }),
    accessPausedEmail({ firstName: "Robert", moneyUrl: url, byCard: true }),
    cancellationConfirmedEmail({ firstName: "Robert", endsOn: "November 26, 2026", moneyUrl: url }),
    renewalReceiptEmail({ firstName: "Robert", amountLabel: "US$79.99", periodLabel: "Oct 26 to Nov 26", minutes: 60, calls: 3, moneyUrl: url, bookUrl: "x" }),
  ];
  for (const m of mails) {
    assertEquals(m.html.includes(url) && m.text.includes(url), true, m.subject);
    assertEquals(/urgent|immediately|penalt|risk|act now|!/i.test(m.subject + m.text), false, m.subject);
  }
});

Deno.test("layout escapes member-provided names", () => {
  const m = memberEmailLayout({ subject: "s", firstName: "<b>x</b>", paragraphs: ["a & b"] });
  assertEquals(m.html.includes("<b>x</b>"), false);
  assertEquals(m.html.includes("a &amp; b"), true);
});

Deno.test("unsubscribe link only when given", () => {
  assertEquals(memberEmailLayout({ subject: "s", paragraphs: [] }).html.includes("Stop reminder"), false);
  assertEquals(memberEmailLayout({ subject: "s", paragraphs: [], unsubscribeUrl: "u" }).text.includes("Stop reminder emails: u"), true);
});
