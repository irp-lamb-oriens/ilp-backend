/**
 * API/retention/retentionMessages.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Non-transactional member messages (P2). Run daily by jobs/retentionSweep.ts.
 * All respect `clients.emailOptOut` and carry an unsubscribe link; all are
 * once-only per member per message.
 *
 *   obligations  dates reaching 30 and 7 days out ("may require review"),
 *                one email per member per day listing every newly reached item;
 *                `obligation.remindersSent` remembers "30" / "7". DEADLINES: the
 *                date is the person's own (userDueAt) first; remind=false and
 *                removed items are skipped; free accounts get these too.
 *   check-in     on the monthly anniversary of activatedAt: minutes left + a
 *                0-10 "how likely to recommend" question (/status/feedback?score=N)
 *   nudge        5 days after joining with no call booked
 *   next step    a matter's next step (matter.nextStep or the newest handoff,
 *                same rule as the member Overview) changed since the last sweep;
 *                last seen value kept in `retention_state/ns_<matterId>`.
 *                The first sweep only records a baseline.
 */

import get from "../../db/get.ts";
import put from "../../db/put.ts";
import log from "../../helper/log.ts";
import { isPlaceholderDoc } from "../../helper/placeholder.ts";
import { findRecords, updateRecord } from "../../db/records.ts";
import {
  bookingNudgeEmail,
  monthlyCheckInEmail,
  nextStepChangedEmail,
  obligationsDueEmail,
} from "../../helper/emailTemplates.ts";
import query from "../../db/query.ts";
import {
  ACCOUNT_TYPE_FIELD,
  COLLECTIONS,
  type Consultation,
  type Handoff,
  type Matter,
  type Membership,
  type Obligation,
  obligationDueAt,
  PLAN_STANDARD,
} from "../../schemas/contracts.ts";
import { nextStepFor } from "../clientStatus/memberLogic.ts";
import { crDay, dateLabel, memberContact, type MemberContact, sendOnce, siteUrl, unsubscribeUrl } from "./mailer.ts";

const STATE = "retention_state";
const DAY_MS = 86_400_000;

// ─── Pure rules (exported for tests) ──────────────────────────────────────

/** Whole Costa Rica calendar days from `now` to `iso` (negative when past). */
export function crDaysUntil(iso: string, now: Date): number {
  const a = Date.parse(`${crDay(now)}T00:00:00Z`);
  const b = Date.parse(`${crDay(new Date(iso))}T00:00:00Z`);
  return Math.round((b - a) / DAY_MS);
}

/** Which reminder an obligation has newly reached, if any. */
export function obligationStage(daysLeft: number, sent: string[] = []): "30" | "7" | null {
  if (!Number.isFinite(daysLeft) || daysLeft < 0) return null;
  if (daysLeft <= 7) return sent.includes("7") ? null : "7";
  if (daysLeft <= 30) return sent.includes("30") ? null : "30";
  return null;
}

/**
 * The month key ("2026-11") when today (CR) is on or after this month's
 * anniversary of activatedAt (clamped to the month's last day) and the member
 * joined at least 25 days ago; null otherwise. Missed runs catch up later in
 * the month; the key keeps it to one per month.
 */
export function checkInMonth(activatedAt: string | undefined, now: Date): string | null {
  if (!activatedAt) return null;
  const act = new Date(activatedAt);
  if (Number.isNaN(act.getTime()) || now.getTime() - act.getTime() < 25 * DAY_MS) return null;
  const [y, mo, d] = crDay(now).split("-").map(Number);
  const actDay = Number(crDay(act).split("-")[2]);
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d < Math.min(actDay, lastDay)) return null;
  return `${y}-${String(mo).padStart(2, "0")}`;
}

/** Nudge window: 5 to 12 days after activation, no call ever booked. */
export function nudgeDue(activatedAt: string | undefined, consultations: number, now: Date): boolean {
  if (!activatedAt || consultations > 0) return false;
  const age = (now.getTime() - Date.parse(activatedAt)) / DAY_MS;
  return age >= 5 && age < 12;
}

export const stepFingerprint = (s: { what: string; who: string; dueAt?: string } | null) =>
  s ? `${s.who}|${s.what.trim()}|${String(s.dueAt ?? "").slice(0, 10)}` : "";

const WHO: Record<string, string> = { client: "You", lawyer: "Your lawyer", ilp: "Your ILP team" };

// ─── Per-member steps ─────────────────────────────────────────────────────

/**
 * DEADLINES: obligations that can get a reminder: open, not removed, reminders
 * on, and a date (the person's own date first, then the computed one).
 */
export function remindable<T extends Obligation>(list: T[]): Array<T & { remindAt: string }> {
  return list
    .filter((o) => o.status === "upcoming" && !o.dismissedAt && o.remind !== false && !isPlaceholderDoc(o))
    .map((o) => ({ ...o, remindAt: obligationDueAt(o) ?? "" }))
    .filter((o) => !!o.remindAt);
}

async function obligationsStep(to: MemberContact, now: Date, free = false): Promise<number> {
  const obls = remindable(await findRecords<Obligation & { remindersSent?: string[] }>(COLLECTIONS.obligations, { clientId: to.clientId }));
  const reached: Array<{ o: (typeof obls)[number]; stage: "30" | "7"; days: number }> = [];
  for (const o of obls) {
    const days = crDaysUntil(o.remindAt, now);
    const stage = obligationStage(days, o.remindersSent ?? []);
    if (stage) reached.push({ o, stage, days });
  }
  if (!reached.length) return 0;
  reached.sort((a, b) => a.days - b.days);
  const mail = obligationsDueEmail({
    firstName: to.firstName,
    // Low-confidence research dates are never shown as firm dates (COUNTRIES); a date the person set is theirs.
    items: reached.map((r) => ({ title: r.o.title, dueLabel: dateLabel(r.o.remindAt), daysLeft: r.days, confirm: r.o.confidence === "low" && !r.o.userDueAt })),
    askUrl: `${siteUrl()}/status/deadlines`,
    unsubscribeUrl: await unsubscribeUrl(to.clientId),
    free,
  });
  const sent = await sendOnce(`obligations_${to.clientId}_${crDay(now)}`, to, mail, { transactional: false });
  // Mark the stages reached (a "7" also covers a "30" never sent).
  for (const r of reached) {
    const marks = new Set([...(r.o.remindersSent ?? []), r.stage, ...(r.stage === "7" ? ["30"] : [])]);
    await updateRecord(COLLECTIONS.obligations, r.o.id, { remindersSent: [...marks] });
  }
  return sent ? 1 : 0;
}

async function checkInStep(to: MemberContact, m: Membership, now: Date): Promise<number> {
  const month = checkInMonth(m.activatedAt, now);
  if (!month) return 0;
  const site = siteUrl();
  const mail = monthlyCheckInEmail({
    firstName: to.firstName,
    minutesLeft: Math.max(0, (m.minutesIncluded ?? PLAN_STANDARD.minutesIncluded) - (m.minutesUsed ?? 0)),
    minutesIncluded: m.minutesIncluded ?? PLAN_STANDARD.minutesIncluded,
    callsLeft: Math.max(0, (m.callsIncluded ?? PLAN_STANDARD.callsIncluded) - (m.callsUsed ?? 0)),
    renewsOn: dateLabel(m.periodEnd),
    bookUrl: `${site}/status/book`,
    scoreUrl: (n) => `${site}/status/feedback?score=${n}&m=${month}`,
    feedbackUrl: `${site}/status/feedback?m=${month}`,
    unsubscribeUrl: await unsubscribeUrl(to.clientId),
  });
  return (await sendOnce(`checkin_${m.id}_${month}`, to, mail, { transactional: false })) ? 1 : 0;
}

async function nudgeStep(to: MemberContact, m: Membership, now: Date): Promise<number> {
  if (!m.activatedAt) return 0;
  const cons = await findRecords<Consultation>(COLLECTIONS.consultations, { clientId: to.clientId });
  if (!nudgeDue(m.activatedAt, cons.length, now)) return 0;
  const mail = bookingNudgeEmail({
    firstName: to.firstName,
    minutes: m.minutesIncluded ?? PLAN_STANDARD.minutesIncluded,
    calls: m.callsIncluded ?? PLAN_STANDARD.callsIncluded,
    bookUrl: `${siteUrl()}/status/book`,
    unsubscribeUrl: await unsubscribeUrl(to.clientId),
  });
  return (await sendOnce(`nudge_book_${m.id}`, to, mail, { transactional: false })) ? 1 : 0;
}

async function nextStepStep(to: MemberContact, now: Date): Promise<number> {
  // Placeholder records on a real member (account seed) never produce an email.
  const [matters, handoffs] = (await Promise.all([
    findRecords<Matter>(COLLECTIONS.matters, { clientId: to.clientId }),
    findRecords<Handoff>(COLLECTIONS.handoffs, { clientId: to.clientId }),
  ])).map((list) => list.filter((x) => !isPlaceholderDoc(x))) as [Matter[], Handoff[]];
  let n = 0;
  for (const matter of matters.filter((x) => !x.closedAt)) {
    const step = nextStepFor(matter, handoffs);
    const fp = stepFingerprint(step);
    const stateId = `ns_${matter.id}`.replace(/[^A-Za-z0-9_-]/g, "_");
    const prev = (await get(STATE, stateId).catch(() => null)) as { fingerprint?: string } | null;
    if (prev?.fingerprint === fp) continue;
    await put(STATE, stateId, { clientId: to.clientId, matterId: matter.id, fingerprint: fp, at: now.toISOString() });
    if (!prev || !step) continue; // first sight = baseline; a cleared step is not news
    const mail = nextStepChangedEmail({
      firstName: to.firstName,
      matterTitle: matter.title,
      what: step.what,
      whoLabel: WHO[step.who] ?? "Your ILP team",
      dueLabel: step.dueAt ? dateLabel(step.dueAt) : undefined,
      homeUrl: `${siteUrl()}/status`,
      unsubscribeUrl: await unsubscribeUrl(to.clientId),
    });
    // Key on the fingerprint: the same step never mails twice.
    const key = `nextstep_${matter.id}_${fp.replace(/[^A-Za-z0-9]/g, "").slice(0, 60)}_${fp.length}`;
    if (await sendOnce(key, to, mail, { transactional: false })) n++;
  }
  return n;
}

// ─── Sweep ────────────────────────────────────────────────────────────────

export async function retentionMessagesSweep(now: Date = new Date()): Promise<Record<string, number>> {
  const out = { obligations: 0, freeReminders: 0, checkins: 0, nudges: 0, nextSteps: 0, skippedOptOut: 0 };
  const [active, pastDue] = await Promise.all([
    findRecords<Membership>(COLLECTIONS.memberships, { status: "active" }),
    findRecords<Membership>(COLLECTIONS.memberships, { status: "past_due" }),
  ]);
  for (const m of [...active, ...pastDue]) {
    try {
      const to = await memberContact(m.clientId, m);
      if (!to) continue;
      if (to.optOut) {
        out.skippedOptOut++;
        continue;
      }
      out.obligations += await obligationsStep(to, now);
      // Check-ins and nudges only while the membership is in good standing.
      if (m.status === "active") {
        out.checkins += await checkInStep(to, m, now);
        out.nudges += await nudgeStep(to, m, now);
      }
      out.nextSteps += await nextStepStep(to, now);
    } catch (err) {
      log(`[retention] ${m.clientId} failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }
  // DEADLINES: free accounts get deadline reminders only (service emails with an unsubscribe link), no membership emails.
  const members = new Set([...active, ...pastDue].map((m) => m.clientId));
  const free = (await query(COLLECTIONS.clients, [{ field: ACCOUNT_TYPE_FIELD, op: "EQUAL", value: "free" }]).catch(() => [])) as Array<{ id?: string }>;
  for (const c of free) {
    const clientId = String(c.id ?? "");
    if (!clientId || members.has(clientId)) continue;
    try {
      const to = await memberContact(clientId, c);
      if (!to) continue;
      if (to.optOut) {
        out.skippedOptOut++;
        continue;
      }
      out.freeReminders += await obligationsStep(to, now, true);
    } catch (err) {
      log(`[retention] free account ${clientId} failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }
  return out;
}
