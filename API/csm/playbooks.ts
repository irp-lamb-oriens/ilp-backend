/**
 * API/csm/playbooks.ts — CSM playbooks and their template emails (COMMS-P3).
 * ──────────────────────────────────────────────────────────────────────────
 * A playbook is a short checklist for one recurring moment (welcome call,
 * renewal, payment failed, no-show) plus one email the CSM can send from
 * the member page. Defaults live here; admins and CSMs may edit the email
 * subject and paragraphs (csm_playbooks/<id>). The steps stay in code so
 * every CSM follows the same order.
 *
 * Email classes follow COMMS-P1 (API/retention/mailer.ts):
 *   payment_failed  transactional (about money owed: always sent)
 *   welcome_call, renewal, no_show  service (stopped only by the reminder unsubscribe)
 * Placeholders in the text: {{firstName}}, {{csmName}}, {{periodEnd}}, {{bookUrl}}, {{moneyUrl}}.
 */

import get from "../../db/get.ts";
import put from "../../db/put.ts";
import { COLLECTIONS, type CsmPlaybookId, CSM_PLAYBOOK_IDS } from "../../schemas/contracts.ts";
import { type MemberEmail, memberEmailLayout } from "../../helper/emailTemplates.ts";
import type { EmailClass } from "../retention/mailer.ts";

export interface PlaybookEmail {
  subject: string;
  paragraphs: string[];
  cta?: { label: string; path: string };
}

export interface Playbook {
  id: CsmPlaybookId;
  title: string;
  when: string;
  steps: string[];
  emailClass: EmailClass;
  email: PlaybookEmail;
  /** True when staff changed the email from the default. */
  edited?: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

export const DEFAULT_PLAYBOOKS: Record<CsmPlaybookId, Playbook> = {
  welcome_call: {
    id: "welcome_call",
    title: "Welcome call",
    when: "Within one business day of a member joining.",
    steps: [
      "Read the join answers and the free check results on the member page.",
      "Call the member. Introduce yourself as their contact at ILP and confirm the best way and time to reach them.",
      "Go through the profile together and fill in what is missing until it reaches 70% (consultation-ready).",
      "Help them write the question for their first call and book it.",
      "Log the call with one line on what you agreed, and close the onboarding task with that outcome.",
    ],
    emailClass: "service",
    email: {
      subject: "Welcome to ILP, {{firstName}}",
      paragraphs: [
        "I am {{csmName}}, your contact at ILP. I look after your membership and make sure each call with your lawyer is useful.",
        "Your membership includes up to 60 minutes a month with a lawyer licensed in your country, in up to three 20-minute calls.",
        "Before your first call, please finish your profile. With it, your lawyer can answer your question instead of asking for background. If you prefer, reply to this email with a good time and I will call you to fill it in together.",
      ],
      cta: { label: "Finish your profile", path: "/status/profile" },
    },
  },
  renewal: {
    id: "renewal",
    title: "Renewal check-in",
    when: "About a week before the membership renews.",
    steps: [
      "Check minutes and calls used this period, open quotes and deadlines coming up.",
      "If the member used no calls, offer to book one on a topic from their profile or deadlines.",
      "Send the renewal check-in email, or call if the health score is At risk.",
      "Log the contact and close the renewal task with what the member said.",
    ],
    emailClass: "service",
    email: {
      subject: "Your ILP membership renews on {{periodEnd}}",
      paragraphs: [
        "Your membership renews on {{periodEnd}}. Nothing changes for you: your calls and your profile stay as they are.",
        "If there is a question you have been meaning to ask, this is a good moment to book a call. Your lawyer can also check the dates on your deadlines list.",
        "If something is not working for you, reply to this email. I read every reply.",
      ],
      cta: { label: "Book a call", path: "/status/book" },
    },
  },
  payment_failed: {
    id: "payment_failed",
    title: "Payment failed",
    when: "The day a membership payment fails.",
    steps: [
      "Check the payment page on the member record: card or manual payment, and the date access pauses.",
      "Call the member the same day. Many failures are an expired card.",
      "Send the payment email with the link to update the card or pay by transfer.",
      "Log the contact and close the payment task once the member has paid or told you their plan.",
    ],
    emailClass: "transactional",
    email: {
      subject: "Your ILP payment did not go through",
      paragraphs: [
        "Your last membership payment did not go through. This often happens when a card expires or the bank blocks a charge abroad.",
        "You can update your card or pay by bank transfer from your money page. Your calls and profile stay as they are while you sort it out.",
        "If you have any trouble, reply to this email and I will help.",
      ],
      cta: { label: "Update your payment", path: "/status/money" },
    },
  },
  no_show: {
    id: "no_show",
    title: "Missed call",
    when: "The day a member misses a booked call.",
    steps: [
      "Check with the lawyer that the call did not happen and whether the member wrote in.",
      "Write to the member the same day with a link to book again.",
      "If this is the second missed call, call the member to find a time that works.",
      "Log the contact. Ask staff to give the minutes back if the miss was not the member's fault.",
    ],
    emailClass: "service",
    email: {
      subject: "We missed you on your ILP call",
      paragraphs: [
        "Your lawyer waited for you on today's call, but it did not start. We hope everything is all right.",
        "You can book a new time from your ILP home. If the time or the link was a problem, reply to this email and I will set it up with you.",
      ],
      cta: { label: "Book a new time", path: "/status/book" },
    },
  },
};

export const isPlaybookId = (v: unknown): v is CsmPlaybookId => CSM_PLAYBOOK_IDS.includes(v as CsmPlaybookId);

/** Pure: check an edit. Returns the cleaned email or an error message. */
export function validatePlaybookEmail(body: unknown): { ok: true; email: PlaybookEmail } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const subject = typeof b.subject === "string" ? b.subject.trim() : "";
  const paragraphs = Array.isArray(b.paragraphs) ? b.paragraphs.map((p) => String(p ?? "").trim()).filter(Boolean) : [];
  if (!subject || subject.length > 140) return { ok: false, error: "Write a subject of up to 140 characters." };
  if (!paragraphs.length || paragraphs.length > 6) return { ok: false, error: "Write between one and six paragraphs." };
  if (paragraphs.some((p) => p.length > 900)) return { ok: false, error: "Keep each paragraph under 900 characters." };
  if (/[–—]/.test(subject + paragraphs.join(" "))) return { ok: false, error: "Use a period, comma or colon instead of a long dash." };
  return { ok: true, email: { subject, paragraphs } };
}

/** The playbook with any saved email edit. */
export async function loadPlaybook(id: CsmPlaybookId): Promise<Playbook> {
  const base = DEFAULT_PLAYBOOKS[id];
  const saved = (await get(COLLECTIONS.csmPlaybooks, id).catch(() => null)) as Record<string, unknown> | null;
  if (!saved || typeof saved.subject !== "string" || !Array.isArray(saved.paragraphs)) return base;
  return {
    ...base,
    email: { ...base.email, subject: saved.subject, paragraphs: (saved.paragraphs as unknown[]).map(String) },
    edited: true,
    updatedAt: typeof saved.updatedAt === "string" ? saved.updatedAt : undefined,
    updatedBy: typeof saved.updatedBy === "string" ? saved.updatedBy : undefined,
  };
}

export async function loadPlaybooks(): Promise<Playbook[]> {
  return await Promise.all(CSM_PLAYBOOK_IDS.map((id) => loadPlaybook(id)));
}

export async function savePlaybookEmail(id: CsmPlaybookId, email: PlaybookEmail, by: string): Promise<Playbook> {
  await put(COLLECTIONS.csmPlaybooks, id, { id, subject: email.subject, paragraphs: email.paragraphs, updatedAt: new Date().toISOString(), updatedBy: by });
  return await loadPlaybook(id);
}

/** Back to the default email. */
export async function resetPlaybookEmail(id: CsmPlaybookId, by: string): Promise<Playbook> {
  await put(COLLECTIONS.csmPlaybooks, id, { id, subject: null, paragraphs: null, updatedAt: new Date().toISOString(), updatedBy: by });
  return DEFAULT_PLAYBOOKS[id];
}

/** "carla.mendez@…" → "Carla Mendez". */
export function nameFromEmail(email: string): string {
  const local = (email.split("@")[0] ?? "").split(/[._-]+/).filter(Boolean);
  return local.map((p) => p[0].toUpperCase() + p.slice(1)).join(" ") || "your ILP team";
}

const fill = (text: string, vars: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? "");

/** Pure: the email a playbook sends to one member. */
export function renderPlaybookEmail(p: Playbook, vars: { firstName?: string; csmEmail: string; periodEnd?: string; siteUrl: string }): MemberEmail {
  const v: Record<string, string> = {
    firstName: vars.firstName || "there",
    csmName: nameFromEmail(vars.csmEmail),
    periodEnd: vars.periodEnd || "your renewal date",
    bookUrl: `${vars.siteUrl}/status/book`,
    moneyUrl: `${vars.siteUrl}/status/money`,
  };
  return memberEmailLayout({
    subject: fill(p.email.subject, v).replace(/\s+/g, " ").trim(),
    firstName: vars.firstName,
    paragraphs: [...p.email.paragraphs.map((x) => fill(x, v)), `${v.csmName}, your contact at ILP`],
    ...(p.email.cta ? { cta: { label: p.email.cta.label, url: `${vars.siteUrl}${p.email.cta.path}` } } : {}),
  });
}
