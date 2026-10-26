import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import {
  accessPausedEmail,
  callBookedLawyerEmail,
  callBookedMemberEmail,
  callReminderEmail,
  complianceAlertEmail,
  EMAIL_FOOTER,
  memberEmailLayout,
  paymentFailedEmail,
} from "../helper/emailTemplates.ts";

/** P7: every member email carries the legal footer (P6 wording); lawyer-only emails do not. Run: deno test test/emailFooter_test.ts */

const FOOT = "not a law firm";

Deno.test("footer: member layout (html and text), dunning and paused emails", () => {
  const m = memberEmailLayout({ subject: "x", paragraphs: ["Hello there"] });
  assert(m.html.includes(FOOT) && m.text.includes(EMAIL_FOOTER));
  const withUnsub = memberEmailLayout({ subject: "x", paragraphs: ["a"], unsubscribeUrl: "https://api/x" });
  assert(withUnsub.html.indexOf(FOOT) < withUnsub.html.indexOf("Stop reminder emails"), "footer before the unsubscribe line");
  for (const e of [
    paymentFailedEmail({ day: 3, pausesOn: "November 2", moneyUrl: "https://s/status/money", byCard: true }),
    accessPausedEmail({ moneyUrl: "https://s/status/money", byCard: false }),
  ]) assert(e.html.includes(FOOT) && e.text.includes(EMAIL_FOOTER), e.subject);
});

Deno.test("footer: member call emails yes, lawyer-only call emails no", () => {
  assert(callBookedMemberEmail({ firstName: "Robert", lawyerName: "Ana Mora", whenLabel: "Mon 10:00", portalUrl: "https://s/status" }).html.includes(FOOT));
  assert(callReminderEmail({ to: "member", kind: "24h", greetingName: "Robert", otherName: "Ana Mora", whenLabel: "Mon 10:00" }).html.includes(FOOT));
  assertEquals(callBookedLawyerEmail({ lawyerName: "Ana", memberName: "Robert Hayes", whenLabel: "Mon", briefUrl: "https://s/lawyer" }).html.includes(FOOT), false);
  assertEquals(callReminderEmail({ to: "lawyer", kind: "1h", greetingName: "Ana", otherName: "Robert", whenLabel: "Mon" }).html.includes(FOOT), false);
  assert(complianceAlertEmail({ firstName: "Robert", obligationTitle: "Corporation tax", deadlineLabel: "Jan 31", responseUrl: "https://s" }).includes(FOOT));
});
