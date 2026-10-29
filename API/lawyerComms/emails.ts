/**
 * API/lawyerComms/emails.ts — emails to partner lawyers (COMMS-P2). Pure templates.
 * ──────────────────────────────────────────────────────────────────────────
 * All in English (owner decision 2026-10-28). Lawyers are partners, so these
 * are transactional or service emails with no marketing unsubscribe; each
 * carries LAWYER_FOOTER. Member data is minimized: first and last name of the
 * member, never their email, phone, birth date or ID numbers, and never
 * another lawyer's data or any rating score. Copy follows
 * frontend/copy-rules.md (plain words, no em or en dashes).
 */

import type { MemberEmail } from "../../helper/emailTemplates.ts";
import type { PreCallBrief } from "../routing/emails.ts";

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const LAWYER_FOOTER = "International Legal Partner (ILP). You get this email as an ILP partner lawyer.";
export const PRIVACY_NOTE = "This email holds the member's personal data. Do not forward it, and delete it when you no longer need it.";

export interface Section {
  title: string;
  lines: string[];
  /** Render as a bulleted list (default true when there is more than one line). */
  list?: boolean;
}

/** One layout for every lawyer email: greeting, paragraphs, sections, button, notes, sign-off, footer. */
export function lawyerEmailLayout(o: {
  subject: string;
  firstName?: string;
  paragraphs: string[];
  sections?: Section[];
  cta?: { label: string; url: string };
  notes?: string[];
}): MemberEmail {
  const hello = o.firstName ? `Hi ${o.firstName},` : "Hello,";
  const P = (t: string) => `<p style="margin:0 0 12px">${esc(t)}</p>`;
  const sections = (o.sections ?? []).filter((s) => s.lines.length);
  const isList = (s: Section) => s.list ?? s.lines.length > 1;
  const sectionHtml = sections.map((s) =>
    `<h3 style="color:#123b5d;font-size:15px;margin:20px 0 6px">${esc(s.title)}</h3>` +
    (isList(s)
      ? `<ul style="margin:0 0 10px;padding-left:20px">${s.lines.map((l) => `<li style="margin:0 0 4px">${esc(l)}</li>`).join("")}</ul>`
      : s.lines.map(P).join(""))
  ).join("");
  const cta = o.cta
    ? `<p style="margin:20px 0"><a href="${esc(o.cta.url)}" style="background:#5cccf7;color:#123b5d;padding:10px 18px;text-decoration:none;border-radius:999px;font-weight:600;display:inline-block">${esc(o.cta.label)}</a></p>`
    : "";
  const notes = (o.notes ?? []).map((n) => `<p style="margin:0 0 6px;font-size:13px;color:#4a5a66">${esc(n)}</p>`).join("");
  const html = `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#202a33;line-height:1.55;font-size:15px;max-width:600px;margin:0 auto;padding:16px">
    ${P(hello)}${o.paragraphs.map(P).join("")}${sectionHtml}${cta}${notes}
    <p style="margin:16px 0 0">The ILP team</p>
    <p style="margin:20px 0 0;font-size:12px;color:#7a8a96">${esc(LAWYER_FOOTER)}</p>
  </body></html>`;
  const text = [
    hello,
    "",
    ...o.paragraphs.flatMap((p) => [p, ""]),
    ...sections.flatMap((s) => [s.title, ...s.lines.map((l) => (isList(s) ? `- ${l}` : l)), ""]),
    ...(o.cta ? [`${o.cta.label}: ${o.cta.url}`, ""] : []),
    ...(o.notes?.length ? [...o.notes, ""] : []),
    "The ILP team",
    "",
    LAWYER_FOOTER,
  ].join("\n");
  return { subject: o.subject, html, text };
}

/** "US$1,250.00" */
export function usd(amount: number): string {
  return `US$${(Math.round(amount * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ─── New member assigned ───────────────────────────────────────────────────

export function memberAssignedEmail(o: { firstName?: string; brief: PreCallBrief; portalUrl: string }): MemberEmail {
  const b = o.brief;
  return lawyerEmailLayout({
    subject: `New ILP member assigned to you: ${b.memberName}`,
    firstName: o.firstName,
    paragraphs: [
      `${b.memberName} is now your ILP member for ${b.country}. Below is what is on file so far. They book calls inside your hours, and before each call you get the full brief by email.`,
    ],
    sections: [
      { title: "The member's question", lines: [b.question?.trim() || "The member has not written a question yet."], list: false },
      ...(b.matter ? [{ title: "Matter", lines: [`${b.matter.title} (${b.matter.area})`], list: false }] : []),
      { title: "Profile facts", lines: [`Country of the matter: ${b.country}`, ...b.facts.map(([k, v]) => `${k}: ${v}`)], list: true },
      { title: "Upcoming deadlines", lines: b.obligations.length ? b.obligations.map((x) => `${x.due}: ${x.title}`) : ["None on file."], list: b.obligations.length > 0 },
      { title: "Documents in the portal", lines: b.documents.length ? b.documents : ["The member has not uploaded documents yet."], list: b.documents.length > 0 },
    ],
    cta: { label: "Open your members", url: o.portalUrl },
    notes: ["Documents are not attached to this email. Open them in the lawyer portal after you sign in.", PRIVACY_NOTE],
  });
}

// ─── Call summary ready to confirm, and its reminder ──────────────────────

export function summaryReadyEmail(o: { firstName?: string; memberName: string; callWhen: string; drafted: boolean; callUrl: string; reminder: boolean }): MemberEmail {
  const subject = o.reminder
    ? `Reminder: the summary of your call with ${o.memberName} is waiting`
    : `Summary ready to confirm: your call with ${o.memberName}`;
  const lead = o.reminder
    ? `The summary of your call with ${o.memberName} on ${o.callWhen} is still waiting for you. The member gets their written answer only after you confirm it.`
    : o.drafted
    ? `The transcript of your call with ${o.memberName} on ${o.callWhen} is in, and a suggested summary with next steps is drafted on the call page.`
    : `The transcript of your call with ${o.memberName} on ${o.callWhen} is in. Write the summary and next steps on the call page.`;
  return lawyerEmailLayout({
    subject,
    firstName: o.firstName,
    paragraphs: [
      lead,
      "Check the wording, change what you need and press Confirm and hand off. Nothing reaches the member until you do, and the member's CSM at ILP takes the follow-up from there.",
      ...(o.reminder ? ["If we do not see it confirmed within a day, the member's CSM will contact you to help finish it."] : []),
    ],
    cta: { label: "Open the call page", url: o.callUrl },
  });
}

// ─── Quotes ────────────────────────────────────────────────────────────────

export function quoteDecisionEmail(o: { firstName?: string; memberName: string; quoteTitle: string; decision: "approved" | "changes"; note?: string | null; url: string }): MemberEmail {
  if (o.decision === "approved") {
    return lawyerEmailLayout({
      subject: `Quote approved: ${o.quoteTitle}`,
      firstName: o.firstName,
      paragraphs: [
        `ILP approved your quote "${o.quoteTitle}" for ${o.memberName}.`,
        "The ILP team sends it to the member next. We email you when the member accepts it.",
      ],
      cta: { label: "Open the quote", url: o.url },
    });
  }
  return lawyerEmailLayout({
    subject: `Changes requested on your quote: ${o.quoteTitle}`,
    firstName: o.firstName,
    paragraphs: [
      `ILP asked for changes to your quote "${o.quoteTitle}" for ${o.memberName} before it goes to the member.`,
      "Open the quote, make the changes and submit it for approval again.",
    ],
    sections: o.note ? [{ title: "Note from the ILP team", lines: [o.note], list: false }] : [],
    cta: { label: "Open the quote", url: o.url },
  });
}

export function quoteAcceptedLawyerEmail(o: { firstName?: string; memberName: string; quoteTitle: string; fee: number; url: string }): MemberEmail {
  return lawyerEmailLayout({
    subject: `${o.memberName} accepted your quote: ${o.quoteTitle}`,
    firstName: o.firstName,
    paragraphs: [
      `${o.memberName} accepted your quote "${o.quoteTitle}".`,
      `Your fee on this work is ${usd(o.fee)}. It shows as pending on your Finance page until ILP pays it.`,
      "The member's CSM at ILP contacts you about the start of the work and anything the member still needs to send.",
    ],
    cta: { label: "Open Finance", url: o.url },
  });
}

export function payoutEmail(o: { firstName?: string; items: Array<{ label: string; amount: number; date: string | null }>; url: string }): MemberEmail {
  const total = o.items.reduce((s, i) => s + i.amount, 0);
  return lawyerEmailLayout({
    subject: `ILP recorded a payment to you: ${usd(total)}`,
    firstName: o.firstName,
    paragraphs: [
      `ILP recorded a payment of ${usd(total)} to you.`,
      "How long it takes to reach your account depends on your bank. Finance shows each payment and what is still pending.",
    ],
    sections: [{ title: "Paid", lines: o.items.map((i) => `${i.label}: ${usd(i.amount)}${i.date ? `, paid on ${i.date}` : ""}`), list: true }],
    cta: { label: "Open Finance", url: o.url },
  });
}

// ─── Weekly digest ─────────────────────────────────────────────────────────

export interface DigestInput {
  firstName?: string;
  weekLabel: string;
  calls: Array<{ when: string; memberName: string; matter: string | null }>;
  summaries: Array<{ memberName: string; when: string }>;
  quotes: Array<{ title: string; memberName: string; status: string }>;
  offers: number;
  urls: { today: string; quotes: string; work: string };
}

export function digestSubject(i: Pick<DigestInput, "calls" | "summaries" | "quotes">): string {
  const parts = [plural(i.calls.length, "call")];
  if (i.summaries.length) parts.push(`${plural(i.summaries.length, "summary", "summaries")} to confirm`);
  if (i.quotes.length) parts.push(plural(i.quotes.length, "open quote"));
  return `Your ILP week: ${parts.join(", ")}`;
}

export function weeklyDigestEmail(i: DigestInput): MemberEmail {
  return lawyerEmailLayout({
    subject: digestSubject(i),
    firstName: i.firstName,
    paragraphs: [`Here is your ILP week, ${i.weekLabel}.`],
    sections: [
      { title: `Calls this week (${i.calls.length})`, lines: i.calls.length ? i.calls.map((c) => `${c.when}: ${c.memberName}${c.matter ? `, ${c.matter}` : ""}`) : ["No calls booked yet. Members book inside your weekly hours."], list: i.calls.length > 0 },
      ...(i.summaries.length ? [{ title: `Summaries to confirm (${i.summaries.length})`, lines: i.summaries.map((s) => `${s.memberName}, call of ${s.when}`), list: true }] : []),
      ...(i.quotes.length ? [{ title: `Open quotes (${i.quotes.length})`, lines: i.quotes.map((q) => `${q.title} for ${q.memberName}: ${q.status}`), list: true }] : []),
      ...(i.offers ? [{ title: "Work offered to you", lines: [`${plural(i.offers, "offer")} waiting for your answer on the New work page.`], list: false }] : []),
    ],
    cta: { label: "Open Today", url: i.urls.today },
  });
}

// ─── Profile incomplete ────────────────────────────────────────────────────

export function profileIncompleteEmail(o: { firstName?: string; approvedOn: string; missing: string[]; profileUrl: string }): MemberEmail {
  return lawyerEmailLayout({
    subject: "Finish your ILP profile so members can reach you",
    firstName: o.firstName,
    paragraphs: [
      `ILP approved you as a partner lawyer on ${o.approvedOn}. Some parts of your profile are still empty, and the matching uses them to send members to you.`,
      "Each one takes a few minutes in the portal.",
    ],
    sections: [{ title: "Still to fill in", lines: o.missing, list: true }],
    cta: { label: "Open your profile", url: o.profileUrl },
  });
}

// ─── Licence expiring ──────────────────────────────────────────────────────

export function licenceExpiringEmail(o: { firstName?: string; country: string; body: string; expiresOn: string; days: number; teamEmail: string }): MemberEmail {
  return lawyerEmailLayout({
    subject: `Your licence in ${o.country} expires on ${o.expiresOn}`,
    firstName: o.firstName,
    paragraphs: [
      `Our records show that your registration with the ${o.body} for ${o.country} runs out on ${o.expiresOn}, in ${plural(o.days, "day")}.`,
      `Once you renew it, send the new expiry date or a certificate of good standing to ${o.teamEmail}, and we update your profile.`,
      "Members in that country are matched only to lawyers whose licence we have verified, so an out-of-date licence can stop new members reaching you there.",
    ],
  });
}

// ─── Work offered in the lawyer's specialty ────────────────────────────────

export function workOfferEmail(o: { firstName?: string; title: string; area: string; country: string; description?: string | null; respondBy: string | null; url: string }): MemberEmail {
  return lawyerEmailLayout({
    subject: `Paid work in your specialty: ${o.area}, ${o.country}`,
    firstName: o.firstName,
    paragraphs: [
      `An ILP member in ${o.country} needs legal work in ${o.area}: ${o.title}. We are offering it to partner lawyers whose specialty and licence fit.`,
      `Accept or decline it on the New work page${o.respondBy ? ` by ${o.respondBy}` : ""}. The first lawyer to accept takes it, and we tell the others it is taken. If you accept, the ILP team introduces you to the member and you scope the quote.`,
    ],
    sections: o.description ? [{ title: "About the work", lines: [o.description], list: false }] : [],
    cta: { label: "Open New work", url: o.url },
  });
}

// ─── Feedback program ──────────────────────────────────────────────────────

export interface MonthlyFeedbackInput {
  firstName?: string;
  monthLabel: string; // "October 2026"
  recognition: boolean;
  reviewsInMonth: number;
  periodLabel: string; // "October 2026" or "the last 90 days"
  averageStars: number | null;
  comments: string[];
  tooFewToShow: boolean;
  minReviewsToShowDetail: number;
  feedbackUrl: string;
}

const starsLabel = (n: number) => `${n.toFixed(1)} of 5 stars`;

export function monthlyFeedbackEmail(i: MonthlyFeedbackInput): MemberEmail {
  const counts = `In ${i.monthLabel} members reviewed ${i.reviewsInMonth === 1 ? "one of your calls" : `${i.reviewsInMonth} of your calls`}.`;
  const stats = i.tooFewToShow
    ? `We show the star average and comments once there are at least ${i.minReviewsToShowDetail} reviews, so no single member can be picked out. They will appear in a later email.`
    : `Over ${i.periodLabel}, your calls average ${starsLabel(i.averageStars ?? 0)}.`;
  return lawyerEmailLayout({
    subject: i.recognition ? `Thank you: your ILP member feedback for ${i.monthLabel}` : `Your ILP member feedback for ${i.monthLabel}`,
    firstName: i.firstName,
    paragraphs: [
      counts,
      stats,
      ...(i.recognition ? ["Members rate your calls highly. Thank you. Calls like yours are a large part of why members stay with ILP."] : []),
    ],
    sections: !i.tooFewToShow && i.comments.length
      ? [{ title: "What members wrote", lines: i.comments, list: true }]
      : [],
    cta: { label: "Open Feedback in the portal", url: i.feedbackUrl },
    notes: ["Comments are edited to remove names and contact details. Only you and the ILP team see this feedback, and members never see star scores."],
  });
}

export function coachingEmail(o: {
  firstName?: string;
  themes: Array<{ label: string; tip: string }>;
  averageStars: number | null;
  periodLabel: string;
  teamEmail: string;
  feedbackUrl: string;
}): MemberEmail {
  return lawyerEmailLayout({
    subject: "Your recent ILP member feedback, and an offer of a call",
    firstName: o.firstName,
    paragraphs: [
      "Some recent member reviews of your calls point to things that could go better. We would like to help, and we send this to every partner lawyer whose reviews dip, so you see what members tell us.",
      ...(o.averageStars != null ? [`Over ${o.periodLabel}, your calls average ${starsLabel(o.averageStars)}.`] : []),
    ],
    sections: [
      { title: "What members mentioned, and what tends to help", lines: o.themes.map((t) => `${t.label}: ${t.tip}`), list: true },
      {
        title: "A call with the ILP team",
        lines: [`We can go through the feedback with you in a short call and share what works well on other ILP calls. Write to ${o.teamEmail} and we will find a time that suits you.`],
        list: false,
      },
    ],
    cta: { label: "Open Feedback in the portal", url: o.feedbackUrl },
    notes: ["Comments are edited to remove names and contact details. Only you and the ILP team see this feedback, and members never see star scores."],
  });
}
