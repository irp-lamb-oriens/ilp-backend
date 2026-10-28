/**
 * Centralized, plain-string HTML templates for transactional email.
 * Swap in a real template engine (MJML, React Email) later without touching
 * call sites. No external API calls — pure functions.
 */

export function complianceAlertEmail(opts: {
  firstName: string;
  obligationTitle: string;
  deadlineLabel: string;
  responseUrl: string;
}): string {
  return `<!doctype html><html><body style="font-family:sans-serif;color:#18181B;line-height:1.5">
    <h2>Compliance alert</h2>
    <p>Hi ${opts.firstName},</p>
    <p><strong>${opts.obligationTitle}</strong> is coming up: <strong>${opts.deadlineLabel}</strong>.</p>
    <p><a href="${opts.responseUrl}" style="background:#18181B;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px">Respond to this alert</a></p>
    ${legacyFooter()}
  </body></html>`;
}

export function consultationConfirmationEmail(opts: {
  firstName: string;
  providerName: string;
  slotLabel: string;
  meetingUrl?: string;
}): string {
  return `<!doctype html><html><body style="font-family:sans-serif;color:#18181B;line-height:1.5">
    <h2>Consultation confirmed</h2>
    <p>Hi ${opts.firstName},</p>
    <p>Your consultation with <strong>${opts.providerName}</strong> is booked for <strong>${opts.slotLabel}</strong>.</p>
    ${opts.meetingUrl ? `<p><a href="${opts.meetingUrl}">Join the call</a></p>` : ""}
    ${legacyFooter()}
  </body></html>`;
}

export function escalationEmail(opts: {
  staffName: string;
  profileName: string;
  obligationTitle: string;
  dashboardUrl: string;
}): string {
  return `<!doctype html><html><body style="font-family:sans-serif;color:#18181B;line-height:1.5">
    <h2>Escalation: customer needs help</h2>
    <p>Hi ${opts.staffName},</p>
    <p><strong>${opts.profileName}</strong> requested help with <strong>${opts.obligationTitle}</strong>.</p>
    <p><a href="${opts.dashboardUrl}">Open the follow-up queue</a></p>
  </body></html>`;
}

// ─── P2: member lifecycle + retention emails ──────────────────────────────
// Plain and short. Calm tone, no fear-selling; legal items always "may
// require review". Each returns subject + html + text so the queue can send
// a text part too. Non-transactional messages carry an unsubscribe link.

export interface MemberEmail {
  subject: string;
  html: string;
  text: string;
}

const escHtml = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Legal footer on every member email (P6 wording, pending counsel). Keep equal
 * to EMAIL_FOOTER in frontend/src/components/legal/disclaimers.ts.
 */
export const EMAIL_FOOTER =
  "ILP is a membership service, not a law firm. Reminders and general information in this email are not legal advice; dates may require review by a licensed lawyer.";

/** Footer for the older member templates above (function declaration: hoisted). */
function legacyFooter(): string {
  return `<p style="margin:24px 0 0;font-size:13px;color:#4a5a66">${EMAIL_FOOTER}</p>`;
}

const footerHtml = () =>
  `<p style="margin:24px 0 0;font-size:13px;color:#4a5a66">${escHtml(EMAIL_FOOTER)}</p>`;

const P2_NAVY = "#123b5d";
const P2_ACCENT = "#5cccf7";

/** Shared layout: greeting, paragraphs, one optional button, optional footer lines. */
export function memberEmailLayout(opts: {
  subject: string;
  firstName?: string;
  paragraphs: string[]; // plain text; escaped here
  cta?: { label: string; url: string };
  links?: Array<{ label: string; url: string }>;
  /** Trusted extra HTML/text after the button (built by the templates below). */
  afterHtml?: string;
  afterText?: string;
  unsubscribeUrl?: string;
}): MemberEmail {
  const hello = opts.firstName ? `Hi ${opts.firstName},` : "Hello,";
  const ps = opts.paragraphs.map((p) => `<p style="margin:0 0 14px">${escHtml(p)}</p>`).join("");
  const cta = opts.cta
    ? `<p style="margin:20px 0"><a href="${escHtml(opts.cta.url)}" style="background:${P2_ACCENT};color:${P2_NAVY};padding:11px 18px;text-decoration:none;border-radius:999px;font-weight:600;display:inline-block">${escHtml(opts.cta.label)}</a></p>`
    : "";
  const links = (opts.links ?? [])
    .map((l) => `<a href="${escHtml(l.url)}" style="color:${P2_NAVY};margin-right:10px">${escHtml(l.label)}</a>`)
    .join(" ");
  const unsub = opts.unsubscribeUrl
    ? `<p style="margin:24px 0 0;font-size:13px;color:#7a8a96">You get these reminders as an ILP member. <a href="${escHtml(opts.unsubscribeUrl)}" style="color:#7a8a96">Stop reminder emails</a>. Payment and account emails still arrive.</p>`
    : "";
  const html = `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#202a33;line-height:1.55;font-size:16px;max-width:560px;margin:0 auto;padding:16px">
    <p style="margin:0 0 14px">${escHtml(hello)}</p>${ps}${cta}${links ? `<p style="margin:0 0 14px">${links}</p>` : ""}${opts.afterHtml ?? ""}
    <p style="margin:18px 0 0">Your ILP team</p>${footerHtml()}${unsub}
  </body></html>`;
  const text = [
    hello,
    "",
    ...opts.paragraphs.flatMap((p) => [p, ""]),
    ...(opts.cta ? [`${opts.cta.label}: ${opts.cta.url}`, ""] : []),
    ...(opts.links ?? []).map((l) => `${l.label}: ${l.url}`),
    ...(opts.afterText ? [opts.afterText, ""] : []),
    "Your ILP team",
    "",
    EMAIL_FOOTER,
    ...(opts.unsubscribeUrl ? ["", `Stop reminder emails: ${opts.unsubscribeUrl}`] : []),
  ].join("\n");
  return { subject: opts.subject, html, text };
}

/** Dunning: day 0, 3 and 6 after a failed membership payment. */
export function paymentFailedEmail(o: { firstName?: string; day: 0 | 3 | 6; pausesOn: string; moneyUrl: string; byCard: boolean }): MemberEmail {
  const fix = o.byCard ? "You can update your card in a minute from your Money page." : "Reply to this email or message your team and we will sort it out with you.";
  const subject = o.day === 0
    ? "Your ILP membership payment did not go through"
    : o.day === 3
    ? "Reminder: your ILP membership payment"
    : "Your ILP access pauses tomorrow";
  const lead = o.day === 0
    ? "We tried to take this month's membership payment (US$79.99) and it did not go through. This happens, often because a card expired or the bank flagged it."
    : o.day === 3
    ? "Your membership payment is still outstanding."
    : "Your membership payment is still outstanding, so your access pauses tomorrow.";
  return memberEmailLayout({
    subject,
    firstName: o.firstName,
    paragraphs: [lead, `Everything keeps working until ${o.pausesOn}. ${fix}`],
    cta: { label: o.byCard ? "Update payment" : "Open Money", url: o.moneyUrl },
  });
}

/** Day 7: booking paused. */
export function accessPausedEmail(o: { firstName?: string; moneyUrl: string; byCard: boolean }): MemberEmail {
  return memberEmailLayout({
    subject: "Your ILP membership is paused",
    firstName: o.firstName,
    paragraphs: [
      "Your membership payment is still outstanding, so booking new calls is paused for now.",
      "Your profile, documents and messages are all still there. As soon as the payment goes through, calls open again.",
    ],
    cta: { label: o.byCard ? "Update payment" : "Open Money", url: o.moneyUrl },
  });
}

/** Cancel requested: access until periodEnd, undo possible. */
export function cancellationConfirmedEmail(o: { firstName?: string; endsOn: string; moneyUrl: string }): MemberEmail {
  return memberEmailLayout({
    subject: `Your ILP membership ends on ${o.endsOn}`,
    firstName: o.firstName,
    paragraphs: [
      `We have received your request to cancel. Your membership stays fully active until ${o.endsOn}, including any calls you have booked, and you will not be charged again.`,
      "The current month is not refunded. If something went wrong, reply to this email and we will look at it.",
      `Changed your mind? You can keep your membership any time before ${o.endsOn}.`,
    ],
    cta: { label: "Keep my membership", url: o.moneyUrl },
  });
}

/**
 * Join confirmation (P6/P7): restates the automatic-renewal terms for US
 * auto-renewal laws: the monthly amount, that it renews every month until
 * cancelled, how to cancel online, and that access runs to the end of the
 * paid month. Wording pending counsel (docs/PRIVACY_AND_COMPLIANCE.md, q. 10).
 */
export function joinConfirmedEmail(o: {
  firstName?: string;
  activationLabel: string; // "US$100.00"
  monthlyLabel: string; // "US$79.99"
  renewsOn: string; // date label of the first renewal
  minutes: number;
  calls: number;
  callLengthMin: number;
  bookUrl: string;
  cancelUrl: string;
  termsUrl: string;
}): MemberEmail {
  return memberEmailLayout({
    subject: "Welcome to ILP: your membership is active",
    firstName: o.firstName,
    paragraphs: [
      `Your ILP membership is active. The one-time activation fee is ${o.activationLabel} and the membership is ${o.monthlyLabel} a month.`,
      `Your membership renews automatically every month at ${o.monthlyLabel} until you cancel. The next renewal is on ${o.renewsOn}.`,
      `You can cancel online at any time from Money in your ILP home (${o.cancelUrl}). When you cancel, you keep access until the end of the month you already paid for and you are not charged again.`,
      `Each month includes ${o.minutes} minutes with a lawyer, up to ${o.calls} calls of ${o.callLengthMin} minutes.`,
    ],
    cta: { label: "Book your first call", url: o.bookUrl },
    links: [
      { label: "Cancel or manage membership", url: o.cancelUrl },
      { label: "Terms of Membership", url: o.termsUrl },
    ],
  });
}

/** Renewal receipt: a new period started. */
export function renewalReceiptEmail(o: {
  firstName?: string;
  amountLabel: string;
  periodLabel: string;
  minutes: number;
  calls: number;
  moneyUrl: string;
  bookUrl: string;
}): MemberEmail {
  return memberEmailLayout({
    subject: `Receipt: ILP membership, ${o.periodLabel}`,
    firstName: o.firstName,
    paragraphs: [
      `Thank you. We received ${o.amountLabel} for your ILP membership, ${o.periodLabel}.`,
      `Your ${o.minutes} minutes and ${o.calls} calls for this month are ready to use.`,
    ],
    cta: { label: "Book a call", url: o.bookUrl },
    links: [{ label: "See your payments", url: o.moneyUrl }],
  });
}

// ─── P3: the call (booking, reminders, changes) ───────────────────────────

const callEsc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `member` adds the legal footer (EMAIL_FOOTER); lawyer-only emails leave it out. */
function callShell(title: string, body: string, member = false): string {
  return `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#202a33;line-height:1.6;max-width:560px">
    <h2 style="color:#123b5d;margin:0 0 12px">${callEsc(title)}</h2>${body}
    <p style="color:#4a5a66;font-size:13px;margin-top:24px">ILP International Legal Partner · times are Costa Rica time (GMT-6)</p>${member ? `
    <p style="color:#4a5a66;font-size:13px;margin-top:8px">${callEsc(EMAIL_FOOTER)}</p>` : ""}
  </body></html>`;
}

const callButton = (href: string, label: string) =>
  `<p><a href="${callEsc(href)}" style="background:#5cccf7;color:#123b5d;padding:10px 18px;text-decoration:none;border-radius:999px;font-weight:600">${callEsc(label)}</a></p>`;

const quoted = (q?: string | null) =>
  q ? `<p style="border-left:2px solid #d9e1e6;padding-left:12px;margin:12px 0">${callEsc(q).replace(/\n/g, "<br>")}</p>` : "";

/** Member: call booked. Without a Meet link, says the link follows by email. */
export function callBookedMemberEmail(o: {
  firstName: string;
  lawyerName: string;
  whenLabel: string;
  meetUrl?: string | null;
  portalUrl: string;
}): { subject: string; html: string } {
  const link = o.meetUrl
    ? `${callButton(o.meetUrl, "Join with Google Meet")}<p>The button works from 10 minutes before the call.</p>`
    : `<p>Your video link is coming by email shortly. Your ILP team is setting it up.</p>`;
  return {
    subject: `Your ILP call is booked: ${o.whenLabel}`,
    html: callShell("Your call is booked", `
      <p>Hi ${callEsc(o.firstName)},</p>
      <p>Your 20-minute call with <strong>${callEsc(o.lawyerName)}</strong> is on <strong>${callEsc(o.whenLabel)}</strong>.</p>
      ${link}
      <p>You can change or cancel it up to 24 hours before, from <a href="${callEsc(o.portalUrl)}">your ILP home</a>.</p>`, true),
  };
}

/** Lawyer: a member booked a call with you. */
export function callBookedLawyerEmail(o: {
  lawyerName: string;
  memberName: string;
  whenLabel: string;
  question?: string | null;
  briefUrl: string;
}): { subject: string; html: string } {
  return {
    subject: `New ILP call: ${o.memberName}, ${o.whenLabel}`,
    html: callShell("New call booked", `
      <p>Hi ${callEsc(o.lawyerName)},</p>
      <p><strong>${callEsc(o.memberName)}</strong> booked a 20-minute call for <strong>${callEsc(o.whenLabel)}</strong>. Their question:</p>
      ${quoted(o.question)}
      ${callButton(o.briefUrl, "Open the brief")}`),
  };
}

/** 24-hour and 1-hour reminders, for the member or the lawyer. */
export function callReminderEmail(o: {
  to: "member" | "lawyer";
  kind: "24h" | "1h";
  greetingName: string;
  otherName: string;
  whenLabel: string;
  meetUrl?: string | null;
  question?: string | null;
  briefUrl?: string;
  portalUrl?: string;
}): { subject: string; html: string } {
  const lead = o.kind === "1h" ? "in one hour" : "tomorrow";
  const join = o.meetUrl
    ? callButton(o.meetUrl, "Join with Google Meet")
    : `<p>The video link is on its way from your ILP team.</p>`;
  if (o.to === "lawyer") {
    return {
      subject: `Reminder: ${o.otherName} ${lead} (${o.whenLabel})`,
      html: callShell(`Your call with ${o.otherName} is ${lead}`, `
        <p>Hi ${callEsc(o.greetingName)},</p>
        <p>${callEsc(o.whenLabel)}, 20 minutes. The member asked:</p>
        ${quoted(o.question)}
        ${o.briefUrl ? callButton(o.briefUrl, "Read the brief") : ""}
        ${o.meetUrl ? `<p>Meet link: <a href="${callEsc(o.meetUrl)}">${callEsc(o.meetUrl)}</a></p>` : ""}`),
    };
  }
  return {
    subject: `Reminder: your ILP call is ${lead} (${o.whenLabel})`,
    html: callShell(`Your call is ${lead}`, `
      <p>Hi ${callEsc(o.greetingName)},</p>
      <p>Your 20-minute call with <strong>${callEsc(o.otherName)}</strong> is on <strong>${callEsc(o.whenLabel)}</strong>.</p>
      ${o.question ? `<p>Your question:</p>${quoted(o.question)}` : ""}
      ${join}
      <p>Have any documents you mentioned nearby. ${o.portalUrl ? `Your <a href="${callEsc(o.portalUrl)}">ILP home</a> has the details.` : ""}</p>`, true),
  };
}

/** Call moved or cancelled (sent to the member and the lawyer). */
export function callChangedEmail(o: {
  change: "rescheduled" | "cancelled";
  greetingName: string;
  otherName: string;
  oldWhenLabel: string;
  newWhenLabel?: string;
  meetUrl?: string | null;
  link: string;
  linkLabel: string;
}): { subject: string; html: string } {
  if (o.change === "cancelled") {
    return {
      subject: `ILP call cancelled: ${o.oldWhenLabel}`,
      html: callShell("Call cancelled", `
        <p>Hi ${callEsc(o.greetingName)},</p>
        <p>The call with <strong>${callEsc(o.otherName)}</strong> on ${callEsc(o.oldWhenLabel)} is cancelled. It does not count against the monthly calls.</p>
        ${callButton(o.link, o.linkLabel)}`, true),
    };
  }
  return {
    subject: `ILP call moved to ${o.newWhenLabel}`,
    html: callShell("Call moved", `
      <p>Hi ${callEsc(o.greetingName)},</p>
      <p>The call with <strong>${callEsc(o.otherName)}</strong> moved from ${callEsc(o.oldWhenLabel)} to <strong>${callEsc(o.newWhenLabel ?? "")}</strong>.</p>
      ${o.meetUrl ? `<p>Same Google Meet link: <a href="${callEsc(o.meetUrl)}">${callEsc(o.meetUrl)}</a></p>` : ""}
      ${callButton(o.link, o.linkLabel)}`, true),
  };
}

/** Obligations reaching 30 or 7 days out. Worded "may require review". */
export function obligationsDueEmail(o: {
  firstName?: string;
  items: Array<{ title: string; dueLabel: string; daysLeft: number; confirm?: boolean }>;
  askUrl: string;
  unsubscribeUrl: string;
  /** DEADLINES: a free account (no membership): no "ask your lawyer" offer, a link to their Deadlines page. */
  free?: boolean;
}): MemberEmail {
  const soon = o.items.some((i) => i.daysLeft <= 7);
  // `confirm`: a low-confidence research date. No firm date is shown; the lawyer confirms it.
  const list = o.items.map((i) =>
    i.confirm
      ? `${i.title}. Ask your lawyer to confirm this date.`
      : `${i.title}, by ${i.dueLabel} (${i.daysLeft === 0 ? "today" : i.daysLeft === 1 ? "tomorrow" : `in ${i.daysLeft} days`})`
  );
  return memberEmailLayout({
    subject: soon ? "A date that may require review this week" : "Coming up: dates that may require review",
    firstName: o.firstName,
    paragraphs: [
      o.items.length === 1 ? `A date on your ILP ${o.free ? "deadlines list" : "profile"} is coming up and may require review:` : `Some dates on your ILP ${o.free ? "deadlines list" : "profile"} are coming up and may require review:`,
      ...list,
      o.free
        ? "Not every date applies to everyone. You saved this list from the free ILP check. You can change a date, turn reminders off or remove an item on your Deadlines page. ILP members can ask a lawyer licensed in their country whether a date applies to them."
        : "Not every date applies to everyone. If you are not sure whether this one applies to you, ask your lawyer. It is part of your membership.",
    ],
    cta: o.free ? { label: "See my deadlines", url: o.askUrl } : { label: "Ask my lawyer", url: o.askUrl },
    unsubscribeUrl: o.unsubscribeUrl,
  });
}

/** Monthly check-in on the membership anniversary, with a 0-10 question. */
export function monthlyCheckInEmail(o: {
  firstName?: string;
  minutesLeft: number;
  minutesIncluded: number;
  callsLeft: number;
  renewsOn: string;
  bookUrl: string;
  scoreUrl: (n: number) => string;
  feedbackUrl: string;
  unsubscribeUrl: string;
}): MemberEmail {
  const cells = Array.from({ length: 11 }, (_, n) =>
    `<a href="${escHtml(o.scoreUrl(n))}" style="display:inline-block;min-width:28px;padding:8px 0;margin:0 2px 4px 0;text-align:center;border:1px solid #d9e1e6;border-radius:6px;color:${P2_NAVY};text-decoration:none">${n}</a>`
  ).join("");
  return memberEmailLayout({
    subject: "Your month with ILP",
    firstName: o.firstName,
    paragraphs: [
      `You have ${o.minutesLeft} of ${o.minutesIncluded} minutes and ${o.callsLeft} ${o.callsLeft === 1 ? "call" : "calls"} left until ${o.renewsOn}.`,
      "If anything has changed (a move, a property, a visa date), a short call is the easiest way to check what applies.",
    ],
    cta: { label: "Book a call", url: o.bookUrl },
    afterHtml: `<p style="margin:18px 0 8px">One question: how likely are you to recommend ILP to a friend living abroad? (0 = not at all, 10 = very likely)</p><p style="margin:0 0 14px">${cells}</p>`,
    afterText: `One question: how likely are you to recommend ILP to a friend living abroad (0-10)? Answer here: ${o.feedbackUrl}`,
    unsubscribeUrl: o.unsubscribeUrl,
  });
}

/** Five days after joining with no call booked. */
export function bookingNudgeEmail(o: { firstName?: string; minutes: number; calls: number; bookUrl: string; unsubscribeUrl: string }): MemberEmail {
  return memberEmailLayout({
    subject: "Your first ILP call is ready when you are",
    firstName: o.firstName,
    paragraphs: [
      `Your membership includes ${o.minutes} minutes and up to ${o.calls} calls this month. Most members start with one 20-minute call to go over what may apply to them.`,
      "Pick a time that suits you and tell us what you would like to ask. Your lawyer reads your profile before the call.",
    ],
    cta: { label: "Book a call", url: o.bookUrl },
    unsubscribeUrl: o.unsubscribeUrl,
  });
}

/** A matter's next step changed. */
export function nextStepChangedEmail(o: {
  firstName?: string;
  matterTitle?: string;
  what: string;
  whoLabel: string;
  dueLabel?: string;
  homeUrl: string;
  unsubscribeUrl: string;
}): MemberEmail {
  return memberEmailLayout({
    subject: o.matterTitle ? `Next step on ${o.matterTitle}` : "Your next step with ILP",
    firstName: o.firstName,
    paragraphs: [
      o.matterTitle ? `There is a new next step on ${o.matterTitle}:` : "There is a new next step on your ILP account:",
      o.what,
      `Who: ${o.whoLabel}.${o.dueLabel ? ` By: ${o.dueLabel}.` : ""}`,
    ],
    cta: { label: "See it in your ILP home", url: o.homeUrl },
    unsubscribeUrl: o.unsubscribeUrl,
  });
}
