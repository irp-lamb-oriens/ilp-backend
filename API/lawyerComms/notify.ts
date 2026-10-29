/**
 * API/lawyerComms/notify.ts — keeping partner lawyers informed (COMMS-P2).
 * ──────────────────────────────────────────────────────────────────────────
 * Event emails (each sent once per key; never throw):
 *   sendMemberAssigned(clientId, providerId)      assignMember: a member is now theirs (profile summary)
 *   sendSummaryReady(call, drafted)               callReminders: transcript picked up, summary to confirm
 *   summaryFollowups(now)                         callReminders: 24 h reminder, then a CSM task 24 h later
 *   notifyQuoteDecision(clientId, quote, ...)     staff approved or asked for changes
 *   notifyQuoteAccepted(clientId, quote)          onQuoteAccepted: their fee, pending
 *   notifyPayouts(before, after)                  settlement saved: newly paid rows
 * Sweeps (jobs/registry.ts):
 *   weeklyDigest(now)                             Mondays: calls this week, summaries to confirm, open quotes, offers
 *   profileIncompleteSweep(now)                   3 days after approval, once, when profile parts are empty
 *   licenceExpirySweep(now)                       60 and 30 days before a licence expiry, lawyer and staff
 *
 * Lawyer emails are service or transactional (partners): no marketing gate.
 * Placeholder (seed) lawyers or members never produce an email.
 */

import get from "../../db/get.ts";
import getAll from "../../db/getAll.ts";
import query from "../../db/query.ts";
import log from "../../helper/log.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import { isPlaceholderDoc, isPlaceholderId } from "../../helper/placeholder.ts";
import { TEAM_CC } from "../../helper/team.ts";
import type { MemberEmail } from "../../helper/emailTemplates.ts";
import {
  COLLECTIONS,
  type Consultation,
  COUNTRIES,
  type LawyerLicence,
  type Matter,
  SALES_TEAM_ID,
  toCountryCode,
  type WorkOffer,
} from "../../schemas/contracts.ts";
import { findRecords, memberBundle, updateRecord } from "../members/service.ts";
import { emitEvent } from "../members/events.ts";
import { isProviderBookable } from "../providers/applyLogic.ts";
import { buildPreCallBrief } from "../routing/precall.ts";
import { notifyStaff } from "../routing/notifications.ts";
import { channelFor, notify } from "../notifications/store.ts"; // COMMS-P3
import { DOCUMENTS_COLLECTION } from "../../helper/storage.ts";
import { lawyerBriefUrl, lawyerTimeZone, whenLabel } from "../calls/callService.ts";
import { queueKey } from "../retention/mailer.ts";
import {
  licenceExpiringEmail,
  memberAssignedEmail,
  payoutEmail,
  profileIncompleteEmail,
  quoteAcceptedLawyerEmail,
  quoteDecisionEmail,
  summaryReadyEmail,
  weeklyDigestEmail,
} from "./emails.ts";

type Doc = Record<string, unknown>;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export const frontend = () => (Deno.env.get("FRONTEND_URL") ?? "http://localhost:3000").replace(/\/$/, "");
export const lawyerUrl = (path = "") => `${frontend()}/lawyer${path}`;

/** Where lawyers write to ILP (licence renewals, coaching calls): LAWYER_TEAM_EMAIL, else DEFAULT_CSM_EMAIL, else TEAM_CC. */
export function lawyerTeamEmail(): string {
  return str(Deno.env.get("LAWYER_TEAM_EMAIL")) ?? str(Deno.env.get("DEFAULT_CSM_EMAIL")) ?? TEAM_CC;
}

export interface LawyerContact {
  providerId: string;
  email: string;
  name: string;
  firstName: string;
  placeholder: boolean;
  doc: Doc;
}

export async function lawyerContact(providerId: string | null | undefined, doc?: Doc | null): Promise<LawyerContact | null> {
  if (!providerId || providerId === SALES_TEAM_ID) return null;
  const p = doc ?? ((await get("providers", providerId).catch(() => null)) as Doc | null);
  const email = str(p?.email)?.toLowerCase();
  if (!p || !email) return null;
  const name = str(p.name) ?? email;
  return { providerId, email, name, firstName: name.split(/\s+/)[0], placeholder: isPlaceholderId(providerId) || isPlaceholderDoc(p), doc: p };
}

/** "Grace Whitfield" from a client doc. */
export function memberNameOf(c: Doc | null | undefined): string {
  if (!c) return "An ILP member";
  const p = { ...((c.profile as Doc) ?? {}), ...c };
  return str(p.fullName) ?? ([str(p.name), str(p.surname)].filter(Boolean).join(" ") || "An ILP member");
}

/**
 * Queue one lawyer email once per key (an existing queue doc, sent or not,
 * means it already went). Returns true when queued now.
 */
export async function sendLawyerOnce(key: string, to: LawyerContact, mail: MemberEmail, placeholder = false): Promise<boolean> {
  const k = queueKey(`lawyer_${key}`);
  if (await get("email_queue", `dedupe_${k}`).catch(() => null)) return false;
  if (to.placeholder || placeholder) {
    log(`[lawyerComms] skipped ${key}: placeholder record`, "lawyerComms");
    return false;
  }
  await enqueueEmail({ to: to.email, subject: mail.subject, html: mail.html, text: mail.text }, k);
  log(`[lawyerComms] queued ${key} → ${to.providerId}`, "lawyerComms");
  return true;
}

const dateLabel = (iso: string | null | undefined) => {
  if (!iso) return "";
  // A plain date ("2026-10-30") is that calendar day, not UTC midnight.
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00.000Z` : iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Costa_Rica" });
};

// ─── New member assigned ───────────────────────────────────────────────────

export async function sendMemberAssigned(clientId: string, providerId: string, at = new Date()): Promise<boolean> {
  try {
    const to = await lawyerContact(providerId);
    if (!to) return false;
    const [b, documents] = await Promise.all([
      memberBundle(clientId),
      query(DOCUMENTS_COLLECTION, [{ field: "clientId", op: "EQUAL", value: clientId }]).catch(() => []) as Promise<Doc[]>,
    ]);
    const matter = b.matters.find((m) => !m.closedAt && (m.assignedProviderId === providerId || !m.assignedProviderId)) ?? b.matters.find((m) => !m.closedAt) ?? null;
    const intake = ((b.membership as Doc | null)?.intake ?? null) as Doc | null;
    const brief = buildPreCallBrief({
      consultation: { id: "", clientId, matterId: matter?.id, providerId, question: str(intake?.question) ?? (matter as Doc | null)?.question as string ?? null, scheduledAt: at.toISOString() },
      client: b.client,
      matters: b.matters,
      obligations: b.obligations,
      consultations: b.consultations,
      handoffs: b.handoffs,
      documents,
      lang: "en",
      now: at,
    });
    const mail = memberAssignedEmail({ firstName: to.firstName, brief, portalUrl: lawyerUrl("/clients") });
    const placeholder = isPlaceholderId(clientId) || isPlaceholderDoc(b.client);
    // COMMS-P3: the lawyer's bell too (first name only, like the email).
    await notify({ key: `lawyer_member_assigned_${clientId}_${providerId}_${at.toISOString().slice(0, 13)}`, kind: "member.assigned", to: channelFor("lawyer", providerId), title: `New member assigned to you: ${memberNameOf(b.client)}`, link: "/lawyer/clients", severity: "action", placeholder });
    return await sendLawyerOnce(`member_assigned_${clientId}_${providerId}_${at.toISOString().slice(0, 13)}`, to, mail, placeholder);
  } catch (err) {
    log(`[lawyerComms] member assigned ${clientId} → ${providerId} failed: ${err instanceof Error ? err.message : err}`, "error");
    return false;
  }
}

// ─── Summary ready to confirm ──────────────────────────────────────────────

type CallDoc = Consultation & { summaryReadyAt?: string; summaryNotices?: string[] };

async function summaryMail(c: CallDoc, reminder: boolean, drafted: boolean) {
  const to = await lawyerContact(c.providerId);
  if (!to) return null;
  const client = (await get(COLLECTIONS.clients, c.clientId).catch(() => null)) as Doc | null;
  const tz = await lawyerTimeZone(c.providerId, to.doc);
  const mail = summaryReadyEmail({ firstName: to.firstName, memberName: memberNameOf(client), callWhen: whenLabel(c.scheduledAt, tz), drafted, callUrl: lawyerBriefUrl(c.id), reminder });
  return { to, mail, placeholder: isPlaceholderDoc(c) || isPlaceholderId(c.clientId) || isPlaceholderDoc(client) };
}

/** The transcript came in (Meet pickup): tell the lawyer the summary is ready to confirm. Once per call. */
export async function sendSummaryReady(c: CallDoc, drafted: boolean, now = new Date()): Promise<boolean> {
  if (c.kind === "sales" || c.summary?.status === "confirmed" || (c.summaryNotices ?? []).includes("ready")) return false;
  try {
    const m = await summaryMail(c, false, drafted);
    if (!m) return false;
    const sent = await sendLawyerOnce(`summary_ready_${c.id}`, m.to, m.mail, m.placeholder);
    await updateRecord(COLLECTIONS.consultations, c.id, { summaryReadyAt: now.toISOString(), summaryNotices: [...new Set([...(c.summaryNotices ?? []), "ready"])] });
    return sent;
  } catch (err) {
    log(`[lawyerComms] summary ready ${c.id} failed: ${err instanceof Error ? err.message : err}`, "error");
    return false;
  }
}

/** Pure: which follow-up a call with a summary waiting is due for. */
export function summaryFollowupDue(c: Pick<CallDoc, "summaryReadyAt" | "summaryNotices" | "summary" | "status" | "kind">, now: Date): "reminder" | "escalate" | null {
  if (!c.summaryReadyAt || c.kind === "sales" || c.summary?.status === "confirmed") return null;
  if (c.status === "cancelled" || c.status === "no_show") return null;
  const age = now.getTime() - Date.parse(c.summaryReadyAt);
  const done = c.summaryNotices ?? [];
  if (age >= 48 * HOUR && !done.includes("escalated")) return "escalate";
  if (age >= 24 * HOUR && !done.includes("reminder") && !done.includes("escalated")) return "reminder";
  return null;
}

/** 24 h after "summary ready": remind the lawyer; 48 h: a CSM task (call.summary_unconfirmed). */
export async function summaryFollowups(now = new Date()): Promise<{ reminders: number; escalated: number }> {
  let reminders = 0;
  let escalated = 0;
  const calls: CallDoc[] = [];
  for (const status of ["completed", "in_progress", "booked"]) {
    calls.push(...(await findRecords<CallDoc>(COLLECTIONS.consultations, { status }).catch(() => [] as CallDoc[])));
  }
  for (const c of calls) {
    const due = summaryFollowupDue(c, now);
    if (!due) continue;
    try {
      if (due === "reminder") {
        const m = await summaryMail(c, true, true);
        if (m && await sendLawyerOnce(`summary_reminder_${c.id}`, m.to, m.mail, m.placeholder)) reminders++;
        await updateRecord(COLLECTIONS.consultations, c.id, { summaryNotices: [...new Set([...(c.summaryNotices ?? []), "reminder"])] });
      } else {
        const to = await lawyerContact(c.providerId);
        const ids = await emitEvent("call.summary_unconfirmed", {
          clientId: c.clientId,
          matterId: c.matterId,
          sourceId: c.id,
          sourceKind: "consultation",
          detail: `${to?.name ?? "the lawyer"}, call of ${dateLabel(c.scheduledAt)}`,
        });
        if (ids.length) escalated++;
        await updateRecord(COLLECTIONS.consultations, c.id, { summaryNotices: [...new Set([...(c.summaryNotices ?? []), "escalated"])] });
      }
    } catch (err) {
      log(`[lawyerComms] summary follow-up ${c.id} failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }
  return { reminders, escalated };
}

// ─── Quotes ────────────────────────────────────────────────────────────────

/** The lawyers on a quote: providerIds, else each fee line's providerId. */
export function quoteLawyers(quote: Doc): string[] {
  const ids = Array.isArray(quote.providerIds) ? (quote.providerIds as unknown[]) : [];
  const lines = Array.isArray(quote.lineItems) ? (quote.lineItems as Doc[]) : [];
  const all = [...ids, ...lines.map((l) => l?.providerId)].filter((x): x is string => typeof x === "string" && !!x && x !== SALES_TEAM_ID);
  return [...new Set(all)];
}

const quoteTitle = (q: Doc) => str(q.title) ?? str(q.name) ?? "Legal work";
const quoteId = (q: Doc) => String(q.quoteId ?? q.id ?? "");

export async function notifyQuoteDecision(clientId: string, quote: Doc, decision: "approved" | "changes", note?: string | null): Promise<number> {
  let n = 0;
  try {
    const client = (await get(COLLECTIONS.clients, clientId).catch(() => null)) as Doc | null;
    const stamp = new Date().toISOString().slice(0, 16);
    for (const pid of quoteLawyers(quote)) {
      const to = await lawyerContact(pid);
      if (!to) continue;
      const mail = quoteDecisionEmail({ firstName: to.firstName, memberName: memberNameOf(client), quoteTitle: quoteTitle(quote), decision, note: note ?? null, url: lawyerUrl("/clients") });
      if (await sendLawyerOnce(`quote_${decision}_${quoteId(quote)}_${pid}_${stamp}`, to, mail, isPlaceholderId(clientId) || isPlaceholderDoc(client) || isPlaceholderDoc(quote))) n++;
    }
  } catch (err) {
    log(`[lawyerComms] quote ${decision} ${quoteId(quote)} failed: ${err instanceof Error ? err.message : err}`, "error");
  }
  return n;
}

export async function notifyQuoteAccepted(clientId: string, quote: Doc, fees: Array<{ providerId: string; amount: number }>): Promise<number> {
  let n = 0;
  try {
    const client = (await get(COLLECTIONS.clients, clientId).catch(() => null)) as Doc | null;
    for (const f of fees) {
      const to = await lawyerContact(f.providerId);
      if (!to) continue;
      const mail = quoteAcceptedLawyerEmail({ firstName: to.firstName, memberName: memberNameOf(client), quoteTitle: quoteTitle(quote), fee: f.amount, url: lawyerUrl("/finance") });
      if (await sendLawyerOnce(`quote_accepted_${quoteId(quote)}_${f.providerId}`, to, mail, isPlaceholderId(clientId) || isPlaceholderDoc(client) || isPlaceholderDoc(quote))) n++;
    }
  } catch (err) {
    log(`[lawyerComms] quote accepted ${quoteId(quote)} failed: ${err instanceof Error ? err.message : err}`, "error");
  }
  return n;
}

// ─── Payouts ───────────────────────────────────────────────────────────────

/** Pure: provider payment rows paid now that were not paid before (by row id). */
export function newlyPaid(before: Doc | null, after: Doc): Doc[] {
  const was = new Set(((Array.isArray(before?.providerPayments) ? before!.providerPayments : []) as Doc[]).filter((p) => p?.paid === true).map((p) => String(p.id)));
  return ((Array.isArray(after.providerPayments) ? after.providerPayments : []) as Doc[])
    .filter((p) => p?.paid === true && typeof p.providerId === "string" && p.providerId && !was.has(String(p.id)) && Number(p.amount) > 0);
}

/** A settlement was saved: email each lawyer whose fee row became paid (once per row). */
export async function notifyPayouts(before: Doc | null, after: Doc): Promise<number> {
  const rows = newlyPaid(before, after);
  if (!rows.length) return 0;
  let n = 0;
  try {
    const clientId = str(after.clientId) ?? str(before?.clientId);
    const client = clientId ? ((await get(COLLECTIONS.clients, clientId).catch(() => null)) as Doc | null) : null;
    const quotes = Array.isArray(client?.quotes) ? (client!.quotes as Doc[]) : [];
    const quote = quotes.find((q) => quoteId(q) === String(after.quoteId ?? "")) ?? null;
    const label = `${quote ? quoteTitle(quote) : "Legal work"} for ${memberNameOf(client)}`;
    const by = new Map<string, Doc[]>();
    for (const r of rows) by.set(String(r.providerId), [...(by.get(String(r.providerId)) ?? []), r]);
    for (const [pid, list] of by) {
      const to = await lawyerContact(pid);
      if (!to) continue;
      const mail = payoutEmail({ firstName: to.firstName, items: list.map((r) => ({ label, amount: Number(r.amount) || 0, date: dateLabel(str(r.date)) || null })), url: lawyerUrl("/finance") });
      const key = `payout_${list.map((r) => String(r.id)).sort().join("_")}`;
      if (await sendLawyerOnce(key, to, mail, (!!clientId && isPlaceholderId(clientId)) || isPlaceholderDoc(client) || isPlaceholderDoc(after))) n++;
    }
  } catch (err) {
    log(`[lawyerComms] payout email failed: ${err instanceof Error ? err.message : err}`, "error");
  }
  return n;
}

// ─── Weekly digest ─────────────────────────────────────────────────────────

const OPEN_QUOTE_LABEL: Record<string, string> = {
  draft: "draft, not submitted",
  changes_requested: "changes requested by ILP",
  pending_approval: "waiting for ILP approval",
  approved: "approved, going to the member",
  sent_to_client: "with the member",
};

/** Lawyers who get the digest and the sweeps: approved and switched on, real (not seed). */
async function activeLawyers(): Promise<LawyerContact[]> {
  const rows = (await getAll("providers").catch(() => [])) as Doc[];
  const out: LawyerContact[] = [];
  for (const p of rows) {
    const id = String(p.id ?? "");
    if (!id || !isProviderBookable(p)) continue;
    const c = await lawyerContact(id, p);
    if (c && !c.placeholder) out.push(c);
  }
  return out;
}

/** Monday digest. Skipped for a lawyer with nothing to report. */
export async function weeklyDigest(now = new Date()): Promise<{ sent: number }> {
  let sent = 0;
  const weekKey = new Date(now.getTime() - 6 * HOUR).toISOString().slice(0, 10);
  const from = now.toISOString();
  const to7 = new Date(now.getTime() + 7 * DAY).toISOString();
  for (const l of await activeLawyers()) {
    try {
      const calls = (await findRecords<CallDoc>(COLLECTIONS.consultations, { providerId: l.providerId }).catch(() => [] as CallDoc[])).filter((c) => c.kind !== "sales");
      const upcoming = calls.filter((c) => c.status === "booked" && c.scheduledAt >= from && c.scheduledAt < to7).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
      const ended = (c: CallDoc) => Date.parse(c.scheduledAt) + (c.durationMin || 20) * 60_000 <= now.getTime();
      const pending = calls.filter((c) => ["completed", "in_progress", "booked"].includes(c.status) && ended(c) && c.summary?.status !== "confirmed" && now.getTime() - Date.parse(c.scheduledAt) <= 30 * DAY);
      const clientIds = [...new Set([...upcoming, ...pending].map((c) => c.clientId))];
      const names = new Map<string, string>();
      for (const id of clientIds) names.set(id, memberNameOf((await get(COLLECTIONS.clients, id).catch(() => null)) as Doc | null));
      const mine = (await query(COLLECTIONS.clients, [{ field: "assignedProviderId", op: "EQUAL", value: l.providerId }]).catch(() => [])) as Doc[];
      const quotes: Array<{ title: string; memberName: string; status: string }> = [];
      for (const c of mine) {
        for (const q of (Array.isArray(c.quotes) ? c.quotes : []) as Doc[]) {
          const st = String(q.status ?? "");
          if (OPEN_QUOTE_LABEL[st] && quoteLawyers(q).includes(l.providerId)) quotes.push({ title: quoteTitle(q), memberName: memberNameOf(c), status: OPEN_QUOTE_LABEL[st] });
        }
      }
      const offers = ((await query(COLLECTIONS.workOffers, [{ field: "providerId", op: "EQUAL", value: l.providerId }]).catch(() => [])) as unknown as WorkOffer[]).filter((o) => o.status === "offered").length;
      if (!upcoming.length && !pending.length && !quotes.length && !offers) continue;
      const tz = await lawyerTimeZone(l.providerId, l.doc);
      const matters = new Map<string, string>();
      for (const c of upcoming) {
        if (c.matterId && !matters.has(c.matterId)) {
          const m = (await get(COLLECTIONS.matters, c.matterId).catch(() => null)) as Matter | null;
          if (m?.title) matters.set(c.matterId, m.title);
        }
      }
      const mail = weeklyDigestEmail({
        firstName: l.firstName,
        weekLabel: `week of ${dateLabel(now.toISOString())}`,
        calls: upcoming.map((c) => ({ when: whenLabel(c.scheduledAt, tz), memberName: names.get(c.clientId) ?? "An ILP member", matter: (c.matterId && matters.get(c.matterId)) || null })),
        summaries: pending.map((c) => ({ memberName: names.get(c.clientId) ?? "An ILP member", when: dateLabel(c.scheduledAt) })),
        quotes,
        offers,
        urls: { today: lawyerUrl(), quotes: lawyerUrl("/clients"), work: lawyerUrl("/work") },
      });
      if (await sendLawyerOnce(`weekly_${l.providerId}_${weekKey}`, l, mail)) sent++;
    } catch (err) {
      log(`[lawyerComms] weekly digest ${l.providerId} failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }
  return { sent };
}

// ─── Profile incomplete (3 days after approval) ───────────────────────────

/** Pure: what is still empty on an approved lawyer's profile, in plain words. */
export function profileGaps(p: Doc, availability: Doc | null): string[] {
  const gaps: string[] = [];
  if (!Array.isArray(p.specialties) || !p.specialties.length) gaps.push("Your specialties (Profile): the matching sends you only members whose question fits them.");
  if (!Array.isArray(p.languages) || !p.languages.length) gaps.push("The languages you hold calls in (Profile).");
  const weekly = Array.isArray(availability?.weekly) ? availability!.weekly as unknown[] : [];
  if (!weekly.length) gaps.push("Your weekly hours (Availability): members can book only inside them.");
  if ((str(p.bio) ?? "").length < 80) gaps.push("A short introduction (Profile), at least 80 characters. Members read it before their first call.");
  return gaps;
}

export async function profileIncompleteSweep(now = new Date()): Promise<{ sent: number }> {
  let sent = 0;
  for (const l of await activeLawyers()) {
    const approved = str(l.doc.activatedAt) ?? (l.doc.status === "active" ? str(l.doc.reviewedAt) : null);
    if (!approved) continue;
    const age = now.getTime() - Date.parse(approved);
    if (!(age >= 3 * DAY && age <= 30 * DAY)) continue;
    try {
      const avail = (await get(COLLECTIONS.availability, l.providerId).catch(() => null)) as Doc | null;
      const gaps = profileGaps(l.doc, avail);
      if (!gaps.length) continue;
      const mail = profileIncompleteEmail({ firstName: l.firstName, approvedOn: dateLabel(approved), missing: gaps, profileUrl: lawyerUrl("/profile") });
      if (await sendLawyerOnce(`profile_incomplete_${l.providerId}`, l, mail)) sent++;
    } catch (err) {
      log(`[lawyerComms] profile incomplete ${l.providerId} failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }
  return { sent };
}

// ─── Licence expiring (60 and 30 days) ─────────────────────────────────────

/** Pure: the notice stage due for a licence expiry (60 or 30 days before), or null. */
export function licenceStage(expiresAt: string | undefined, now: Date): { stage: 60 | 30; days: number } | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return null;
  const days = Math.ceil((t - now.getTime()) / DAY);
  if (days < 0) return null;
  if (days <= 30) return { stage: 30, days };
  if (days <= 60) return { stage: 60, days };
  return null;
}

export async function licenceExpirySweep(now = new Date()): Promise<{ lawyer: number; staff: number }> {
  let lawyer = 0;
  let staff = 0;
  for (const l of await activeLawyers()) {
    for (const lic of (Array.isArray(l.doc.licences) ? l.doc.licences : []) as LawyerLicence[]) {
      const s = licenceStage(lic.expiresAt, now);
      const cc = toCountryCode(lic.country);
      if (!s || !cc) continue;
      const country = COUNTRIES[cc].name;
      const expiresOn = dateLabel(lic.expiresAt);
      const key = `licence_${l.providerId}_${cc}_${String(lic.expiresAt).slice(0, 10)}_${s.stage}`;
      try {
        const mail = licenceExpiringEmail({ firstName: l.firstName, country, body: lic.body || COUNTRIES[cc].lawyerBody.name, expiresOn, days: s.days, teamEmail: lawyerTeamEmail() });
        if (await sendLawyerOnce(key, l, mail)) lawyer++;
        const n = await notifyStaff({
          key,
          kind: "lawyer.licence_expiring",
          title: `Lawyer licence expires in ${s.days} days: ${l.name}, ${country} (${expiresOn})`,
          body: `Ask ${l.name} for the renewed licence or a certificate of good standing, then update the expiry date on their profile (Lawyers, Capacity, Profile).`,
          link: "/dashboard/lawyers",
        });
        if (n) staff++;
      } catch (err) {
        log(`[lawyerComms] licence ${key} failed: ${err instanceof Error ? err.message : err}`, "error");
      }
    }
  }
  return { lawyer, staff };
}
