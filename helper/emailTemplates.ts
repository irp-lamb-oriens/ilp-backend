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

const P2_NAVY = "#123b5d";
const P2_ACCENT = "#5cccf7";

/** Shared layout: greeting, paragraphs, one optional button, optional footer lines. */
export function memberEmailLayout(opts: {
  subject: string;
  firstName?: string;
  paragraphs: string[]; // plain text; escaped here
  cta?: { label: string; url: string };
  links?: Array<{ label: string; url: string }>;
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
    <p style="margin:0 0 14px">${escHtml(hello)}</p>${ps}${cta}${links ? `<p style="margin:0 0 14px">${links}</p>` : ""}
    <p style="margin:18px 0 0">Your ILP team</p>${unsub}
  </body></html>`;
  const text = [
    hello,
    "",
    ...opts.paragraphs.flatMap((p) => [p, ""]),
    ...(opts.cta ? [`${opts.cta.label}: ${opts.cta.url}`, ""] : []),
    ...(opts.links ?? []).map((l) => `${l.label}: ${l.url}`),
    "Your ILP team",
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
