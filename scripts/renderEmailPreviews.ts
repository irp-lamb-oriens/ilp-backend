/**
 * scripts/renderEmailPreviews.ts (COMMS-P5)
 * ──────────────────────────────────────────────────────────────────────────
 * Renders every email the server can send to static HTML files for owner
 * review, using the real template functions (so a preview matches what goes
 * out), with fictional people and @example.com addresses. Nothing is queued
 * or sent and no database is read.
 *
 *   deno run --allow-env --allow-read --allow-write scripts/renderEmailPreviews.ts
 *   deno run --allow-env --allow-read --allow-write scripts/renderEmailPreviews.ts --out=/tmp/previews
 *
 * Default output: ../docs/email-previews/ (one file per email + index.html).
 * `renderAll()` is pure and is also used by test/commsP5_test.ts.
 */

import {
  accessPausedEmail,
  bookingNudgeEmail,
  callBookedMemberEmail,
  callChangedEmail,
  callReminderEmail,
  cancellationConfirmedEmail,
  complianceAlertEmail,
  consultationConfirmationEmail,
  escalationEmail,
  handoffNextStepsEmail,
  monthlyCheckInEmail,
  nextStepChangedEmail,
  obligationsDueEmail,
  paymentFailedEmail,
  renewalReceiptEmail,
  signInCodeEmail,
  signInLockoutEmail,
  withLegalFooter,
} from "../helper/emailTemplates.ts";
import { joinConfirmation, renewalNotice } from "../API/retention/lifecycleEmails.ts";
import {
  cancelUndoneEmail,
  invoicePaidEmail,
  lawyerAssignedMemberEmail,
  manualPaymentEmail,
  membershipEndedEmail,
  missingDocumentEmail,
  noShowMemberEmail,
  profileReadyEmail,
  quoteReminderEmail,
  ratingRequestEmail,
} from "../API/retention/closingEmails.ts";
import {
  coachingEmail,
  licenceExpiringEmail,
  memberAssignedEmail,
  membershipEndedLawyerEmail,
  monthlyFeedbackEmail,
  noShowLawyerEmail,
  payoutEmail,
  profileIncompleteEmail,
  quoteAcceptedLawyerEmail,
  quoteDecisionEmail,
  summaryReadyEmail,
  weeklyDigestEmail,
  workOfferEmail,
} from "../API/lawyerComms/emails.ts";
import {
  arrangingLawyerEmail,
  lawyerAssignedEmail,
  type PreCallBrief,
  preCallLawyerEmail,
  salesCallEmail,
  staffNotificationEmail,
} from "../API/routing/emails.ts";
import { csmAlertEmail, csmDigestEmail } from "../API/csm/emails.ts";
import { DEFAULT_PLAYBOOKS, renderPlaybookEmail } from "../API/csm/playbooks.ts";
import { lawyerApplyEmails } from "../API/providers/applyEmails.ts";
import { legalEmailTypes, renderLegalEmail } from "../API/dashboard/automation/renderLegalEmail.ts";
import { invoiceMail } from "../API/finance/invoicesRouter.ts";
import { findingsEmailHtml } from "../API/leads/leadsRouter.ts";
import type { CheckFinding } from "../API/leads/deadlineCheck.ts";
import { privacyDecisionEmail, privacyErasedEmail, privacyReceivedEmail } from "../API/privacy/privacyRouter.ts";
import { quoteAcceptedMemberEmail } from "../API/clientStatus/clientStatusRouter.ts";
import { quotePendingApprovalEmail } from "../API/dashboard/quotesRouter.ts";
import { pricingRequestEmail } from "../API/dashboard/pricingRequestsRouter.ts";
import { bugReportEmail } from "../API/dashboard/bugReportHandler.ts";

export type EmailClassLabel = "transactional" | "service" | "marketing" | "internal";

export interface Preview {
  id: string; // file name without .html
  name: string;
  recipient: "member" | "lead" | "lawyer" | "applicant" | "staff" | "csm" | "sales" | "pricing desk";
  cls: EmailClassLabel;
  subject: string;
  html: string;
}

// ─── Fictional data ────────────────────────────────────────────────────────

const SITE = "https://app.example.com";
const API = "https://api.example.com";
const UNSUB = `${API}/api/retention/unsubscribe?c=cli_demo_ellison&t=0123456789abcdef0123456789abcdef`;
const LEAD_UNSUB = `${API}/api/retention/unsubscribe?l=lead_demo_01&t=0123456789abcdef0123456789abcdef`;
const MEMBER = { first: "Margaret", full: "Margaret Ellison", email: "margaret.ellison@example.com" };
const LAWYER = { first: "Daniela", full: "Daniela Vargas Mora" };
const CSM = "carla.mendez@example.com";
const MEET = "https://meet.google.com/abc-defg-hij";
const SUPPORT = "support@example.com";
const TEAM = "partners@example.com";

const brief: PreCallBrief = {
  memberName: MEMBER.full,
  country: "Costa Rica",
  memberZone: "America/Chicago",
  question: "We are buying a condo in Tamarindo. What should we check before signing the purchase agreement?",
  matter: { title: "Condo purchase in Tamarindo", area: "Real estate" },
  facts: [["Residency", "Pensionado, approved 2025"], ["Owns property", "Not yet"], ["Household", "Married, two adult children in the US"]],
  obligations: [{ title: "Residency renewal may require review", due: "Mar 1, 2027" }],
  previous: [{ date: "Oct 2, 2026", summary: "Went over the purchase steps and the escrow options.", nextSteps: ["Send the draft purchase agreement", "Ask the seller for the HOA bylaws"] }],
  documents: ["Passport (identity)", "Draft purchase agreement (property)"],
};

const findings = [
  { ruleId: "cr_marchamo", title: "Vehicle circulation tax (marchamo) may require review", area: "vehicle", dueAt: "2026-12-31T00:00:00.000Z", meaning: "Every vehicle registered in Costa Rica pays it each year.", authority: "INS", reviewedByCounsel: true },
  { ruleId: "cr_corp_tax", title: "Inactive company tax may require review", area: "corporate", confidence: "low", meaning: "Companies registered in Costa Rica may owe an annual tax even without activity.", authority: "Hacienda", reviewedByCounsel: false },
  { ruleId: "cr_residency", title: "Residency card renewal may require review", area: "immigration", dueText: "Before your card expires", meaning: "Pensionado residency cards are renewed every few years.", authority: "DGME", reviewedByCounsel: true },
] as unknown as CheckFinding[];

const legalData = {
  name: MEMBER.full,
  legalArea: "real estate",
  legalMatter: "condo purchase",
  jurisdiction: "Costa Rica",
  quoteTitle: "Condo purchase review and escrow",
  filingDeadline: "December 15, 2026",
  statusPageUrl: `${SITE}/status`,
};

// ─── Every email ───────────────────────────────────────────────────────────

/** Pure: every email with fictional data. Call setPreviewEnv() first for site links built from env. */
export function renderAll(): Preview[] {
  const out: Preview[] = [];
  const add = (id: string, name: string, recipient: Preview["recipient"], cls: EmailClassLabel, m: { subject: string; html: string }) =>
    out.push({ id, name, recipient, cls, subject: m.subject, html: m.html });

  // Sign-in and account security
  for (const portal of ["member", "lawyer", "staff"] as const) {
    add(`signin-code-${portal}`, `Sign-in code (${portal} portal)`, portal === "member" ? "member" : portal === "lawyer" ? "lawyer" : "staff", "transactional", signInCodeEmail({ portal, code: "482913" }));
  }
  for (const portal of ["member", "lawyer", "staff"] as const) {
    add(`signin-lockout-${portal}`, `Sign-in lockout after 5 wrong codes (${portal} portal)`, portal === "member" ? "member" : portal === "lawyer" ? "lawyer" : "staff", "transactional",
      signInLockoutEmail({ portal, signInUrl: `${SITE}/${portal === "member" ? "status" : portal === "lawyer" ? "lawyer" : "dashboard"}`, supportEmail: SUPPORT }));
  }

  // Membership lifecycle
  add("join-confirmed", "Join confirmation (automatic renewal terms)", "member", "transactional", joinConfirmation({ periodEnd: "2026-12-03T15:00:00.000Z", minutesIncluded: 60, callsIncluded: 3 }, MEMBER.first));
  add("manual-payment", "Manual payment instructions on join", "member", "transactional", manualPaymentEmail({
    firstName: MEMBER.first, totalLabel: "US$179.99", activationLabel: "US$100.00", monthlyLabel: "US$79.99", reference: "ILP-7K3Q9D2M",
    bank: null, contactEmail: SUPPORT, termsUrl: `${SITE}/terms`,
  }));
  add("renewal-notice-card", "Renewal notice 7 days before (card)", "member", "transactional", renewalNotice({ periodEnd: "2026-12-03T15:00:00.000Z", paymentRef: "sub_demo" }, MEMBER.first));
  add("renewal-notice-manual", "Renewal notice 7 days before (bank transfer)", "member", "transactional", renewalNotice({ periodEnd: "2026-12-03T15:00:00.000Z", paymentRef: "manual" }, MEMBER.first));
  add("renewal-receipt", "Renewal receipt", "member", "transactional", renewalReceiptEmail({ firstName: MEMBER.first, amountLabel: "US$79.99", periodLabel: "November 3, 2026 to December 3, 2026", minutes: 60, calls: 3, moneyUrl: `${SITE}/status/money`, bookUrl: `${SITE}/status/book` }));
  for (const day of [0, 3, 6] as const) {
    add(`payment-failed-day${day}`, `Payment failed, day ${day}`, "member", "transactional", paymentFailedEmail({ firstName: MEMBER.first, day, pausesOn: "November 10, 2026", moneyUrl: `${SITE}/status/money`, byCard: true }));
  }
  add("access-paused", "Access paused, day 7", "member", "transactional", accessPausedEmail({ firstName: MEMBER.first, moneyUrl: `${SITE}/status/money`, byCard: true }));
  add("cancel-confirmed", "Cancellation confirmed", "member", "transactional", cancellationConfirmedEmail({ firstName: MEMBER.first, endsOn: "December 3, 2026", moneyUrl: `${SITE}/status/money` }));
  add("cancel-undone", "Cancellation undone", "member", "transactional", cancelUndoneEmail({ firstName: MEMBER.first, renewsOn: "December 3, 2026", amountLabel: "US$79.99", byCard: true, moneyUrl: `${SITE}/status/money` }));
  add("membership-ended", "Membership ended (member)", "member", "transactional", membershipEndedEmail({ firstName: MEMBER.first, endedOn: "December 3, 2026", joinUrl: `${SITE}/join`, privacyUrl: `${SITE}/status/privacy`, homeUrl: `${SITE}/status` }));

  // Lawyer assignment and calls (member)
  add("lawyer-assigned-first", "First lawyer assigned (member)", "member", "transactional", lawyerAssignedMemberEmail({ firstName: MEMBER.first, lawyerName: LAWYER.full, countryName: "Costa Rica", bookUrl: `${SITE}/status/book`, homeUrl: `${SITE}/status` }));
  add("routing-arranging", "No lawyer yet: we are arranging one (member)", "member", "transactional", arrangingLawyerEmail({ firstName: MEMBER.first, country: "Panama", salesWhen: "Thursday, November 5, 10:00 AM (Chicago time)", portalUrl: `${SITE}/status` }));
  add("routing-lawyer-confirmed", "Lawyer found after a wait (member)", "member", "transactional", lawyerAssignedEmail({ firstName: MEMBER.first, lawyerName: LAWYER.full, country: "Panama", bookUrl: `${SITE}/status/book` }));
  add("call-booked-member", "Call booked (member)", "member", "transactional", callBookedMemberEmail({ firstName: MEMBER.first, lawyerName: LAWYER.full, whenLabel: "Thursday, November 5, 9:00 AM (Chicago time)", meetUrl: MEET, portalUrl: `${SITE}/status` }));
  add("call-booked-member-nolink", "Call booked, video link to follow (member)", "member", "transactional", callBookedMemberEmail({ firstName: MEMBER.first, lawyerName: LAWYER.full, whenLabel: "Thursday, November 5, 9:00 AM (Chicago time)", meetUrl: null, portalUrl: `${SITE}/status` }));
  for (const kind of ["24h", "1h"] as const) {
    add(`call-reminder-member-${kind}`, `Call reminder ${kind} (member)`, "member", "transactional", callReminderEmail({ to: "member", kind, greetingName: MEMBER.first, otherName: LAWYER.full, whenLabel: "Thursday, November 5, 9:00 AM (Chicago time)", meetUrl: MEET, question: brief.question, portalUrl: `${SITE}/status` }));
  }
  add("call-reminder-sales-24h", "Sales call reminder 24h (sales inbox)", "sales", "internal", callReminderEmail({ to: "lawyer", kind: "24h", greetingName: "ILP sales team", otherName: MEMBER.full, whenLabel: "Thursday, November 5, 10:00 AM", meetUrl: MEET, question: brief.question }));
  add("call-cancelled-member", "Call cancelled (member)", "member", "transactional", callChangedEmail({ change: "cancelled", greetingName: MEMBER.first, otherName: LAWYER.full, oldWhenLabel: "Thursday, November 5, 9:00 AM", link: `${SITE}/status/book`, linkLabel: "Book another time" }));
  add("call-cancelled-lawyer", "Call cancelled or reassigned (lawyer)", "lawyer", "transactional", callChangedEmail({ change: "cancelled", greetingName: LAWYER.first, otherName: MEMBER.full, oldWhenLabel: "Thursday, November 5, 8:00 AM", link: `${SITE}/lawyer`, linkLabel: "Open Today" }));
  add("call-moved-member", "Call moved (member)", "member", "transactional", callChangedEmail({ change: "rescheduled", greetingName: MEMBER.first, otherName: LAWYER.full, oldWhenLabel: "Thursday, November 5, 9:00 AM", newWhenLabel: "Friday, November 6, 11:00 AM", meetUrl: MEET, link: `${SITE}/status`, linkLabel: "Open your ILP home" }));
  add("call-moved-lawyer", "Call moved (lawyer)", "lawyer", "transactional", callChangedEmail({ change: "rescheduled", greetingName: LAWYER.first, otherName: MEMBER.full, oldWhenLabel: "Thursday, November 5, 8:00 AM", newWhenLabel: "Friday, November 6, 10:00 AM", meetUrl: MEET, link: `${SITE}/lawyer`, linkLabel: "Open Today" }));
  add("no-show-member", "Missed call (member)", "member", "transactional", noShowMemberEmail({ firstName: MEMBER.first, lawyerName: LAWYER.full, whenLabel: "Thursday, November 5, 9:00 AM", charged: true, minutes: 20, minutesLeft: 40, callsLeft: 2, bookUrl: `${SITE}/status/book`, messagesUrl: `${SITE}/status/messages` }));
  add("rating-request", "How was your call? (rating request)", "member", "service", ratingRequestEmail({ firstName: MEMBER.first, lawyerName: LAWYER.full, whenLabel: "November 5", rateUrl: `${SITE}/status`, unsubscribeUrl: UNSUB }));

  // After the call, matters, quotes and money (member)
  add("handoff-next-steps", "Next steps confirmed by the lawyer", "member", "service", handoffNextStepsEmail({ firstName: MEMBER.first, matterTitle: "Condo purchase in Tamarindo", steps: [{ what: "Send the draft purchase agreement", whoLabel: "You", dueLabel: "November 12, 2026" }, { what: "Review the HOA bylaws", whoLabel: "Your lawyer" }], homeUrl: `${SITE}/status`, unsubscribeUrl: UNSUB }));
  add("next-step-changed", "Next step changed on a matter", "member", "service", nextStepChangedEmail({ firstName: MEMBER.first, matterTitle: "Condo purchase in Tamarindo", what: "Upload the signed escrow instructions", whoLabel: "You", dueLabel: "November 20, 2026", homeUrl: `${SITE}/status`, unsubscribeUrl: UNSUB }));
  add("missing-document", "A document is still needed (3 days)", "member", "service", missingDocumentEmail({ firstName: MEMBER.first, what: "Upload the draft purchase agreement", matterTitle: "Condo purchase in Tamarindo", uploadUrl: `${SITE}/status/profile#documents`, messagesUrl: `${SITE}/status/messages`, unsubscribeUrl: UNSUB }));
  add("quote-reminder", "Quote waiting 5 days", "member", "service", quoteReminderEmail({ firstName: MEMBER.first, quoteTitle: "Condo purchase review and escrow", sentOn: "October 29, 2026", quoteUrl: `${SITE}/status/money`, messagesUrl: `${SITE}/status/messages`, unsubscribeUrl: UNSUB }));
  add("quote-accepted-member", "Quote accepted (member confirmation)", "member", "transactional", quoteAcceptedMemberEmail("Condo purchase review and escrow"));
  const inv = { clientName: MEMBER.full, invoiceNumber: "ILP-2026-0042" };
  add("invoice-ready", "Invoice sent by staff (balance due)", "member", "transactional", invoiceMail(inv, { total: 850, balance: 425 }));
  add("invoice-paid", "Invoice paid receipt", "member", "transactional", invoicePaidEmail({ firstName: MEMBER.first, invoiceNumber: "ILP-2026-0042", amountLabel: "US$850.00", paidOn: "November 12, 2026", moneyUrl: `${SITE}/status/money`, contactEmail: SUPPORT }));

  // Reminders, check-ins, nudges (member)
  add("obligations-due-member", "Dates that may require review (member, 30/7 days)", "member", "service", obligationsDueEmail({ firstName: MEMBER.first, items: [{ title: "Residency card renewal", dueLabel: "December 1, 2026", daysLeft: 30 }, { title: "Inactive company tax", dueLabel: "", daysLeft: 30, confirm: true }], askUrl: `${SITE}/status/messages`, unsubscribeUrl: UNSUB }));
  add("obligations-due-free", "Dates that may require review (free account)", "member", "service", obligationsDueEmail({ firstName: MEMBER.first, items: [{ title: "Vehicle circulation tax (marchamo)", dueLabel: "December 31, 2026", daysLeft: 7 }], askUrl: `${SITE}/status/deadlines`, unsubscribeUrl: UNSUB, free: true }));
  add("compliance-alert", "Compliance alert before a deadline (alerts engine)", "member", "service", {
    subject: "Coming up: Residency card renewal",
    html: withLegalFooter(complianceAlertEmail({ firstName: MEMBER.first, obligationTitle: "Residency card renewal", deadlineLabel: "December 1, 2026", responseUrl: `${SITE}/status/deadlines` }), { unsubscribeUrl: UNSUB }),
  });
  add("profile-ready", "Profile ready: book your first call", "member", "service", profileReadyEmail({ firstName: MEMBER.first, minutes: 60, calls: 3, callLengthMin: 20, bookUrl: `${SITE}/status/book`, unsubscribeUrl: UNSUB }));
  add("monthly-check-in", "Monthly check-in with 0-10 question", "member", "marketing", monthlyCheckInEmail({ firstName: MEMBER.first, minutesLeft: 40, minutesIncluded: 60, callsLeft: 2, renewsOn: "December 3, 2026", bookUrl: `${SITE}/status/book`, scoreUrl: (n) => `${API}/api/retention/score?c=demo&n=${n}`, feedbackUrl: `${SITE}/status/feedback`, unsubscribeUrl: UNSUB }));
  add("booking-nudge", "Booking nudge, day 5 with no call", "member", "marketing", bookingNudgeEmail({ firstName: MEMBER.first, minutes: 60, calls: 3, bookUrl: `${SITE}/status/book`, unsubscribeUrl: UNSUB }));

  // Free deadline check (lead)
  add("free-check-findings", "Free deadline check results", "lead", "service", { subject: "Your free deadline check from ILP", html: findingsEmailHtml(findings, "CR", LEAD_UNSUB) });

  // Privacy
  add("privacy-received", "Privacy request received", "member", "transactional", privacyReceivedEmail({ firstName: MEMBER.first, kindLabel: "Delete my account", requestId: "prq_demo_01", createdOn: "November 3, 2026", dueOn: "December 3, 2026", deletion: true }));
  add("privacy-completed", "Privacy request complete", "member", "transactional", privacyDecisionEmail({ firstName: MEMBER.first, kindLabel: "Correct my data", requestId: "prq_demo_02", status: "completed", note: "We updated your mailing address." }));
  add("privacy-refused", "Privacy request refused", "member", "transactional", privacyDecisionEmail({ firstName: MEMBER.first, kindLabel: "Delete my account", requestId: "prq_demo_03", status: "refused", note: "An invoice is still open. We can delete the account once it is settled." }));
  add("privacy-erased", "Account deleted", "member", "transactional", privacyErasedEmail({ requestId: "prq_demo_01" }));

  // Staff-editable legal emails (Emails tab), sent by staff (service) with the reminder unsubscribe link
  for (const type of legalEmailTypes()) {
    const r = renderLegalEmail(type, legalData);
    add(`legal-${type.replace(/_/g, "-")}`, `Staff email: ${type}`, "member", "service", { subject: r.subject, html: withLegalFooter(r.bodyHtml, { unsubscribeUrl: UNSUB, unsubscribeLabel: "Stop reminder emails" }) });
  }
  const qr = renderLegalEmail("quote_ready", legalData);
  add("quote-ready-send-to-client", "Quote ready (Send to client)", "member", "transactional", { subject: qr.subject, html: qr.bodyHtml });
  const overdue = renderLegalEmail("filing_deadline_reminder", legalData);
  add("deadline-overdue-team", "Overdue filing (team escalation)", "staff", "internal", { subject: `[Overdue filing] ${overdue.subject}`, html: overdue.bodyHtml });

  // CSM playbooks
  for (const p of Object.values(DEFAULT_PLAYBOOKS)) {
    add(`playbook-${p.id.replace(/_/g, "-")}`, `CSM playbook: ${p.title}`, "member", p.emailClass, renderPlaybookEmail(p, { firstName: MEMBER.first, csmEmail: CSM, periodEnd: "December 3, 2026", siteUrl: SITE, unsubscribeUrl: UNSUB }));
  }

  // Lawyer emails
  for (const kind of ["booked", "24h", "1h"] as const) {
    add(`precall-lawyer-${kind}`, `Pre-call brief to the lawyer (${kind})`, "lawyer", "transactional", preCallLawyerEmail({ lang: "en", kind, lawyerName: LAWYER.first, when: "Thursday, November 5, 8:00 AM (Costa Rica time)", durationMin: 20, meetUrl: MEET, briefUrl: `${SITE}/lawyer/calls/cons_demo`, brief }));
  }
  add("lawyer-member-assigned", "New member assigned (lawyer)", "lawyer", "transactional", memberAssignedEmail({ firstName: LAWYER.first, brief, portalUrl: `${SITE}/lawyer/clients` }));
  add("lawyer-summary-ready", "Call summary ready to confirm", "lawyer", "transactional", summaryReadyEmail({ firstName: LAWYER.first, memberName: MEMBER.full, callWhen: "November 5, 8:00 AM", drafted: true, callUrl: `${SITE}/lawyer/calls/cons_demo`, reminder: false }));
  add("lawyer-summary-reminder", "Call summary still to confirm (24 h reminder)", "lawyer", "transactional", summaryReadyEmail({ firstName: LAWYER.first, memberName: MEMBER.full, callWhen: "November 5, 8:00 AM", drafted: true, callUrl: `${SITE}/lawyer/calls/cons_demo`, reminder: true }));
  add("lawyer-quote-approved", "Quote approved (lawyer)", "lawyer", "transactional", quoteDecisionEmail({ firstName: LAWYER.first, memberName: MEMBER.full, quoteTitle: "Condo purchase review and escrow", decision: "approved", url: `${SITE}/lawyer/clients` }));
  add("lawyer-quote-changes", "Changes requested on a quote (lawyer)", "lawyer", "transactional", quoteDecisionEmail({ firstName: LAWYER.first, memberName: MEMBER.full, quoteTitle: "Condo purchase review and escrow", decision: "changes", note: "Split the escrow fee into its own line.", url: `${SITE}/lawyer/clients` }));
  add("lawyer-quote-accepted", "Member accepted your quote (lawyer)", "lawyer", "transactional", quoteAcceptedLawyerEmail({ firstName: LAWYER.first, memberName: MEMBER.full, quoteTitle: "Condo purchase review and escrow", fee: 600, url: `${SITE}/lawyer/finance` }));
  add("lawyer-payout", "Payment recorded to the lawyer", "lawyer", "transactional", payoutEmail({ firstName: LAWYER.first, items: [{ label: "Condo purchase review and escrow", amount: 600, date: "November 20, 2026" }], url: `${SITE}/lawyer/finance` }));
  add("lawyer-weekly-digest", "Weekly digest (lawyer)", "lawyer", "service", weeklyDigestEmail({ firstName: LAWYER.first, weekLabel: "November 9 to 13", calls: [{ when: "Mon Nov 9, 8:00 AM", memberName: MEMBER.full, matter: "Condo purchase in Tamarindo" }, { when: "Wed Nov 11, 10:00 AM", memberName: "Robert Hale", matter: null }], summaries: [{ memberName: "Linda Park", when: "Nov 6" }], quotes: [{ title: "Residency renewal", memberName: "Robert Hale", status: "pending approval" }], offers: 1, urls: { today: `${SITE}/lawyer`, quotes: `${SITE}/lawyer/clients`, work: `${SITE}/lawyer/work` } }));
  add("lawyer-profile-incomplete", "Finish your profile (lawyer)", "lawyer", "service", profileIncompleteEmail({ firstName: LAWYER.first, approvedOn: "October 30, 2026", missing: ["specialties", "weekly hours"], profileUrl: `${SITE}/lawyer/profile` }));
  add("lawyer-licence-expiring", "Licence expiring in 30 days (lawyer)", "lawyer", "transactional", licenceExpiringEmail({ firstName: LAWYER.first, country: "Costa Rica", body: "Colegio de Abogados y Abogadas de Costa Rica", expiresOn: "December 3, 2026", days: 30, teamEmail: TEAM }));
  add("lawyer-work-offer", "Paid work in your specialty (lawyer)", "lawyer", "service", workOfferEmail({ firstName: LAWYER.first, title: "Escrow review for a condo purchase", area: "Real estate", country: "Costa Rica", description: "Review the escrow agreement and the HOA bylaws before signing.", respondBy: "November 10, 2026", url: `${SITE}/lawyer/work` }));
  add("lawyer-monthly-feedback", "Monthly member feedback (lawyer)", "lawyer", "service", monthlyFeedbackEmail({ firstName: LAWYER.first, monthLabel: "October 2026", recognition: false, reviewsInMonth: 6, periodLabel: "October 2026", averageStars: 4.5, comments: ["Clear answers and a useful list of next steps.", "The call ran a little short for my questions."], tooFewToShow: false, minReviewsToShowDetail: 3, feedbackUrl: `${SITE}/lawyer/feedback` }));
  add("lawyer-monthly-feedback-thanks", "Monthly member feedback with thank-you (lawyer)", "lawyer", "service", monthlyFeedbackEmail({ firstName: LAWYER.first, monthLabel: "October 2026", recognition: true, reviewsInMonth: 8, periodLabel: "October 2026", averageStars: 4.9, comments: ["Very well prepared, she had read my profile."], tooFewToShow: false, minReviewsToShowDetail: 3, feedbackUrl: `${SITE}/lawyer/feedback` }));
  add("lawyer-coaching", "Constructive feedback and call offer (lawyer)", "lawyer", "service", coachingEmail({ firstName: LAWYER.first, themes: [{ label: "Time on the call", tip: "Leave the last three minutes for next steps." }, { label: "Plain language", tip: "Explain local terms in one sentence." }], averageStars: 3.2, periodLabel: "the last 90 days", teamEmail: TEAM, feedbackUrl: `${SITE}/lawyer/feedback` }));
  add("lawyer-no-show", "No-show recorded (lawyer)", "lawyer", "transactional", noShowLawyerEmail({ firstName: LAWYER.first, memberName: MEMBER.full, whenLabel: "November 5, 8:00 AM", url: `${SITE}/lawyer` }));
  add("lawyer-membership-ended", "Membership ended (lawyer)", "lawyer", "transactional", membershipEndedLawyerEmail({ firstName: LAWYER.first, memberName: MEMBER.full, endedOn: "December 3, 2026", url: `${SITE}/lawyer/clients` }));

  // Lawyer applications
  add("apply-received", "Application received (applicant)", "applicant", "transactional", lawyerApplyEmails.received({ name: LAWYER.first, signInUrl: `${SITE}/lawyer`, country: "CR" }));
  add("apply-approved", "Application approved (applicant)", "applicant", "transactional", lawyerApplyEmails.approved({ name: LAWYER.first, signInUrl: `${SITE}/lawyer` }));
  add("apply-changes", "Application needs a change (applicant)", "applicant", "transactional", lawyerApplyEmails.changes({ name: LAWYER.first, note: "Please add your carné number.", applyUrl: `${SITE}/lawyers/apply`, signInUrl: `${SITE}/lawyer` }));
  add("apply-declined", "Application declined (applicant)", "applicant", "transactional", lawyerApplyEmails.declined({ name: LAWYER.first, reason: "We need a lawyer licensed in Costa Rica for at least two years." }));

  // Staff, CSM and sales
  add("staff-alert", "Staff alert (bell + email), e.g. missing specialty", "staff", "internal", staffNotificationEmail({ title: "Missing specialty for an assignment: Panama · Condominiums and owners' associations · Margaret Ellison", body: "No lawyer in Panama takes condominium questions yet.", url: `${SITE}/dashboard/members/cli_demo_ellison` }));
  add("sales-call-booked", "Sales call booked (sales inbox)", "sales", "internal", salesCallEmail({ booked: true, memberName: MEMBER.full, memberEmail: MEMBER.email, memberPhone: "+1 312 555 0147", country: "Panama", need: "Condominiums", question: brief.question, when: "Thursday, November 5, 10:00 AM", meetUrl: MEET, memberUrl: `${SITE}/dashboard/members/cli_demo_ellison` }));
  add("sales-call-to-set", "Set a sales call (sales inbox)", "sales", "internal", salesCallEmail({ booked: false, memberName: MEMBER.full, memberEmail: MEMBER.email, memberPhone: null, country: "Panama", need: "Condominiums", question: brief.question, when: null, meetUrl: null, memberUrl: `${SITE}/dashboard/members/cli_demo_ellison` }));
  add("csm-alert", "CSM immediate alert (payment failed / privacy request)", "csm", "internal", csmAlertEmail({ title: `Payment failed: ${MEMBER.full}`, body: "Membership payment failed. Call the member today.", url: `${SITE}/csm/book/cli_demo_ellison` }));
  add("csm-digest", "CSM daily digest", "csm", "internal", csmDigestEmail({ dayLabel: "Tuesday, November 3", summary: "2 overdue, 3 due today, 1 new member", portalUrl: `${SITE}/csm`, sections: [
    { heading: "Overdue", lines: [{ title: "Welcome call: Margaret Ellison", detail: "Due Nov 2", url: `${SITE}/csm/book/cli_demo_ellison` }, { title: "Renewal call: Robert Hale", detail: "Due Nov 1", url: `${SITE}/csm/book/cli_demo_hale` }], more: 0 },
    { heading: "Due today", lines: [{ title: "Send next steps: Linda Park", url: `${SITE}/csm/book/cli_demo_park` }], more: 2 },
    { heading: "New in your book", lines: [{ title: "Thomas Reed", detail: "Joined yesterday", url: `${SITE}/csm/book/cli_demo_reed` }], more: 0 },
  ] }));
  add("escalation-staff", "Alert escalation (staff)", "staff", "internal", { subject: "Escalation: Residency card renewal", html: escalationEmail({ staffName: "", profileName: MEMBER.full, obligationTitle: "Residency card renewal", dashboardUrl: `${SITE}/dashboard` }) });
  add("quote-pending-approval-staff", "Quote pending approval (from staff)", "staff", "internal", quotePendingApprovalEmail({ by: "Agent", actor: "ana.solis@example.com", quoteTitle: "Condo purchase review and escrow", clientId: "cli_demo_ellison", note: "Escrow fee checked with the bank." }));
  add("quote-pending-approval-lawyer", "Quote pending approval (from a lawyer)", "staff", "internal", quotePendingApprovalEmail({ by: "Lawyer", actor: "daniela.vargas@example.com", quoteTitle: "Condo purchase review and escrow", clientId: "cli_demo_ellison" }));
  add("pricing-request", "Pricing request (pricing desk)", "pricing desk", "internal", pricingRequestEmail({ index: 3, clientName: MEMBER.full, clientEmail: MEMBER.email, actor: "ana.solis@example.com", options: [{ index: 1, serviceLine: "Condo purchase review", items: ["Title search", "Escrow agreement review"] }], originLabel: "United States", originNotes: "Chicago", destinationLabel: "Costa Rica", destinationNotes: "Tamarindo" }));
  add("bug-report", "Bug report (team)", "staff", "internal", bugReportEmail({ title: "Money page does not load", description: "Spinner keeps going on /status/money.", url: `${SITE}/status/money`, actor: "ana.solis@example.com" }));

  // Legacy booking route (/api/consultations): still mounted.
  add("legacy-consultation-confirmed", "Consultation confirmed (legacy booking route)", "member", "transactional", { subject: "Consultation confirmed", html: consultationConfirmationEmail({ firstName: MEMBER.first, providerName: LAWYER.full, slotLabel: "2026-11-05T15:00:00.000Z", meetingUrl: MEET }) });

  return out;
}

/** Links built from env (siteUrl(), PUBLIC_SITE_URL) point at the fictional site. */
export function setPreviewEnv(): void {
  for (const k of ["PUBLIC_SITE_URL", "FRONTEND_URL"]) Deno.env.set(k, SITE);
  for (const k of ["PUBLIC_API_URL", "API_PUBLIC_URL"]) Deno.env.set(k, API);
}

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Pure: the index page. */
export function indexHtml(list: Preview[], generatedAt: string): string {
  const rows = list.map((p) =>
    `<tr><td><a href="${esc(p.id)}.html">${esc(p.name)}</a></td><td>${esc(p.subject)}</td><td>${esc(p.recipient)}</td><td>${esc(p.cls)}</td></tr>`
  ).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ILP email previews</title>
<style>body{font-family:Helvetica,Arial,sans-serif;color:#202a33;margin:24px;max-width:1100px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #d9e1e6;padding:8px;text-align:left;vertical-align:top;font-size:14px}th{background:#f3f6f8}a{color:#123b5d}</style></head>
<body><h1>ILP email previews</h1><p>${list.length} emails rendered with the real templates and fictional data (generated ${esc(generatedAt)} by server/scripts/renderEmailPreviews.ts). Catalog: docs/workstreams/EMAIL_CATALOG.md.</p>
<table><thead><tr><th>Email</th><th>Subject</th><th>Recipient</th><th>Class</th></tr></thead><tbody>
${rows}
</tbody></table></body></html>`;
}

/** Pure: one preview file (a subject banner above the email body). */
export function previewFile(p: Preview): string {
  const banner = `<div style="font-family:Helvetica,Arial,sans-serif;background:#f3f6f8;border-bottom:1px solid #d9e1e6;padding:10px 16px;font-size:13px;color:#4a5a66"><a href="index.html">All emails</a> · <strong>Subject:</strong> ${esc(p.subject)} · <strong>To:</strong> ${esc(p.recipient)} · <strong>Class:</strong> ${esc(p.cls)}</div>`;
  const i = p.html.toLowerCase().indexOf("<body");
  if (i >= 0) {
    const j = p.html.indexOf(">", i) + 1;
    return `${p.html.slice(0, j)}${banner}${p.html.slice(j)}`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.subject)}</title></head><body>${banner}${p.html}</body></html>`;
}

export async function writePreviews(outDir: string): Promise<number> {
  setPreviewEnv();
  const list = renderAll();
  await Deno.mkdir(outDir, { recursive: true });
  for (const p of list) await Deno.writeTextFile(`${outDir}/${p.id}.html`, previewFile(p));
  await Deno.writeTextFile(`${outDir}/index.html`, indexHtml(list, new Date().toISOString()));
  return list.length;
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  const arg = Deno.args.find((a) => a.startsWith("--out="));
  const out = arg ? arg.slice(6) : new URL("../../docs/email-previews", import.meta.url).pathname;
  const n = await writePreviews(out);
  console.log(`Wrote ${n} email previews and index.html to ${out}`);
}
