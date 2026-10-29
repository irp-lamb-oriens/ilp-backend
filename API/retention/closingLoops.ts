/**
 * API/retention/closingLoops.ts — member closing loops (COMMS-P4).
 * ──────────────────────────────────────────────────────────────────────────
 * Senders for the emails in closingEmails.ts (and the lawyer side of two of
 * them). Each email goes once per key (mailer.ts `sendOnce` / lawyerComms
 * `sendLawyerOnce`); placeholder members, lawyers and invoices never produce
 * one. Nothing here throws into the request or job that called it.
 *
 *   event                         member email (class)          others
 *   join, manual mode             manual payment (transactional)
 *   lawyer marks a no-show        no-show (transactional)       lawyer email; CSM task
 *                                                               consultation.no_show + bell
 *   cancellation undone           cancel undone (transactional)
 *   membership cancelled (ended)  membership ended (transact.)  assigned lawyer: email + bell
 *   invoice paid in full          receipt (transactional)
 *   first lawyer assigned         lawyer assigned (transact.)
 *   call completed 2 h ago        rating request (service)      (rating feeds the hidden lawyer rating)
 *   document asked 3 days ago     missing document (service)    CSM task document.missing_3d
 *   quote unanswered 5 days       quote reminder (service)      (CSM task from taskRuleSweep)
 *   profile becomes ready         book your first call (service)
 */

import get from "../../db/get.ts";
import getAll from "../../db/getAll.ts";
import patch from "../../db/patch.ts";
import query from "../../db/query.ts";
import log from "../../helper/log.ts";
import { isPlaceholderDoc, isPlaceholderId } from "../../helper/placeholder.ts";
import { FINANCE_DESK_EMAIL } from "../../helper/team.ts";
import { DOCUMENTS_COLLECTION } from "../../helper/storage.ts";
import {
  COLLECTIONS,
  type Consultation,
  countryName,
  type Handoff,
  type Matter,
  type Membership,
  PLAN_STANDARD,
  SALES_TEAM_ID,
  toCountryCode,
} from "../../schemas/contracts.ts";
import { isQuoteAwaitingClient, quoteKey, quoteSentAt } from "../../schemas/quoteStatus.ts";
import { findRecords } from "../../db/records.ts";
import { nextStepFor } from "../clientStatus/memberLogic.ts";
import { emitEvent } from "../members/events.ts";
import { ensureBankInfo } from "../dashboard/automation/bankInfo.ts";
import { lawyerContact, lawyerUrl, memberNameOf, sendLawyerOnce } from "../lawyerComms/notify.ts";
import { membershipEndedLawyerEmail, noShowLawyerEmail } from "../lawyerComms/emails.ts";
import { channelFor, notify } from "../notifications/store.ts";
import { type CallRecord, lawyerTimeZone, peopleFor, whenLabel } from "../calls/callService.ts";
import { dateLabel, memberContact, type MemberContact, sendOnce, siteUrl, unsubscribeUrl } from "./mailer.ts";
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
} from "./closingEmails.ts";

type Doc = Record<string, unknown>;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const usd = (cents: number) => `US$${(cents / 100).toFixed(2)}`;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function safely<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    log(`[closingLoops] ${what} failed: ${errText(err)}`, "error");
    return fallback;
  }
}

// ─── Manual payment instructions (join, manual mode) ──────────────────────

/** Pure: the payment reference a member writes on the transfer. */
export const paymentReference = (membershipId: string) =>
  `ILP-${membershipId.replace(/^mem_/, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase()}`;

/** Pure: the bank lines for the email, or null while the bank details are still the placeholders. */
export function bankLines(b: Awaited<ReturnType<typeof ensureBankInfo>> | null): string[] | null {
  if (!b) return null;
  const acct = String(b.beneficiary?.accountNumber ?? "");
  const aba = String(b.receivingBank?.abaRoutingNumber ?? "");
  if (!acct || /^0+$/.test(acct) || !aba || /^0+$/.test(aba) || /^bank name$/i.test(String(b.receivingBank?.name ?? ""))) return null;
  return [
    `Beneficiary: ${b.beneficiary.name}`,
    `Account number: ${acct}${b.beneficiary.accountType ? ` (${b.beneficiary.accountType})` : ""}`,
    `Bank: ${b.receivingBank.name}`,
    `ABA routing number: ${aba}`,
    ...(b.receivingBank.swiftBic ? [`SWIFT/BIC: ${b.receivingBank.swiftBic}`] : []),
    ...(b.receivingBank.address?.length ? [`Bank address: ${b.receivingBank.address.join(", ")}`] : []),
  ];
}

export async function sendManualPaymentInstructions(m: Pick<Membership, "id" | "clientId" | "status">): Promise<boolean> {
  return await safely("manual payment", async () => {
    if (m.status !== "pending") return false;
    const to = await memberContact(m.clientId, m);
    if (!to) return false;
    const reference = paymentReference(m.id);
    await patch(COLLECTIONS.memberships, m.id, { paymentReference: reference }).catch(() => undefined);
    const bank = await ensureBankInfo().catch(() => null);
    const mail = manualPaymentEmail({
      firstName: to.firstName,
      totalLabel: usd(PLAN_STANDARD.activationCents + PLAN_STANDARD.monthlyCents),
      activationLabel: usd(PLAN_STANDARD.activationCents),
      monthlyLabel: usd(PLAN_STANDARD.monthlyCents),
      reference,
      bank: bankLines(bank),
      receiptNote: bank?.receiptNote ?? null,
      contactEmail: FINANCE_DESK_EMAIL,
      termsUrl: `${siteUrl()}/terms`,
    });
    return await sendOnce(`manual_payment_${m.id}`, to, mail, { kind: "transactional" });
  }, false);
}

// ─── No-show ───────────────────────────────────────────────────────────────

/**
 * After the lawyer marked a no-show (callsRouter): the member is told what
 * happened to the minutes and how to rebook, the lawyer gets a confirmation,
 * and the member's CSM gets a task (and a bell item). `membership` is the
 * charged membership (null when nothing was charged).
 */
export async function afterNoShow(call: CallRecord, membership: Membership | null): Promise<{ member: boolean; lawyer: boolean; task: string | null }> {
  const out = { member: false, lawyer: false, task: null as string | null };
  if (call.kind === "sales") return out;
  const who = await safely("no-show people", () => peopleFor(call), null);
  if (!who) return out;
  const charged = !!call.chargedAt;
  const minutes = call.minutesUsed ?? call.durationMin ?? PLAN_STANDARD.callLengthMin;
  out.member = await safely("no-show member", async () => {
    const to = await memberContact(call.clientId, call);
    if (!to) return false;
    const mail = noShowMemberEmail({
      firstName: to.firstName,
      lawyerName: who.lawyer.name,
      whenLabel: whenLabel(call.scheduledAt, who.member.timezone),
      charged,
      minutes,
      ...(membership
        ? {
          minutesLeft: Math.max(0, (membership.minutesIncluded ?? PLAN_STANDARD.minutesIncluded) - (membership.minutesUsed ?? 0)),
          callsLeft: Math.max(0, (membership.callsIncluded ?? PLAN_STANDARD.callsIncluded) - (membership.callsUsed ?? 0)),
        }
        : {}),
      bookUrl: `${siteUrl()}/status/book`,
      messagesUrl: `${siteUrl()}/status/messages`,
    });
    return await sendOnce(`no_show_${call.id}`, { ...to, placeholder: to.placeholder || who.placeholder }, mail, { kind: "transactional" });
  }, false);
  out.lawyer = await safely("no-show lawyer", async () => {
    const lawyer = await lawyerContact(call.providerId);
    if (!lawyer) return false;
    const tz = await lawyerTimeZone(call.providerId, lawyer.doc);
    const mail = noShowLawyerEmail({ firstName: lawyer.firstName, memberName: who.member.name, whenLabel: whenLabel(call.scheduledAt, tz), url: lawyerUrl() });
    return await sendLawyerOnce(`no_show_${call.id}`, lawyer, mail, who.placeholder);
  }, false);
  out.task = await safely("no-show task", async () => {
    const ids = await emitEvent("consultation.no_show", {
      clientId: call.clientId,
      matterId: call.matterId,
      sourceId: call.id,
      sourceKind: "consultation",
      detail: `${who.member.name}, call of ${whenLabel(call.scheduledAt)}`,
    });
    return ids[0] ?? null;
  }, null);
  return out;
}

// ─── Cancel undone, membership ended ──────────────────────────────────────

const byCard = (m: Pick<Membership, "paymentRef">) => /^sub_/.test(String(m.paymentRef ?? ""));

export async function sendCancelUndone(m: Membership & { cancelRequestedAt?: string | null }): Promise<boolean> {
  return await safely("cancel undone", async () => {
    const to = await memberContact(m.clientId, m);
    if (!to) return false;
    const mail = cancelUndoneEmail({
      firstName: to.firstName,
      renewsOn: dateLabel(m.periodEnd),
      amountLabel: usd(PLAN_STANDARD.monthlyCents),
      byCard: byCard(m),
      moneyUrl: `${siteUrl()}/status/money`,
    });
    // One email per cancellation request that was undone.
    const episode = String(m.cancelRequestedAt ?? m.periodEnd ?? "").slice(0, 19);
    return await sendOnce(`cancel_undone_${m.id}_${episode}`, to, mail, { kind: "transactional" });
  }, false);
}

/** Membership ended: the member, and the lawyer the member was assigned to (email + bell). */
export async function sendMembershipEnded(m: Membership & { cancelledAt?: string }): Promise<{ member: boolean; lawyer: boolean }> {
  const endedAt = m.cancelledAt ?? new Date().toISOString();
  const member = await safely("membership ended (member)", async () => {
    const to = await memberContact(m.clientId, m);
    if (!to) return false;
    const site = siteUrl();
    const mail = membershipEndedEmail({
      firstName: to.firstName,
      endedOn: dateLabel(endedAt),
      joinUrl: `${site}/pricing`,
      privacyUrl: `${site}/status/privacy`,
      homeUrl: `${site}/status`,
    });
    return await sendOnce(`membership_ended_${m.id}`, to, mail, { kind: "transactional" });
  }, false);
  const lawyer = await safely("membership ended (lawyer)", async () => {
    const client = (await get(COLLECTIONS.clients, m.clientId).catch(() => null)) as Doc | null;
    const providerId = str(client?.assignedProviderId);
    if (!providerId || providerId === SALES_TEAM_ID) return false;
    const to = await lawyerContact(providerId);
    if (!to) return false;
    const placeholder = isPlaceholderId(m.clientId) || isPlaceholderDoc(client) || isPlaceholderDoc(m);
    const name = memberNameOf(client);
    await notify({
      key: `lawyer_membership_ended_${m.id}_${providerId}`,
      kind: "member.membership_ended",
      to: channelFor("lawyer", providerId),
      title: `Membership ended: ${name}`,
      link: "/lawyer/clients",
      clientId: m.clientId,
      severity: "info",
      placeholder,
    });
    const mail = membershipEndedLawyerEmail({ firstName: to.firstName, memberName: name, endedOn: dateLabel(endedAt), url: lawyerUrl("/clients") });
    return await sendLawyerOnce(`membership_ended_${m.id}_${providerId}`, to, mail, placeholder);
  }, false);
  return { member, lawyer };
}

// ─── Invoice paid ──────────────────────────────────────────────────────────

/**
 * Receipt when an invoice reaches a zero balance (staff recorded the last
 * payment or marked it paid). Once per invoice and total.
 */
export async function sendInvoicePaid(id: string, inv: Doc, total: number): Promise<boolean> {
  return await safely("invoice paid", async () => {
    if (!(total > 0)) return false;
    const clientId = str(inv.clientId);
    let to: MemberContact | null = clientId ? await memberContact(clientId, inv) : null;
    const email = str(inv.sentToEmail) ?? str(inv.clientEmail);
    if (!to && email) {
      to = { clientId: clientId ?? id, email, firstName: String(inv.clientName ?? "").trim().split(/\s+/)[0] ?? "", optOut: false, placeholder: inv.placeholder === true };
    }
    if (!to) return false;
    if (inv.placeholder === true) to = { ...to, placeholder: true };
    const mail = invoicePaidEmail({
      firstName: to.firstName,
      invoiceNumber: String(inv.invoiceNumber ?? id),
      amountLabel: `US$${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      paidOn: dateLabel(new Date().toISOString()),
      moneyUrl: `${siteUrl()}/status/money`,
      contactEmail: FINANCE_DESK_EMAIL,
    });
    return await sendOnce(`invoice_paid_${id}_${Math.round(total * 100)}`, to, mail, { kind: "transactional" });
  }, false);
}

// ─── First lawyer assigned ─────────────────────────────────────────────────

/** The member's first lawyer (assignMember with no previous lawyer). Once per member, ever. */
export async function sendLawyerAssignedToMember(clientId: string, providerId: string): Promise<boolean> {
  return await safely("lawyer assigned (member)", async () => {
    if (!providerId || providerId === SALES_TEAM_ID) return false;
    const ms = await findRecords<Membership>(COLLECTIONS.memberships, { clientId });
    const live = ms.find((m) => m.status === "active" || m.status === "past_due");
    if (!live) return false; // not paid yet: the join confirmation comes first
    const [to, provider] = await Promise.all([
      memberContact(clientId, live),
      get("providers", providerId).catch(() => null) as Promise<Doc | null>,
    ]);
    if (!to || !provider) return false;
    const lawyerName = str(provider.name) ?? "Your ILP lawyer";
    const mail = lawyerAssignedMemberEmail({
      firstName: to.firstName,
      lawyerName,
      countryName: countryName(toCountryCode(live.country) ?? "CR"),
      bookUrl: `${siteUrl()}/status/book`,
      homeUrl: `${siteUrl()}/status`,
    });
    const placeholder = to.placeholder || isPlaceholderId(providerId) || isPlaceholderDoc(provider);
    return await sendOnce(`lawyer_assigned_${clientId}`, { ...to, placeholder }, mail, { kind: "transactional" });
  }, false);
}

// ─── Post-call rating request ──────────────────────────────────────────────

/** Pure: completed member calls, unrated, that ended 2 hours to 3 days ago. */
export function ratingRequestDue(c: Pick<Consultation, "status" | "kind" | "rating" | "endedAt" | "scheduledAt" | "durationMin">, now: Date): boolean {
  if (c.status !== "completed" || c.kind === "sales" || c.rating) return false;
  const end = Date.parse(c.endedAt ?? "") || Date.parse(c.scheduledAt) + (c.durationMin || PLAN_STANDARD.callLengthMin) * 60_000;
  if (!Number.isFinite(end)) return false;
  const age = now.getTime() - end;
  return age >= 2 * HOUR && age <= 3 * DAY;
}

/** From callReminders: ask once per call. Returns the number queued. */
export async function ratingRequests(completed: CallRecord[], now: Date): Promise<number> {
  let n = 0;
  for (const c of completed.filter((x) => ratingRequestDue(x, now))) {
    const sent = await safely(`rating request ${c.id}`, async () => {
      const to = await memberContact(c.clientId, c);
      if (!to) return false;
      const who = await peopleFor(c);
      const mail = ratingRequestEmail({
        firstName: to.firstName,
        lawyerName: who.lawyer.name,
        whenLabel: whenLabel(c.scheduledAt, who.member.timezone),
        rateUrl: `${siteUrl()}/status`,
        unsubscribeUrl: await unsubscribeUrl(c.clientId),
      });
      return await sendOnce(`rating_request_${c.id}`, { ...to, placeholder: to.placeholder || who.placeholder }, mail, { kind: "service" });
    }, false);
    if (sent) n++;
  }
  return n;
}

// ─── Missing document (3 days) ─────────────────────────────────────────────

/** Same words the member Overview uses to offer "Upload a document" (frontend nextStep.ts). */
export const DOC_WORDS = /\b(upload|send|scan|document|certificate|receipt|letter|books|copy|passport|deed)\b/i;

/**
 * Pure: the open document requests to chase. A matter's next step is for the
 * member, names a document, was set 3 to 30 days ago, and nothing was
 * uploaded since. `anchor` is when the step was set.
 */
export function missingDocuments(
  matters: Matter[],
  handoffs: Handoff[],
  uploads: Array<{ uploadedAt?: string }>,
  now: Date,
): Array<{ matter: Matter; what: string; anchor: string }> {
  const lastUpload = uploads.map((u) => String(u.uploadedAt ?? "")).sort().pop() ?? "";
  const out: Array<{ matter: Matter; what: string; anchor: string }> = [];
  for (const matter of matters.filter((m) => !m.closedAt)) {
    const step = nextStepFor(matter, handoffs);
    if (!step || step.who !== "client" || !DOC_WORDS.test(step.what)) continue;
    const anchor = step.source === "handoff"
      ? handoffs.filter((h) => !h.matterId || h.matterId === matter.id).map((h) => String(h.approvedAt ?? "")).sort().pop() ?? ""
      : String((matter as Matter & { nextStepSetAt?: string }).nextStepSetAt ?? matter.stageEnteredAt ?? "");
    const t = Date.parse(anchor);
    if (!Number.isFinite(t)) continue;
    const age = now.getTime() - t;
    if (age < 3 * DAY || age > 30 * DAY) continue;
    if (lastUpload && lastUpload >= anchor) continue;
    out.push({ matter, what: step.what, anchor });
  }
  return out;
}

/** From the daily retention sweep, per member. Returns emails queued. */
export async function missingDocumentStep(to: MemberContact, now: Date): Promise<number> {
  const [matters, handoffs, uploads] = await Promise.all([
    findRecords<Matter>(COLLECTIONS.matters, { clientId: to.clientId }),
    findRecords<Handoff>(COLLECTIONS.handoffs, { clientId: to.clientId }),
    query(DOCUMENTS_COLLECTION, [{ field: "clientId", op: "EQUAL", value: to.clientId }]).catch(() => []) as Promise<Doc[]>,
  ]);
  let n = 0;
  const live = (x: unknown) => !isPlaceholderDoc(x);
  for (const r of missingDocuments(matters.filter(live), handoffs.filter(live), uploads as Array<{ uploadedAt?: string }>, now)) {
    const key = `${r.matter.id}_${r.anchor.slice(0, 19)}`;
    await emitEvent("document.missing_3d", { clientId: to.clientId, matterId: r.matter.id, sourceId: key, sourceKind: "document", detail: r.what.slice(0, 80) });
    const mail = missingDocumentEmail({
      firstName: to.firstName,
      what: r.what,
      matterTitle: r.matter.title,
      uploadUrl: `${siteUrl()}/status/profile#documents`,
      messagesUrl: `${siteUrl()}/status/messages`,
      unsubscribeUrl: await unsubscribeUrl(to.clientId),
    });
    if (await sendOnce(`missing_doc_${key}`, to, mail, { kind: "service" })) n++;
  }
  return n;
}

// ─── Quote unanswered 5 days ───────────────────────────────────────────────

/** Pure: quotes sent to the member 5 to 30 days ago and still waiting for an answer. */
export function quotesToRemind(quotes: Doc[], now: Date): Array<{ key: string; title?: string; sentAt: string }> {
  const out: Array<{ key: string; title?: string; sentAt: string }> = [];
  for (const q of quotes) {
    if (!isQuoteAwaitingClient(q)) continue;
    const sentAt = quoteSentAt(q);
    const t = Date.parse(sentAt);
    if (!Number.isFinite(t)) continue;
    const age = now.getTime() - t;
    if (age < 5 * DAY || age > 30 * DAY) continue;
    const key = quoteKey(q) || sentAt;
    out.push({ key, title: str(q.title) ?? undefined, sentAt });
  }
  return out;
}

/** Daily (retention sweep): one reminder per quote, to every client with a waiting quote. */
export async function quoteReminderSweep(now: Date, clients?: Doc[]): Promise<number> {
  const rows = clients ?? ((await getAll(COLLECTIONS.clients).catch(() => [])) as Doc[]);
  let n = 0;
  for (const c of rows) {
    const quotes = Array.isArray(c.quotes) ? (c.quotes as Doc[]) : [];
    const due = quotesToRemind(quotes, now);
    if (!due.length) continue;
    const clientId = String(c.id ?? "");
    const to = clientId ? await memberContact(clientId, c).catch(() => null) : null;
    if (!to) continue;
    for (const q of due) {
      const ok = await safely(`quote reminder ${clientId}`, async () => {
        const mail = quoteReminderEmail({
          firstName: to.firstName,
          quoteTitle: q.title,
          sentOn: dateLabel(q.sentAt),
          quoteUrl: `${siteUrl()}/status/money`,
          messagesUrl: `${siteUrl()}/status/messages`,
          unsubscribeUrl: await unsubscribeUrl(clientId),
        });
        return await sendOnce(`quote_reminder_${clientId}_${q.key}`, to, mail, { kind: "service" });
      }, false);
      if (ok) n++;
    }
  }
  return n;
}

// ─── Profile ready → book your first call ─────────────────────────────────

/**
 * The member's profile just became consultation-ready (member profile save):
 * once per membership, when the membership is active, a call is left and no
 * member call was ever booked.
 */
export async function maybeSendProfileReady(clientId: string): Promise<boolean> {
  return await safely("profile ready", async () => {
    const ms = await findRecords<Membership>(COLLECTIONS.memberships, { clientId });
    const m = ms.find((x) => x.status === "active");
    if (!m) return false;
    const calls = m.callsIncluded ?? PLAN_STANDARD.callsIncluded;
    if ((m.callsUsed ?? 0) >= calls) return false;
    const cons = await findRecords<Consultation>(COLLECTIONS.consultations, { clientId });
    if (cons.some((c) => c.kind !== "sales" && c.status !== "cancelled")) return false;
    const to = await memberContact(clientId, m);
    if (!to) return false;
    const mail = profileReadyEmail({
      firstName: to.firstName,
      minutes: m.minutesIncluded ?? PLAN_STANDARD.minutesIncluded,
      calls,
      callLengthMin: PLAN_STANDARD.callLengthMin,
      bookUrl: `${siteUrl()}/status/book`,
      unsubscribeUrl: await unsubscribeUrl(clientId),
    });
    return await sendOnce(`profile_ready_${m.id}`, to, mail, { kind: "service" });
  }, false);
}
