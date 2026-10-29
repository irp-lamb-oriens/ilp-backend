/**
 * API/csm/compute.ts — pure views behind the CSM portal (COMMS-P3).
 * ──────────────────────────────────────────────────────────────────────────
 * Every page of /csm is computed here from plain records (no I/O), so each
 * rule can be tested: book rows with the health score, Today, Onboarding,
 * Calls, Renewals and risk, Deadlines, Quotes and opportunities, Messages
 * and My KPIs. Times are compared in UTC; "today" is the Costa Rica day
 * (UTC-6, no daylight saving), the team's working day.
 */

import {
  type Consultation,
  CSM_FIRST_CONTACT_SLA_HOURS,
  type CsmContact,
  type CsmTask,
  type HealthScore,
  type Membership,
  type MemberFeedback,
  type Obligation,
  obligationDueAt,
  type Opportunity,
  PLAN_STANDARD,
  profileCompleteness,
  SALES_TEAM_ID,
} from "../../schemas/contracts.ts";
import { isPlaceholderDoc } from "../../helper/placeholder.ts";
import { displayName, isQuoteOpen, profileOf, quoteCents, quoteIdOf, quoteSentAt, quotesOf } from "../dashboard/staffHome/compute.ts";
import { DAY_MS, healthScore } from "./health.ts";

type Doc = Record<string, unknown>;
const HOUR_MS = 3_600_000;
const CR_OFFSET_MS = 6 * HOUR_MS;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const ms = (iso: unknown): number => {
  const t = Date.parse(str(iso));
  return Number.isNaN(t) ? NaN : t;
};
const norm = (v: unknown) => str(v).trim().toLowerCase();

/** Costa Rica calendar day (YYYY-MM-DD) of an instant. */
export const crDay = (t: number): string => new Date(t - CR_OFFSET_MS).toISOString().slice(0, 10);

/**
 * When the first contact with a new member is due: activation + 24 hours,
 * pushed past Saturday and Sunday (Costa Rica time), so a Friday join is
 * due Monday and a weekend join is due Monday or Tuesday.
 */
export function firstContactDueAt(activatedAt: string): string | null {
  let t = ms(activatedAt);
  if (Number.isNaN(t)) return null;
  t += CSM_FIRST_CONTACT_SLA_HOURS * HOUR_MS;
  for (let i = 0; i < 3; i++) {
    const day = new Date(t - CR_OFFSET_MS).getUTCDay();
    if (day !== 0 && day !== 6) break;
    t += DAY_MS;
  }
  return new Date(t).toISOString();
}

// ─── Book rows ─────────────────────────────────────────────────────────────

export interface BookRow {
  clientId: string;
  membershipId: string;
  name: string;
  email: string;
  status: Membership["status"];
  country: string;
  csmEmail: string | null;
  unassigned: boolean;
  activatedAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  completeness: number;
  consultationReady: boolean;
  callsUsed: number;
  callsIncluded: number;
  minutesUsed: number;
  minutesIncluded: number;
  openTasks: number;
  overdueTasks: number;
  lastContactAt: string | null;
  daysSinceContact: number | null;
  deadlines14d: number;
  openQuotes: number;
  lastActivityAt: string | null;
  health: HealthScore;
  /** Sortable copy of health.score (-1 when ended). */
  healthScore: number;
  healthBand: HealthScore["band"];
  placeholder: boolean;
}

export interface BookInput {
  memberships: Membership[];
  clients: Map<string, Doc>;
  openTasks: CsmTask[];
  obligations: Obligation[];
  feedback: MemberFeedback[];
  contacts: CsmContact[];
}

const latest = (...isos: Array<string | null | undefined>): string | null => {
  let best: string | null = null;
  for (const i of isos) if (i && !Number.isNaN(ms(i)) && (!best || i > best)) best = i;
  return best;
};

/** Last thing the member did on their own: a message, an upload noted on the client doc, a rating. */
function memberActivity(client: Doc | undefined, feedback: MemberFeedback[], contacts: CsmContact[]): string | null {
  const comments = Array.isArray(client?.statusComments) ? (client!.statusComments as Doc[]) : [];
  const lastComment = comments.filter((c) => c.authorType !== "staff").map((c) => str(c.createdAt)).sort().pop();
  const lily = Array.isArray(client?.statusChatThread) ? (client!.statusChatThread as Doc[]) : [];
  const lastLily = lily.filter((m) => m.role !== "assistant").map((m) => str(m.createdAt)).sort().pop();
  const lastFeedback = feedback.map((f) => f.at).sort().pop();
  const lastInbound = contacts.filter((c) => c.direction === "inbound").map((c) => c.at).sort().pop();
  return latest(lastComment, lastLily, lastFeedback, lastInbound, str(client?.lastUploadAt), str(client?.lastCallAt));
}

export function bookRows(input: BookInput, now: Date = new Date()): BookRow[] {
  const t = now.getTime();
  const in14 = t + 14 * DAY_MS;
  const tasksBy = new Map<string, CsmTask[]>();
  for (const k of input.openTasks) tasksBy.set(k.clientId, [...(tasksBy.get(k.clientId) ?? []), k]);
  const oblBy = new Map<string, Obligation[]>();
  for (const o of input.obligations) oblBy.set(o.clientId, [...(oblBy.get(o.clientId) ?? []), o]);
  const fbBy = new Map<string, MemberFeedback[]>();
  for (const f of input.feedback) fbBy.set(f.clientId, [...(fbBy.get(f.clientId) ?? []), f]);
  const ctBy = new Map<string, CsmContact[]>();
  for (const c of input.contacts) ctBy.set(c.clientId, [...(ctBy.get(c.clientId) ?? []), c]);

  return input.memberships.map((m) => {
    const c = input.clients.get(m.clientId);
    const comp = profileCompleteness(profileOf(c));
    const tasks = (tasksBy.get(m.clientId) ?? []).filter((k) => k.status === "open");
    const obls = (oblBy.get(m.clientId) ?? []).filter((o) => o.status === "upcoming" || o.status === "asked");
    const due = obls.map((o) => ms(obligationDueAt(o))).filter((d) => !Number.isNaN(d));
    const fb = (fbBy.get(m.clientId) ?? []).slice().sort((a, b) => a.at.localeCompare(b.at));
    const contacts = ctBy.get(m.clientId) ?? [];
    const lastContactAt = contacts.filter((k) => k.direction === "outbound" || k.reached).map((k) => k.at).sort().pop() ?? null;
    const lastRating = fb.filter((f) => f.kind === "post_call" && typeof f.score === "number").pop()?.score ?? null;
    const lastNps = fb.filter((f) => f.kind === "monthly" && typeof f.score === "number").pop()?.score ?? null;
    const openQuotes = quotesOf(c).filter((q) => isQuoteOpen(q));
    const quotesWaiting5d = openQuotes.filter((q) => {
      const s = ms(quoteSentAt(q));
      return !Number.isNaN(s) && t - s >= 5 * DAY_MS;
    }).length;
    const lastActivityAt = memberActivity(c, fb, contacts);
    const health = healthScore({
      membershipStatus: m.status,
      cancelAtPeriodEnd: m.cancelAtPeriodEnd === true,
      completeness: comp.score,
      lastContactAt,
      activatedAt: m.activatedAt ?? null,
      periodStart: m.periodStart ?? null,
      callsUsed: m.callsUsed ?? 0,
      lastRating,
      lastNps,
      deadlinesWithin14d: due.filter((d) => d >= t && d <= in14).length,
      deadlinesPast: due.filter((d) => d < t).length,
      quotesWaiting5d,
      lastActivityAt,
    }, now);
    return {
      clientId: m.clientId,
      membershipId: m.id,
      name: displayName(c, m.clientId),
      email: str(c?.email),
      status: m.status,
      country: m.country ?? "CR",
      csmEmail: m.csmEmail ? norm(m.csmEmail) : null,
      unassigned: !m.csmEmail,
      activatedAt: m.activatedAt ?? null,
      periodStart: m.periodStart ?? null,
      periodEnd: m.periodEnd ?? null,
      cancelAtPeriodEnd: m.cancelAtPeriodEnd === true,
      completeness: Math.round(comp.score * 1000) / 1000,
      consultationReady: comp.consultationReady,
      callsUsed: m.callsUsed ?? 0,
      callsIncluded: m.callsIncluded ?? PLAN_STANDARD.callsIncluded,
      minutesUsed: m.minutesUsed ?? 0,
      minutesIncluded: m.minutesIncluded ?? PLAN_STANDARD.minutesIncluded,
      openTasks: tasks.length,
      overdueTasks: tasks.filter((k) => ms(k.dueAt) < t).length,
      lastContactAt,
      daysSinceContact: lastContactAt ? Math.floor((t - ms(lastContactAt)) / DAY_MS) : null,
      deadlines14d: due.filter((d) => d >= t && d <= in14).length,
      openQuotes: openQuotes.length,
      lastActivityAt,
      health,
      healthScore: health.score ?? -1,
      healthBand: health.band,
      placeholder: isPlaceholderDoc(m) || isPlaceholderDoc(c),
    };
  });
}

// ─── Today ─────────────────────────────────────────────────────────────────

export interface QueueItem extends CsmTask {
  memberName: string;
  overdue: boolean;
  dueToday: boolean;
  health: HealthScore | null;
  placeholder: boolean;
}

export interface TodayView {
  counts: { overdue: number; dueToday: number; later: number; newMembers: number; atRisk: number; firstContactsDue: number };
  queue: QueueItem[];
  newMembers: Array<Pick<BookRow, "clientId" | "name" | "activatedAt" | "health" | "lastContactAt"> & { firstContactDueAt: string | null; firstContactOverdue: boolean }>;
  atRisk: BookRow[];
}

/** Pure: the CSM's day. Overdue first (oldest first), then by due date. */
export function todayView(rows: BookRow[], openTasks: CsmTask[], csm: string, now: Date = new Date(), clients?: Map<string, Doc>): TodayView {
  const t = now.getTime();
  const today = crDay(t);
  const byClient = new Map(rows.map((r) => [r.clientId, r]));
  const queue: QueueItem[] = openTasks
    .filter((k) => k.status === "open" && (norm(k.ownerEmail) === csm || (byClient.has(k.clientId) && !k.ownerEmail)))
    .map((k) => {
      const r = byClient.get(k.clientId);
      const due = ms(k.dueAt);
      return {
        ...k,
        memberName: r?.name ?? displayName(clients?.get(k.clientId), k.clientId),
        overdue: due < t,
        dueToday: !Number.isNaN(due) && due >= t && crDay(due) === today,
        health: r?.health ?? null,
        placeholder: isPlaceholderDoc(k),
      };
    })
    .sort((a, b) => (a.overdue === b.overdue ? a.dueAt.localeCompare(b.dueAt) : a.overdue ? -1 : 1));
  const newMembers = rows
    .filter((r) => r.activatedAt && t - ms(r.activatedAt) <= 7 * DAY_MS && r.status !== "cancelled")
    .map((r) => {
      const dueAt = firstContactDueAt(r.activatedAt!);
      return {
        clientId: r.clientId,
        name: r.name,
        activatedAt: r.activatedAt,
        health: r.health,
        lastContactAt: r.lastContactAt,
        firstContactDueAt: dueAt,
        firstContactOverdue: !r.lastContactAt && !!dueAt && ms(dueAt) < t,
      };
    })
    .sort((a, b) => str(b.activatedAt).localeCompare(str(a.activatedAt)));
  const atRisk = rows.filter((r) => r.healthBand === "at_risk").sort((a, b) => a.healthScore - b.healthScore);
  return {
    counts: {
      overdue: queue.filter((q) => q.overdue).length,
      dueToday: queue.filter((q) => q.dueToday).length,
      later: queue.filter((q) => !q.overdue && !q.dueToday).length,
      newMembers: newMembers.length,
      atRisk: atRisk.length,
      firstContactsDue: newMembers.filter((n) => !n.lastContactAt).length,
    },
    queue,
    newMembers,
    atRisk: atRisk.slice(0, 8),
  };
}

// ─── Onboarding ────────────────────────────────────────────────────────────

export type StepState = "done" | "due" | "overdue" | "waiting";

export interface OnboardingRow {
  clientId: string;
  name: string;
  activatedAt: string | null;
  daysSinceJoin: number;
  firstContact: { state: StepState; at: string | null; dueAt: string | null };
  profile: { state: StepState; completeness: number };
  callBooked: { state: StepState; at: string | null };
  callDone: { state: StepState; at: string | null };
  /** Steps done of four. */
  progress: number;
  health: HealthScore;
}

/** New members (joined in the last 45 days, or still not ready after joining) to consultation-ready and a first call. */
export function onboardingView(rows: BookRow[], consultations: Consultation[], now: Date = new Date()): OnboardingRow[] {
  const t = now.getTime();
  const consBy = new Map<string, Consultation[]>();
  for (const c of consultations) {
    if (c.kind === "sales" || c.providerId === SALES_TEAM_ID) continue;
    consBy.set(c.clientId, [...(consBy.get(c.clientId) ?? []), c]);
  }
  return rows
    .filter((r) => r.status !== "cancelled" && r.activatedAt && t - ms(r.activatedAt) <= 45 * DAY_MS)
    .map((r) => {
      const days = Math.floor((t - ms(r.activatedAt)) / DAY_MS);
      const dueAt = firstContactDueAt(r.activatedAt!);
      const cons = (consBy.get(r.clientId) ?? []).slice().sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
      const booked = cons.find((c) => c.status === "booked" || c.status === "in_progress" || c.status === "completed");
      const done = cons.find((c) => c.status === "completed");
      const firstContact: OnboardingRow["firstContact"] = r.lastContactAt
        ? { state: "done", at: r.lastContactAt, dueAt }
        : { state: dueAt && ms(dueAt) < t ? "overdue" : "due", at: null, dueAt };
      const profile: OnboardingRow["profile"] = { state: r.consultationReady ? "done" : days > 7 ? "overdue" : "due", completeness: r.completeness };
      const callBooked: OnboardingRow["callBooked"] = booked ? { state: "done", at: booked.createdAt ?? booked.scheduledAt } : { state: days > 14 ? "overdue" : r.consultationReady ? "due" : "waiting", at: null };
      const callDone: OnboardingRow["callDone"] = done ? { state: "done", at: done.endedAt ?? done.scheduledAt } : { state: booked ? "due" : "waiting", at: null };
      const progress = [firstContact, profile, callBooked, callDone].filter((s) => s.state === "done").length;
      return { clientId: r.clientId, name: r.name, activatedAt: r.activatedAt, daysSinceJoin: days, firstContact, profile, callBooked, callDone, progress, health: r.health };
    })
    .filter((o) => o.progress < 4 || o.daysSinceJoin <= 14)
    .sort((a, b) => a.progress - b.progress || b.daysSinceJoin - a.daysSinceJoin);
}

// ─── Calls ─────────────────────────────────────────────────────────────────

export interface ReadinessCheck {
  code: "profile" | "question" | "consent" | "lawyer" | "link";
  ok: boolean;
  text: string;
}

export interface CallRow {
  id: string;
  clientId: string;
  name: string;
  scheduledAt: string;
  providerId: string;
  status: Consultation["status"];
  checks?: ReadinessCheck[];
  ready?: boolean;
  /** Wrap-up: what is missing after the call. */
  missing?: string[];
  /** No-show: a new call booked after it. */
  rebooked?: boolean;
}

export interface CallsView {
  upcoming: CallRow[];
  wrapUp: CallRow[];
  noShows: CallRow[];
}

export function callsView(rows: BookRow[], consultations: Consultation[], now: Date = new Date()): CallsView {
  const t = now.getTime();
  const byClient = new Map(rows.map((r) => [r.clientId, r]));
  const name = (id: string) => byClient.get(id)?.name ?? id;
  const upcoming: CallRow[] = consultations
    .filter((c) => c.status === "booked" && ms(c.scheduledAt) >= t - HOUR_MS && ms(c.scheduledAt) <= t + 14 * DAY_MS)
    .map((c) => {
      const r = byClient.get(c.clientId);
      const sales = c.kind === "sales" || c.providerId === SALES_TEAM_ID;
      const checks: ReadinessCheck[] = [
        { code: "profile", ok: !!r?.consultationReady, text: r?.consultationReady ? "Profile is consultation-ready" : `Profile ${Math.round((r?.completeness ?? 0) * 100)}% complete` },
        { code: "question", ok: !!str(c.question).trim(), text: str(c.question).trim() ? "Question for the lawyer is written" : "No question written for the lawyer" },
        { code: "consent", ok: c.consent?.recording !== "pending", text: c.consent?.recording === "pending" ? "Recording consent not answered" : "Recording consent answered" },
        { code: "lawyer", ok: !!c.providerId && !sales, text: sales ? "Sales call: no lawyer matched yet" : c.providerId ? "Lawyer assigned" : "No lawyer assigned" },
        { code: "link", ok: !!c.meetUrl, text: c.meetUrl ? "Video link ready" : "No video link yet" },
      ];
      return { id: c.id, clientId: c.clientId, name: name(c.clientId), scheduledAt: c.scheduledAt, providerId: c.providerId, status: c.status, checks, ready: checks.every((k) => k.ok) };
    })
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  const wrapUp: CallRow[] = consultations
    .filter((c) => {
      const end = ms(c.endedAt ?? c.scheduledAt);
      if (Number.isNaN(end) || t - end > 14 * DAY_MS) return false;
      if (c.kind === "sales" || c.providerId === SALES_TEAM_ID) return false;
      if (c.status === "completed") return !c.handoffId || c.summary?.status !== "confirmed";
      return c.status === "booked" && end + 2 * HOUR_MS < t; // still booked well after its time
    })
    .map((c) => {
      const missing: string[] = [];
      if (c.status === "booked") missing.push("Call still marked booked after its time");
      if (c.status === "completed" && c.summary?.status !== "confirmed") missing.push(c.summary ? "Summary not confirmed by the lawyer" : "No summary yet");
      if (c.status === "completed" && !c.handoffId) missing.push("No handoff with next steps yet");
      return { id: c.id, clientId: c.clientId, name: name(c.clientId), scheduledAt: c.scheduledAt, providerId: c.providerId, status: c.status, missing };
    })
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  const noShows: CallRow[] = consultations
    .filter((c) => c.status === "no_show" && t - ms(c.noShowAt ?? c.scheduledAt) <= 30 * DAY_MS)
    .map((c) => ({
      id: c.id,
      clientId: c.clientId,
      name: name(c.clientId),
      scheduledAt: c.scheduledAt,
      providerId: c.providerId,
      status: c.status,
      rebooked: consultations.some((o) => o.clientId === c.clientId && o.id !== c.id && o.status === "booked" && o.scheduledAt > c.scheduledAt),
    }))
    .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt));
  return { upcoming, wrapUp, noShows };
}

// ─── Renewals and risk ─────────────────────────────────────────────────────

export interface RiskItem {
  clientId: string;
  name: string;
  detail: string;
  at: string | null;
  health: HealthScore;
}

export interface RiskView {
  renewals7d: RiskItem[];
  pastDue: RiskItem[];
  cancelRequested: RiskItem[];
  lowScores: RiskItem[];
  inactive30d: RiskItem[];
}

const shortDay = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Costa_Rica" }) : "";

export function riskView(rows: BookRow[], memberships: Membership[], feedback: MemberFeedback[], now: Date = new Date()): RiskView {
  const t = now.getTime();
  const mBy = new Map(memberships.map((m) => [m.clientId, m]));
  const item = (r: BookRow, detail: string, at: string | null): RiskItem => ({ clientId: r.clientId, name: r.name, detail, at, health: r.health });
  const renewals7d = rows
    .filter((r) => r.status === "active" && !r.cancelAtPeriodEnd && r.periodEnd && ms(r.periodEnd) >= t && ms(r.periodEnd) <= t + 7 * DAY_MS)
    .map((r) => item(r, `Renews ${shortDay(r.periodEnd)}`, r.periodEnd))
    .sort((a, b) => str(a.at).localeCompare(str(b.at)));
  const pastDue = rows
    .filter((r) => r.status === "past_due")
    .map((r) => {
      const since = mBy.get(r.clientId)?.pastDueSince ?? null;
      return item(r, since ? `Payment failed ${shortDay(since)}` : "Payment failed", since);
    });
  const cancelRequested = rows
    .filter((r) => r.cancelAtPeriodEnd && r.status !== "cancelled")
    .map((r) => {
      const reason = str(mBy.get(r.clientId)?.cancelReason);
      return item(r, `Ends ${shortDay(r.periodEnd)}${reason ? `. Reason: ${reason}` : ""}`, r.periodEnd);
    });
  const byClient = new Map(rows.map((r) => [r.clientId, r]));
  const lowScores: RiskItem[] = [];
  for (const f of feedback) {
    const r = byClient.get(f.clientId);
    if (!r || t - ms(f.at) > 30 * DAY_MS || typeof f.score !== "number") continue;
    const low = (f.kind === "post_call" && f.score <= 2) || (f.kind === "monthly" && f.score <= 6);
    if (!low) continue;
    lowScores.push(item(r, f.kind === "post_call" ? `Rated a call ${f.score} of 5` : `Monthly score ${f.score} of 10`, f.at));
  }
  lowScores.sort((a, b) => str(b.at).localeCompare(str(a.at)));
  const inactive30d = rows
    .filter((r) => r.status === "active" && r.health.reasons.some((x) => x.code === "inactive_30d"))
    .map((r) => item(r, r.lastActivityAt ? `Last activity ${shortDay(r.lastActivityAt)}` : "No activity since joining", r.lastActivityAt));
  return { renewals7d, pastDue, cancelRequested, lowScores, inactive30d };
}

// ─── Deadlines ─────────────────────────────────────────────────────────────

export interface DeadlineRow {
  id: string;
  clientId: string;
  name: string;
  title: string;
  dueAt: string | null;
  daysLeft: number | null;
  status: Obligation["status"];
  needsDate: boolean;
  area: string;
}

export function deadlinesView(rows: BookRow[], obligations: Obligation[], now: Date = new Date(), horizonDays = 60): DeadlineRow[] {
  const t = now.getTime();
  const byClient = new Map(rows.map((r) => [r.clientId, r]));
  return obligations
    .filter((o) => byClient.has(o.clientId) && (o.status === "upcoming" || o.status === "asked"))
    .map((o) => {
      const due = obligationDueAt(o) ?? null;
      const d = ms(due);
      return {
        id: o.id,
        clientId: o.clientId,
        name: byClient.get(o.clientId)!.name,
        title: o.title,
        dueAt: due,
        daysLeft: Number.isNaN(d) ? null : Math.ceil((d - t) / DAY_MS),
        status: o.status,
        needsDate: !due || o.needsDate === true,
        area: str(o.area),
      };
    })
    .filter((r) => r.daysLeft === null ? r.needsDate : r.daysLeft <= horizonDays)
    .sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));
}

// ─── Quotes and opportunities ──────────────────────────────────────────────

export interface QuoteRow {
  clientId: string;
  name: string;
  quoteId: string;
  title: string;
  cents: number;
  sentAt: string;
  daysWaiting: number;
}

export interface OpportunityRow {
  id: string;
  clientId: string;
  name: string;
  title: string;
  stage: Opportunity["stage"];
  valueCents: number | null;
  nextAction: string | null;
  nextActionDueAt: string | null;
  overdue: boolean;
}

export function quotesView(rows: BookRow[], clients: Map<string, Doc>, opportunities: Opportunity[], now: Date = new Date()): { quotes: QuoteRow[]; opportunities: OpportunityRow[] } {
  const t = now.getTime();
  const byClient = new Map(rows.map((r) => [r.clientId, r]));
  const quotes: QuoteRow[] = [];
  for (const r of rows) {
    for (const q of quotesOf(clients.get(r.clientId))) {
      if (!isQuoteOpen(q)) continue;
      const sent = quoteSentAt(q);
      quotes.push({
        clientId: r.clientId,
        name: r.name,
        quoteId: quoteIdOf(q),
        title: str(q.title) || "Quote",
        cents: quoteCents(q),
        sentAt: sent,
        daysWaiting: Number.isNaN(ms(sent)) ? 0 : Math.floor((t - ms(sent)) / DAY_MS),
      });
    }
  }
  quotes.sort((a, b) => b.daysWaiting - a.daysWaiting);
  const opps: OpportunityRow[] = opportunities
    .filter((o) => byClient.has(o.clientId) && o.stage !== "won" && o.stage !== "lost")
    .map((o) => ({
      id: o.id,
      clientId: o.clientId,
      name: byClient.get(o.clientId)!.name,
      title: o.title,
      stage: o.stage,
      valueCents: typeof o.valueCents === "number" ? o.valueCents : null,
      nextAction: o.nextAction?.what ?? null,
      nextActionDueAt: o.nextAction?.dueAt ?? null,
      overdue: !!o.nextAction?.dueAt && ms(o.nextAction.dueAt) < t,
    }))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || str(a.nextActionDueAt).localeCompare(str(b.nextActionDueAt)));
  return { quotes, opportunities: opps };
}

// ─── Messages ──────────────────────────────────────────────────────────────

export interface MessageRow {
  id: string;
  kind: "message" | "upload";
  clientId: string;
  name: string;
  at: string;
  text: string;
  answered: boolean;
}

/** Member messages to the team and member uploads in the last 30 days, unanswered first. */
export function messagesView(rows: BookRow[], clients: Map<string, Doc>, documents: Doc[], now: Date = new Date()): MessageRow[] {
  const t = now.getTime();
  const out: MessageRow[] = [];
  for (const r of rows) {
    const c = clients.get(r.clientId);
    const comments = (Array.isArray(c?.statusComments) ? (c!.statusComments as Doc[]) : []).filter((x) => !x.deleted);
    const staffTimes = comments.filter((x) => x.authorType === "staff").map((x) => str(x.createdAt));
    for (const x of comments) {
      if (x.authorType === "staff") continue;
      const at = str(x.createdAt);
      if (!at || t - ms(at) > 30 * DAY_MS) continue;
      out.push({ id: `msg:${r.clientId}:${str(x.id) || at}`, kind: "message", clientId: r.clientId, name: r.name, at, text: str(x.body), answered: staffTimes.some((s) => s > at) });
    }
  }
  const byClient = new Map(rows.map((r) => [r.clientId, r]));
  for (const d of documents) {
    const r = byClient.get(str(d.clientId));
    const at = str(d.uploadedAt);
    if (!r || !at || t - ms(at) > 30 * DAY_MS) continue;
    const by = norm(d.uploadedBy);
    if (by && by !== norm(r.email)) continue; // uploads by the team are not member messages
    out.push({ id: `doc:${str(d.id)}`, kind: "upload", clientId: r.clientId, name: r.name, at, text: `${str(d.fileName) || "A document"} (${str(d.category) || "other"})`, answered: d.reviewedAt !== undefined && d.reviewedAt !== null });
  }
  return out.sort((a, b) => Number(a.answered) - Number(b.answered) || b.at.localeCompare(a.at));
}

// ─── My KPIs ───────────────────────────────────────────────────────────────

export interface Kpi {
  value: number | null;
  /** How it is counted, shown under the number. */
  hint: string;
  target?: number;
  unit: "hours" | "percent" | "count";
}

export interface CsmKpis {
  bookSize: number;
  atRisk: number;
  timeToFirstContact: Kpi;
  firstContactInSla: Kpi;
  handoffSla: Kpi;
  bookRetention: Kpi;
  readyIn7Days: Kpi;
  tasksOnTime: Kpi;
  contacts7d: Kpi;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function kpisView(input: {
  rows: BookRow[];
  memberships: Membership[];
  contacts: CsmContact[];
  ownedTasks: CsmTask[];
  now?: Date;
}): CsmKpis {
  const t = (input.now ?? new Date()).getTime();
  const firstContact = new Map<string, number>();
  for (const c of input.contacts) {
    if (c.direction !== "outbound" && !c.reached) continue;
    const at = ms(c.at);
    if (Number.isNaN(at)) continue;
    const cur = firstContact.get(c.clientId);
    if (cur === undefined || at < cur) firstContact.set(c.clientId, at);
  }
  const recent = input.rows.filter((r) => r.activatedAt && t - ms(r.activatedAt) <= 90 * DAY_MS);
  const hours: number[] = [];
  let inSla = 0;
  let slaBase = 0;
  for (const r of recent) {
    const act = ms(r.activatedAt);
    const first = firstContact.get(r.clientId);
    const due = ms(firstContactDueAt(r.activatedAt!));
    if (first !== undefined) {
      hours.push(Math.max(0, (first - act) / HOUR_MS));
      slaBase++;
      if (first <= due) inSla++;
    } else if (due < t) {
      slaBase++; // missed: no contact and the deadline passed
    }
  }
  const handoffTasks = input.ownedTasks.filter((k) => k.source?.kind === "handoff" && k.type === "follow_up" && t - ms(k.createdAt) <= 90 * DAY_MS && (k.status === "done" || ms(k.dueAt) < t));
  const handoffOk = handoffTasks.filter((k) => k.status === "done" && k.closedAt && ms(k.closedAt) <= ms(k.dueAt)).length;
  const cohort = input.memberships.filter((m) => m.activatedAt && ms(m.activatedAt) <= t - 90 * DAY_MS);
  const retained = cohort.filter((m) => m.status === "active" || m.status === "past_due").length;
  const readyBase = recent.filter((r) => t - ms(r.activatedAt) >= 7 * DAY_MS);
  const ready = readyBase.filter((r) => r.consultationReady).length;
  const closed30 = input.ownedTasks.filter((k) => k.status === "done" && k.closedAt && t - ms(k.closedAt) <= 30 * DAY_MS);
  const onTime = closed30.filter((k) => ms(k.closedAt) <= ms(k.dueAt)).length;
  const contacts7d = input.contacts.filter((c) => t - ms(c.at) <= 7 * DAY_MS).length;
  const med = median(hours);
  return {
    bookSize: input.rows.filter((r) => r.status !== "cancelled").length,
    atRisk: input.rows.filter((r) => r.healthBand === "at_risk").length,
    timeToFirstContact: { value: med === null ? null : Math.round(med * 10) / 10, unit: "hours", target: 24, hint: `Median hours from joining to your first logged contact, members who joined in the last 90 days (${hours.length} contacted)` },
    firstContactInSla: { value: pct(inSla, slaBase), unit: "percent", target: 100, hint: `${inSla} of ${slaBase} first contacts within one business day` },
    handoffSla: { value: pct(handoffOk, handoffTasks.length), unit: "percent", target: 100, hint: `${handoffOk} of ${handoffTasks.length} next-step follow-ups after a handoff closed by their due time (24 hours), last 90 days` },
    bookRetention: { value: pct(retained, cohort.length), unit: "percent", target: 80, hint: `${retained} of ${cohort.length} members who joined 90 or more days ago are still members` },
    readyIn7Days: { value: pct(ready, readyBase.length), unit: "percent", target: 80, hint: `${ready} of ${readyBase.length} members who joined 7 to 90 days ago are consultation-ready now` },
    tasksOnTime: { value: pct(onTime, closed30.length), unit: "percent", target: 90, hint: `${onTime} of ${closed30.length} tasks closed in the last 30 days were closed by their due date` },
    contacts7d: { value: contacts7d, unit: "count", hint: "Calls, emails and messages logged with your members in the last 7 days" },
  };
}
