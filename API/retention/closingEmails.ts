/**
 * API/retention/closingEmails.ts — member emails that close a loop (COMMS-P4).
 * ──────────────────────────────────────────────────────────────────────────
 * Pure templates (no I/O), all on memberEmailLayout (greeting, legal footer,
 * "Your ILP team"). The senders live in closingLoops.ts. Class per email
 * (mailer.ts `mayEmail`):
 *
 *   manualPaymentEmail        transactional  join in manual mode: how to pay
 *   noShowMemberEmail         transactional  the member did not join a call
 *   cancelUndoneEmail         transactional  the member kept the membership
 *   membershipEndedEmail      transactional  the membership has ended
 *   invoicePaidEmail          transactional  receipt for a paid invoice
 *   lawyerAssignedMemberEmail transactional  first lawyer assigned
 *   ratingRequestEmail        service        rate the call in the ILP home
 *   missingDocumentEmail      service        a document asked for 3 days ago
 *   quoteReminderEmail        service        a quote waiting 5 days
 *   profileReadyEmail         service        profile complete: book the first call
 *
 * Service emails carry the reminder unsubscribe link.
 */

import { type MemberEmail, memberEmailLayout } from "../../helper/emailTemplates.ts";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Join in manual mode (no card): what to pay and how. `bank` is null while the bank details are not set up. */
export function manualPaymentEmail(o: {
  firstName?: string;
  totalLabel: string; // "US$179.99"
  activationLabel: string;
  monthlyLabel: string;
  reference: string;
  bank: string[] | null;
  receiptNote?: string | null;
  contactEmail: string;
  termsUrl: string;
}): MemberEmail {
  const bankText = o.bank?.length ? ["Bank transfer details:", ...o.bank].join("\n") : "";
  const bankHtml = o.bank?.length
    ? `<p style="margin:0 0 6px">Bank transfer details:</p><p style="margin:0 0 14px;padding-left:12px;border-left:2px solid #d9e1e6">${
      o.bank.map((l) => l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")).join("<br>")
    }</p>`
    : "";
  return memberEmailLayout({
    subject: "How to pay for your ILP membership",
    firstName: o.firstName,
    paragraphs: [
      `Thank you for joining ILP. Your membership starts as soon as your first payment arrives: ${o.totalLabel} (the one-time activation fee of ${o.activationLabel} plus the first month, ${o.monthlyLabel}).`,
      `Please pay by bank transfer and write ${o.reference} as the reference, so we can match the payment to you.`,
      ...(o.bank?.length ? [] : ["Your ILP team sends you the bank details by email within one business day."]),
    ],
    afterHtml: bankHtml + `<p style="margin:0 0 14px">${
      (o.receiptNote || "When you have sent the transfer, reply to this email with the receipt.").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    } We activate your membership and email you as soon as the payment is in. Questions: ${o.contactEmail}.</p>`,
    afterText: [bankText, `${o.receiptNote || "When you have sent the transfer, reply to this email with the receipt."} We activate your membership and email you as soon as the payment is in. Questions: ${o.contactEmail}.`]
      .filter(Boolean).join("\n\n"),
    links: [{ label: "Terms of Membership", url: o.termsUrl }],
  });
}

/** The member did not join a booked call. `charged`: the call counts as used. */
export function noShowMemberEmail(o: {
  firstName?: string;
  lawyerName: string;
  whenLabel: string;
  charged: boolean;
  minutes: number;
  minutesLeft?: number;
  callsLeft?: number;
  bookUrl: string;
  messagesUrl: string;
}): MemberEmail {
  const usage = o.charged
    ? `Because the call was booked and not cancelled in time, it counts as used: ${plural(o.minutes, "minute")} and one call from this month's plan.${
      typeof o.minutesLeft === "number" && typeof o.callsLeft === "number" ? ` You have ${plural(o.minutesLeft, "minute")} and ${plural(o.callsLeft, "call")} left this month.` : ""
    }`
    : "Nothing was taken from your plan for this call.";
  return memberEmailLayout({
    subject: "We missed you on your ILP call",
    firstName: o.firstName,
    paragraphs: [
      `${o.lawyerName} waited for you on your call of ${o.whenLabel}, and the call was closed after 10 minutes.`,
      usage,
      "You can book a new time in your ILP home. If something got in the way, send your team a message: they can look at giving the call back.",
    ],
    cta: { label: "Book a new time", url: o.bookUrl },
    links: [{ label: "Message your team", url: o.messagesUrl }],
  });
}

/** The member undid a cancellation: the membership keeps renewing. */
export function cancelUndoneEmail(o: { firstName?: string; renewsOn: string; amountLabel: string; byCard: boolean; moneyUrl: string }): MemberEmail {
  return memberEmailLayout({
    subject: "Your ILP membership continues",
    firstName: o.firstName,
    paragraphs: [
      "You asked us to keep your ILP membership, so it is no longer set to end.",
      o.byCard
        ? `It renews on ${o.renewsOn} for ${o.amountLabel} a month, charged to your card. We email you 7 days before each renewal.`
        : `It renews on ${o.renewsOn}. The payment for the next month, ${o.amountLabel}, is due on that date.`,
      "You can cancel again at any time from Money in your ILP home.",
    ],
    cta: { label: "Open Money", url: o.moneyUrl },
  });
}

/** The membership has ended (cancelled at period end, or by staff or the payment provider). */
export function membershipEndedEmail(o: { firstName?: string; endedOn: string; joinUrl: string; privacyUrl: string; homeUrl: string }): MemberEmail {
  return memberEmailLayout({
    subject: "Your ILP membership has ended",
    firstName: o.firstName,
    paragraphs: [
      `Your ILP membership ended on ${o.endedOn}. You are not charged again.`,
      "Calls you had booked after that date are cancelled. You can still sign in to your ILP home to see your profile, documents and deadlines, and to download a copy of your data.",
      "If you want to come back, you can join again from the pricing page at any time.",
    ],
    cta: { label: "Open your ILP home", url: o.homeUrl },
    links: [
      { label: "Your data and privacy", url: o.privacyUrl },
      { label: "Join again", url: o.joinUrl },
    ],
  });
}

/** Receipt: an invoice is now paid in full. */
export function invoicePaidEmail(o: { firstName?: string; invoiceNumber: string; amountLabel: string; paidOn: string; moneyUrl: string; contactEmail: string }): MemberEmail {
  return memberEmailLayout({
    subject: `Receipt: ILP invoice ${o.invoiceNumber} is paid`.replace(/\s+/g, " "),
    firstName: o.firstName,
    paragraphs: [
      `Thank you. Invoice ${o.invoiceNumber} for ${o.amountLabel} is paid in full as of ${o.paidOn}.`.replace(/\s+/g, " "),
      "Nothing more is due on it. You can see it, with every payment we recorded, in Money in your ILP home.",
      `If something looks wrong, reply to this email or write to ${o.contactEmail}.`,
    ],
    cta: { label: "Open Money", url: o.moneyUrl },
  });
}

/** First lawyer assigned to the member. */
export function lawyerAssignedMemberEmail(o: { firstName?: string; lawyerName: string; countryName: string; bookUrl: string; homeUrl: string }): MemberEmail {
  return memberEmailLayout({
    subject: `${o.lawyerName} is your ILP lawyer`,
    firstName: o.firstName,
    paragraphs: [
      `${o.lawyerName}, a lawyer licensed in ${o.countryName}, is now your ILP lawyer. Your calls are with them, and they see your profile before each call.`,
      "Book a call whenever you have a question. The more of your profile you fill in, the more of the call goes to your question.",
    ],
    cta: { label: "Book a call", url: o.bookUrl },
    links: [{ label: "Open your ILP home", url: o.homeUrl }],
  });
}

/** After a completed call: rate it in the ILP home (1 to 5 stars). */
export function ratingRequestEmail(o: { firstName?: string; lawyerName: string; whenLabel: string; rateUrl: string; unsubscribeUrl: string }): MemberEmail {
  return memberEmailLayout({
    subject: "How was your ILP call?",
    firstName: o.firstName,
    paragraphs: [
      `Thank you for your call with ${o.lawyerName} on ${o.whenLabel}.`,
      "Please rate it from 1 to 5 in your ILP home. It takes a few seconds, and your team reads every answer. Your lawyer does not see your name next to your rating.",
    ],
    cta: { label: "Rate your call", url: o.rateUrl },
    unsubscribeUrl: o.unsubscribeUrl,
  });
}

/** A document the member was asked for, still not uploaded 3 days later. */
export function missingDocumentEmail(o: { firstName?: string; what: string; matterTitle?: string; uploadUrl: string; messagesUrl: string; unsubscribeUrl: string }): MemberEmail {
  return memberEmailLayout({
    subject: "A document is still needed for your matter",
    firstName: o.firstName,
    paragraphs: [
      `Your next step${o.matterTitle ? ` on ${o.matterTitle}` : ""} is: ${o.what}`,
      "We have not received a document for it yet. You can upload it in Profile and documents in your ILP home (PDF, photo or Word file).",
      "If you already sent it another way, or you need help getting it, send your team a message.",
    ],
    cta: { label: "Upload a document", url: o.uploadUrl },
    links: [{ label: "Message your team", url: o.messagesUrl }],
    unsubscribeUrl: o.unsubscribeUrl,
  });
}

/** A quote sent to the member 5 days ago, not answered yet. */
export function quoteReminderEmail(o: { firstName?: string; quoteTitle?: string; sentOn: string; quoteUrl: string; messagesUrl: string; unsubscribeUrl: string }): MemberEmail {
  return memberEmailLayout({
    subject: o.quoteTitle ? `Your quote is waiting: ${o.quoteTitle}` : "Your ILP quote is waiting",
    firstName: o.firstName,
    paragraphs: [
      `We sent you a quote${o.quoteTitle ? ` for ${o.quoteTitle}` : ""} on ${o.sentOn}. It is in Money in your ILP home, where you can accept it.`,
      "If you have a question about the price or what is included, or you decided not to go ahead, send your team a message. There is no obligation.",
    ],
    cta: { label: "See the quote", url: o.quoteUrl },
    links: [{ label: "Message your team", url: o.messagesUrl }],
    unsubscribeUrl: o.unsubscribeUrl,
  });
}

/** The member's profile just became consultation-ready and no call is booked yet. */
export function profileReadyEmail(o: { firstName?: string; minutes: number; calls: number; callLengthMin: number; bookUrl: string; unsubscribeUrl: string }): MemberEmail {
  return memberEmailLayout({
    subject: "Your profile is ready: book your first call",
    firstName: o.firstName,
    paragraphs: [
      "Thank you for completing your ILP profile. Your lawyer now has what they need to prepare for your first call.",
      `Your plan includes ${plural(o.calls, "call")} of ${o.callLengthMin} minutes each month (${o.minutes} minutes in all). Pick a time that suits you.`,
    ],
    cta: { label: "Book your first call", url: o.bookUrl },
    unsubscribeUrl: o.unsubscribeUrl,
  });
}
