/**
 * API/clientStatus/memberLogic.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Pure helpers for the member home (W4). No I/O, so they run under tests.
 *
 *   • booking capacity (calls + minutes left, counting calls already booked;
 *     past_due members keep booking during the 7-day grace, see accessFor)
 *   • 20-minute slot generation in Costa Rica business hours
 *   • the single "next step" for a matter (matter.nextStep vs latest handoff)
 *   • money: charges + quotes normalised to integer cents, no cost/margin data
 *   • messages: team comments and Lily replies merged into one thread
 */

import {
  type Consultation,
  type Handoff,
  type Matter,
  type Membership,
  PLAN_STANDARD,
} from "../../schemas/contracts.ts";
import { accessFor } from "../payments/lifecycle.ts";

// ─── Booking capacity ──────────────────────────────────────────────────────

export interface Capacity {
  minutesLeft: number; // included − used (charged calls)
  callsLeft: number;
  minutesBooked: number; // upcoming calls not yet charged
  callsBooked: number;
  minutesAvailable: number; // what can still be booked
  callsAvailable: number;
  canBook: boolean;
  /** Plain-language reason when canBook is false. */
  reason?: string;
  /** Gentle note while booking is still allowed (past_due inside the grace window). */
  notice?: string;
  /** When access pauses for a past_due member. */
  graceEndsAt?: string;
}

const isUpcoming = (c: Pick<Consultation, "status">) => c.status === "booked" || c.status === "in_progress";

export function bookingCapacity(
  m:
    | (Pick<Membership, "status" | "minutesIncluded" | "minutesUsed" | "callsIncluded" | "callsUsed" | "periodEnd"> & {
      pastDueSince?: string;
    })
    | null,
  consultations: Array<Pick<Consultation, "status" | "durationMin">>,
  callLengthMin: number = PLAN_STANDARD.callLengthMin,
  now: Date = new Date(),
): Capacity {
  const minutesLeft = m ? Math.max(0, (m.minutesIncluded ?? 0) - (m.minutesUsed ?? 0)) : 0;
  const callsLeft = m ? Math.max(0, (m.callsIncluded ?? 0) - (m.callsUsed ?? 0)) : 0;
  const upcoming = consultations.filter(isUpcoming);
  const minutesBooked = upcoming.reduce((s, c) => s + (c.durationMin || callLengthMin), 0);
  const callsBooked = upcoming.length;
  const minutesAvailable = Math.max(0, minutesLeft - minutesBooked);
  const callsAvailable = Math.max(0, callsLeft - callsBooked);
  // Status rule shared with payments: active, or past_due inside the 7-day grace.
  const access = accessFor(m, now);
  let reason: string | undefined;
  if (!m || !access.canBook) {
    reason = access.message ?? "Your membership is not active, so calls cannot be booked.";
  } else if (callsAvailable <= 0) {
    reason = callsBooked > 0
      ? `You have used or booked all ${m.callsIncluded} calls for this month. New calls open on ${shortDate(m.periodEnd)}.`
      : `You have used all ${m.callsIncluded} calls for this month. New calls open on ${shortDate(m.periodEnd)}.`;
  } else if (minutesAvailable < callLengthMin) {
    reason = `You have ${minutesAvailable} minutes left this month and a call takes ${callLengthMin}. New minutes arrive on ${shortDate(m.periodEnd)}.`;
  }
  return {
    minutesLeft,
    callsLeft,
    minutesBooked,
    callsBooked,
    minutesAvailable,
    callsAvailable,
    canBook: !reason,
    reason,
    ...(access.inGrace ? { notice: access.message } : {}),
    ...(access.graceEndsAt ? { graceEndsAt: access.graceEndsAt } : {}),
  };
}

function shortDate(iso?: string): string {
  if (!iso) return "your renewal date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "your renewal date";
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/Costa_Rica" });
}

// ─── Slots ─────────────────────────────────────────────────────────────────

/** Costa Rica is UTC-6 all year (no DST). */
export const CR_OFFSET_HOURS = 6;

export interface SlotOptions {
  now: Date;
  days?: number; // business days to offer (default 8)
  startHour?: number; // CR local, default 8
  endHour?: number; // CR local, last call ends by this hour, default 17
  lengthMin?: number; // default 20
  /** Lead time before the first bookable slot, hours (default 18). */
  leadHours?: number;
  /** Already-taken start times (ISO) for this lawyer. */
  taken?: string[];
}

/** 20-minute slots on weekdays in CR business hours, minus taken ones. */
export function generateSlots(o: SlotOptions): string[] {
  const days = o.days ?? 8;
  const start = o.startHour ?? 8;
  const end = o.endHour ?? 17;
  const len = o.lengthMin ?? PLAN_STANDARD.callLengthMin;
  const earliest = o.now.getTime() + (o.leadHours ?? 18) * 3600_000;
  const taken = new Set((o.taken ?? []).map((t) => new Date(t).toISOString()));
  const out: string[] = [];
  // Work in CR "local" by shifting the clock.
  const local = new Date(o.now.getTime() - CR_OFFSET_HOURS * 3600_000);
  let found = 0;
  for (let i = 0; found < days && i < days * 3; i++) {
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + i));
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    let any = false;
    for (let mins = start * 60; mins + len <= end * 60; mins += len) {
      if (mins >= 12 * 60 && mins < 13 * 60) continue; // lunch
      const t = day.getTime() + (mins + CR_OFFSET_HOURS * 60) * 60_000;
      if (t < earliest) continue;
      const iso = new Date(t).toISOString();
      if (taken.has(iso)) continue;
      out.push(iso);
      any = true;
    }
    if (any) found++;
  }
  return out;
}

// ─── Next step ─────────────────────────────────────────────────────────────

export interface ClientNextStep {
  what: string;
  who: "client" | "lawyer" | "ilp";
  dueAt?: string;
  matterId?: string;
  source: "matter" | "handoff";
  /** Other confirmed steps from the same handoff. */
  more: Array<{ what: string; who: "client" | "lawyer" | "ilp"; dueAt?: string }>;
}

/**
 * The single next step for one matter: whichever is newer of the matter's
 * own nextStep (anchored at nextStepSetAt, else stageEnteredAt) and the latest
 * handoff's legal next steps (anchored at approvedAt).
 */
export function nextStepFor(
  matter: (Matter & { nextStepSetAt?: string }) | null,
  handoffs: Handoff[],
): ClientNextStep | null {
  const forMatter = handoffs
    .filter((h) => !matter || !h.matterId || h.matterId === matter.id)
    .filter((h) => Array.isArray(h.legalNextSteps) && h.legalNextSteps.length > 0)
    .sort((a, b) => String(b.approvedAt).localeCompare(String(a.approvedAt)));
  const h = forMatter[0];
  const fromMatter = matter?.nextStep && !matter.closedAt
    ? { step: matter.nextStep, at: matter.nextStepSetAt ?? matter.stageEnteredAt ?? "" }
    : null;
  if (h && (!fromMatter || String(h.approvedAt) >= String(fromMatter.at))) {
    // Client actions first, then by due date.
    const steps = [...h.legalNextSteps].sort((a, b) => {
      const ca = a.who === "client" ? 0 : 1;
      const cb = b.who === "client" ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return String(a.dueAt ?? "9999").localeCompare(String(b.dueAt ?? "9999"));
    });
    const [first, ...rest] = steps;
    return { ...first, matterId: h.matterId ?? matter?.id, source: "handoff", more: rest };
  }
  if (fromMatter) {
    return { ...fromMatter.step, matterId: matter!.id, source: "matter", more: [] };
  }
  return null;
}

// ─── Money ─────────────────────────────────────────────────────────────────

export interface ClientCharge {
  id: string;
  label: string;
  date?: string;
  dueDate?: string;
  amountCents: number;
  paidCents: number;
  balanceCents: number;
  status: "paid" | "partially_paid" | "due";
  currency: string;
}

export interface ClientQuote {
  id: string;
  title: string;
  status: "awaiting" | "accepted" | "declined";
  totalCents: number | null;
  currency: string;
  /** Plain-language list of what the work covers. No per-line prices. */
  scope: string[];
  summary?: string;
  createdAt?: string;
  acceptedAt?: string;
  matterId?: string;
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Cents from either `*Minor` (cents) or a dollar `total`/`amount`. */
function cents(o: Record<string, unknown>, minorKeys: string[], dollarKeys: string[]): number | null {
  for (const k of minorKeys) if (o[k] !== undefined && o[k] !== null) return Math.round(num(o[k]));
  for (const k of dollarKeys) if (o[k] !== undefined && o[k] !== null) return Math.round(num(o[k]) * 100);
  return null;
}

export function normalizeCharge(raw: unknown, i: number): ClientCharge {
  const c = (raw ?? {}) as Record<string, unknown>;
  const amountCents = cents(c, ["amountMinor", "totalMinor"], ["total", "amount"]) ?? 0;
  const payments = Array.isArray(c.payments) ? c.payments as Array<Record<string, unknown>> : [];
  let paidCents = payments
    .filter((p) => p?.received !== false)
    .reduce((s, p) => s + (cents(p, ["amountMinor"], ["amount"]) ?? 0), 0);
  if (!payments.length && String(c.status) === "paid") paidCents = amountCents;
  paidCents = Math.min(paidCents, amountCents);
  const balanceCents = Math.max(0, amountCents - paidCents);
  return {
    id: str(c.id) ?? `charge_${i}`,
    label: str(c.label) ?? "Charge",
    date: str(c.date) ?? str(c.createdAt),
    dueDate: str(c.dueDate) ?? str(c.dueAt),
    amountCents,
    paidCents,
    balanceCents,
    status: balanceCents <= 0 ? "paid" : paidCents > 0 ? "partially_paid" : "due",
    currency: str(c.currency) ?? "USD",
  };
}

const QUOTE_STATUS: Record<string, ClientQuote["status"] | undefined> = {
  sent: "awaiting",
  received: "awaiting",
  accepted: "accepted",
  rejected: "declined",
  declined: "declined",
};

/** Only labels and descriptions; never line amounts (they may be cost, not price). */
export function quoteScope(q: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    const s = str(v);
    if (s && !out.includes(s)) out.push(s);
  };
  for (const l of Array.isArray(q.lines) ? q.lines as Array<Record<string, unknown>> : []) push(l.label);
  for (const g of Array.isArray(q.groups) ? q.groups as Array<Record<string, unknown>> : []) {
    const items = Array.isArray(g.lineItems) ? g.lineItems as Array<Record<string, unknown>> : [];
    if (items.length) items.forEach((li) => push(li.label));
    else push(g.title);
  }
  for (const li of Array.isArray(q.lineItems) ? q.lineItems as Array<Record<string, unknown>> : []) push(li.label);
  return out.slice(0, 12);
}

export function normalizeQuote(raw: unknown): ClientQuote | null {
  const q = (raw ?? {}) as Record<string, unknown>;
  const status = QUOTE_STATUS[String(q.status ?? "")];
  if (!status || !str(q.id)) return null;
  return {
    id: String(q.id),
    title: str(q.title) ?? "Legal work proposal",
    status,
    totalCents: cents(q, ["totalMinor", "clientTotalMinor"], ["clientTotal", "total"]),
    currency: str(q.currency) ?? "USD",
    scope: quoteScope(q),
    summary: str(q.scopeSummary) ?? str(q.summary) ?? str(q.description),
    createdAt: str(q.createdAt),
    acceptedAt: str(q.acceptedAt),
    matterId: str(q.matterId),
  };
}

export function moneyView(doc: Record<string, unknown>) {
  const charges = (Array.isArray(doc.charges) ? doc.charges : []).map(normalizeCharge);
  const quotes = (Array.isArray(doc.quotes) ? doc.quotes : [])
    .map(normalizeQuote)
    .filter((q): q is ClientQuote => !!q)
    .sort((a, b) => {
      const rank = { awaiting: 0, accepted: 1, declined: 2 } as const;
      if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
      return String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""));
    });
  const due = charges.filter((c) => c.balanceCents > 0);
  const balanceDueCents = due.reduce((s, c) => s + c.balanceCents, 0);
  const nextDue = due.map((c) => c.dueDate).filter(Boolean).sort()[0];
  return {
    balanceDueCents,
    nextDueDate: nextDue,
    paidCents: charges.reduce((s, c) => s + c.paidCents, 0),
    charges: charges.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? ""))),
    quotes,
  };
}

// ─── Messages ──────────────────────────────────────────────────────────────

export interface ThreadItem {
  id: string;
  kind: "member" | "team" | "ai";
  author: string;
  body: string;
  at: string;
  /** For member messages: who it was addressed to. */
  to?: "team" | "ai";
}

export function mergeThread(doc: Record<string, unknown>, memberName: string): ThreadItem[] {
  const out: ThreadItem[] = [];
  const comments = Array.isArray(doc.statusComments) ? doc.statusComments as Array<Record<string, unknown>> : [];
  comments.forEach((c, i) => {
    if (c.deleted) return;
    const team = c.authorType === "staff";
    out.push({
      id: str(c.id) ?? `c${i}`,
      kind: team ? "team" : "member",
      author: team ? teamName(str(c.author)) : memberName,
      body: String(c.body ?? ""),
      at: str(c.createdAt) ?? "",
      to: team ? undefined : "team",
    });
  });
  const lily = Array.isArray(doc.statusChatThread) ? doc.statusChatThread as Array<Record<string, unknown>> : [];
  lily.forEach((m, i) => {
    const ai = m.role === "assistant";
    out.push({
      id: `l${i}_${str(m.createdAt) ?? ""}`,
      kind: ai ? "ai" : "member",
      author: ai ? "AI assistant" : memberName,
      body: String(m.content ?? ""),
      at: str(m.createdAt) ?? "",
      to: ai ? undefined : "ai",
    });
  });
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** "mariela.solis@internationallegalpartner.com" → "Mariela Solis (ILP team)". */
export function teamName(author?: string): string {
  if (!author) return "Your ILP team";
  if (!author.includes("@")) return author;
  const local = author.split("@")[0];
  const name = local.split(/[._-]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");
  return name ? `${name} (ILP team)` : "Your ILP team";
}

// ─── Profile ───────────────────────────────────────────────────────────────

/** Coerce a submitted profile value: trims strings, "" → null (clears it). */
export function coerceProfileValue(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean" || typeof v === "number") return v;
  const s = String(v).trim().slice(0, 300);
  if (!s) return null;
  if (s === "true") return true;
  if (s === "false") return false;
  return s;
}
