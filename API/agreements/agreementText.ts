/**
 * API/agreements/agreementText.ts
 * ──────────────────────────────────────────────────────────────────────────
 * The Membership Agreement a member signs at join (AGREEMENT). One source of
 * truth: the join form shows these sections (GET /api/agreements/membership)
 * and the signed PDF prints them, so what was shown is what was signed.
 *
 * DRAFT pending ILP's counsel, like every legal text (docs/PRIVACY_AND_COMPLIANCE.md).
 * When the text changes, bump AGREEMENT_VERSION: each signature stores the
 * version it signed.
 */
import { PLAN_STANDARD } from "../../schemas/contracts.ts";

export const AGREEMENT_VERSION = "membership-agreement-2026-11-11-draft1";

export const agreementEntity = () => Deno.env.get("AGREEMENT_ENTITY")?.trim() || "International Legal Partner LLC";
export const agreementEntityAddress = () => Deno.env.get("AGREEMENT_ENTITY_ADDRESS")?.trim() || "Miami, Florida, U.S.A.";

const usd = (cents: number) => `US$${(cents / 100).toFixed(2).replace(/\.00$/, "")}`;

export interface AgreementSection {
  heading: string;
  body: string[];
}

export function agreementTitle(): string {
  return "ILP Membership Agreement";
}

/** The agreement's sections. `site` is the public site URL for the links it names. */
export function agreementSections(site: string): AgreementSection[] {
  const monthly = usd(PLAN_STANDARD.monthlyCents);
  const activation = usd(PLAN_STANDARD.activationCents);
  return [
    {
      heading: "1. Who agrees to what",
      body: [
        `This agreement is between ${agreementEntity()} ("ILP") and the member who signs below ("you"). It starts when you sign it and your first payment is confirmed.`,
        `It works together with the Terms of Membership (${site}/terms) and the Privacy Policy (${site}/privacy). If this agreement and the Terms say different things, the Terms decide.`,
      ],
    },
    {
      heading: "2. What ILP is",
      body: [
        "ILP is a membership service. ILP is not a law firm and does not give legal advice. ILP connects you with independent lawyers licensed in the country your membership covers, keeps your legal profile and dates in one place, and follows up with you.",
        "The lawyers are independent professionals. They are responsible for the advice they give you. Information from ILP staff or from ILP's AI assistant is general information, not legal advice.",
      ],
    },
    {
      heading: "3. What your membership includes",
      body: [
        `Each paid month includes up to ${PLAN_STANDARD.minutesIncluded} minutes of video calls with a lawyer, in up to ${PLAN_STANDARD.callsIncluded} calls of ${PLAN_STANDARD.callLengthMin} minutes. Unused minutes do not carry over to the next month.`,
        "It also includes your ILP home: your profile, your documents, your dates and reminders, your messages with the ILP team, and a customer success manager who follows up after each call.",
        "Dates and reminders are general and may require review by your lawyer. You remain responsible for your own legal deadlines.",
      ],
    },
    {
      heading: "4. Legal work beyond a call",
      body: [
        "Drafting, filings, representation and other legal work are not part of the membership. They are quoted to you separately, in writing, before any work starts. You owe nothing for that work until you accept its quote.",
      ],
    },
    {
      heading: "5. Price and automatic renewal",
      body: [
        `You pay a one-time activation fee of ${activation} and ${monthly} for your first month when you join. Taxes are added where the law requires them.`,
        `Your membership renews automatically every month at ${monthly} until you cancel. Each renewal is charged to the payment method you gave, on the same day of the month you joined or the nearest day.`,
        "If ILP changes the price, ILP tells you by email at least 30 days before the change applies to you.",
        "If a payment fails, ILP tells you and tries again. After 7 days without payment, your calls and booking pause until the payment is made.",
      ],
    },
    {
      heading: "6. How to cancel",
      body: [
        `You can cancel at any time, online, in your ILP home (${site}/status/money/cancel), without calling anyone. Your membership then stays active until the end of the month you already paid, and it does not renew.`,
        "The activation fee and months already paid are not refunded, unless the law where you live gives you that right or the Terms say otherwise.",
      ],
    },
    {
      heading: "7. Your information",
      body: [
        "ILP and your lawyers use the information and documents you give to provide the membership, as the Privacy Policy explains. Calls are recorded or transcribed only if you say yes for that call.",
        `You can download your data, correct it or ask ILP to delete it in your ILP home (${site}/status/privacy).`,
      ],
    },
    {
      heading: "8. Signing electronically",
      body: [
        "You sign this agreement by typing your full name and confirming. You agree that this electronic signature has the same effect as a signature on paper, and that ILP may send you this agreement and notices about it by email.",
        "ILP keeps a record of your signature: the name you typed, the date and time, the version of this agreement, and the internet address and browser used. A copy of the signed agreement is kept in your ILP home under Documents.",
      ],
    },
  ];
}

/** Plain-text of the whole agreement: hashed into each signature so the signed text can be proven. */
export function agreementPlainText(site: string): string {
  return [agreementTitle(), `Version ${AGREEMENT_VERSION}`, ...agreementSections(site).flatMap((s) => [s.heading, ...s.body])].join("\n");
}
