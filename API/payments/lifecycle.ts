/**
 * API/payments/lifecycle.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Membership billing lifecycle after the first payment (P2).
 *
 *   Stripe mode (PAYMENTS_MODE=stripe), driven by webhooks:
 *     invoice.paid                   → roll the period, reset minutes/calls, clear past due
 *     invoice.payment_failed         → past_due + pastDueSince + CSM task
 *     customer.subscription.updated  → mirror cancel_at_period_end
 *     customer.subscription.deleted  → cancelled
 *   Manual mode, driven by staff + the hourly `membershipRenewalSweep`:
 *     staff "Mark paid" on an active/past_due membership → renewal paid
 *     periodEnd passes with no renewal paid → past_due
 *     periodEnd passes with cancelAtPeriodEnd → cancelled
 *
 * Grace: a past_due member keeps full access for GRACE_DAYS after
 * pastDueSince; after that booking is blocked with a plain message
 * (`accessFor()`; booking reads it, see docs/workstreams/P2.md Requests).
 *
 * The pure functions at the top are exported for tests (test/lifecycle_test.ts).
 */

import get from "../../db/get.ts";
import patch from "../../db/patch.ts";
import query from "../../db/query.ts";
import log from "../../helper/log.ts";
import auditLog from "../../helper/auditLog.ts";
import { emitEvent } from "../members/events.ts";
import { cancelUpcomingCalls } from "../members/assignment.ts";
import { COLLECTIONS, type CsmTask, type Membership } from "../../schemas/contracts.ts";

type Doc = Record<string, unknown>;
const DAY_MS = 86_400_000;
export const GRACE_DAYS = 7;
const SYSTEM = { uid: "system", email: "system", role: "system" };
const STRIPE = { uid: "stripe", email: "stripe", role: "system" };

/** Extra fields P2 keeps on a membership doc (not part of the shared contract). */
export type MembershipDoc = Membership & {
  lastInvoiceId?: string;
  renewalPaidFor?: string | null; // periodEnd a manual renewal was paid for in advance
  renewalPaidRef?: string | null;
  cancelRequestedAt?: string | null;
  sourceLeadId?: string;
};

// ─── Pure helpers ─────────────────────────────────────────────────────────

export function addMonths(iso: string, n: number): string {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString();
}

/**
 * The next billing period. A Stripe invoice gives it explicitly. Otherwise the
 * period continues from the old periodEnd (the anniversary is kept) unless the
 * payment came more than a month late, then it starts now.
 */
export function nextPeriod(
  m: Pick<Membership, "periodEnd">,
  now: Date,
  invoicePeriod?: { start: string; end: string },
): { periodStart: string; periodEnd: string } {
  if (invoicePeriod) return { periodStart: invoicePeriod.start, periodEnd: invoicePeriod.end };
  const oldEnd = Date.parse(m.periodEnd);
  let start = Number.isFinite(oldEnd) && now.getTime() - oldEnd < 31 * DAY_MS ? m.periodEnd : now.toISOString();
  let end = addMonths(start, 1);
  // Never hand back a period that has already ended.
  while (Date.parse(end) <= now.getTime()) {
    start = end;
    end = addMonths(start, 1);
  }
  return { periodStart: start, periodEnd: end };
}

/** Fields that start a fresh paid period. */
export function renewalFields(
  m: Pick<Membership, "periodEnd">,
  now: Date,
  invoicePeriod?: { start: string; end: string },
): Doc {
  return {
    status: "active",
    ...nextPeriod(m, now, invoicePeriod),
    minutesUsed: 0,
    callsUsed: 0,
    pastDueSince: null,
    renewalPaidFor: null,
    renewalPaidRef: null,
    updatedAt: now.toISOString(),
  };
}

export interface Access {
  /** The member can use the portal and book calls. */
  canBook: boolean;
  /** past_due but still inside the grace window. */
  inGrace: boolean;
  /** When access pauses (past_due only). */
  graceEndsAt?: string;
  /** Plain message for the member when they cannot book, or a gentle note in grace. */
  message?: string;
}

/** Membership access with the past-due grace window. Pure. */
export function accessFor(
  m: Pick<Membership, "status" | "pastDueSince" | "periodEnd"> | null,
  now: Date = new Date(),
): Access {
  if (!m) return { canBook: false, inGrace: false, message: "You need an active membership to book a call." };
  if (m.status === "active") return { canBook: true, inGrace: false };
  if (m.status === "past_due") {
    const since = Date.parse(m.pastDueSince ?? m.periodEnd);
    const ends = Number.isFinite(since) ? new Date(since + GRACE_DAYS * DAY_MS) : now;
    if (now < ends) {
      return {
        canBook: true,
        inGrace: true,
        graceEndsAt: ends.toISOString(),
        message: "Your last membership payment did not go through. Your access continues while you update it.",
      };
    }
    return {
      canBook: false,
      inGrace: false,
      graceEndsAt: ends.toISOString(),
      message:
        "Your membership is paused because the last payment did not go through. Once it is paid, you can book calls again.",
    };
  }
  if (m.status === "pending") {
    return { canBook: false, inGrace: false, message: "Your membership starts once the first payment is received." };
  }
  return { canBook: false, inGrace: false, message: "Your membership has ended, so calls cannot be booked." };
}

export type SweepAction = "past_due" | "cancelled" | "renewed" | null;

/** What the manual-mode sweep does with one membership. Pure. */
export function manualSweepAction(m: MembershipDoc, now: Date): SweepAction {
  if (m.status !== "active") return null;
  if (!String(m.paymentRef ?? "").startsWith("manual")) return null; // Stripe drives its own
  if (Date.parse(m.periodEnd) > now.getTime()) return null;
  if (m.cancelAtPeriodEnd) return "cancelled";
  if (m.renewalPaidFor && m.renewalPaidFor === m.periodEnd) return "renewed";
  return "past_due";
}

/** Days since a past-due payment started (0 on the day). Pure. */
export function daysPastDue(m: Pick<Membership, "pastDueSince">, now: Date): number | null {
  if (!m.pastDueSince) return null;
  const t = Date.parse(m.pastDueSince);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / DAY_MS);
}

// ─── Stripe object readers (API versions differ) ──────────────────────────

const obj = (v: unknown): Doc => (v && typeof v === "object" ? (v as Doc) : {});
const strOf = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Subscription id an invoice belongs to (2024 and 2025+ API shapes). */
export function invoiceSubscriptionId(inv: Doc): string | undefined {
  const direct = inv.subscription;
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object") return strOf(obj(direct).id);
  const parent = obj(obj(inv.parent).subscription_details);
  const s = parent.subscription;
  return typeof s === "string" ? s : strOf(obj(s).id);
}

/** membershipId we stamped on the subscription metadata at checkout. */
export function invoiceMembershipId(inv: Doc): string | undefined {
  const a = obj(obj(inv.subscription_details).metadata).membershipId;
  const b = obj(obj(obj(inv.parent).subscription_details).metadata).membershipId;
  const line = obj((obj(inv.lines).data as unknown[] | undefined)?.[0]);
  const c = obj(line.metadata).membershipId;
  return strOf(a) ?? strOf(b) ?? strOf(c);
}

/** Billing period of the subscription line (unix seconds → ISO). */
export function invoicePeriod(inv: Doc): { start: string; end: string } | undefined {
  const lines = (obj(inv.lines).data as unknown[] | undefined) ?? [];
  for (const l of lines) {
    const p = obj(obj(l).period);
    const s = Number(p.start);
    const e = Number(p.end);
    if (s > 0 && e > s && obj(l).type !== "invoiceitem") {
      return { start: new Date(s * 1000).toISOString(), end: new Date(e * 1000).toISOString() };
    }
  }
  return undefined;
}

// ─── Data access ──────────────────────────────────────────────────────────

export async function membershipById(id: string): Promise<MembershipDoc | null> {
  if (!id) return null;
  const m = (await get(COLLECTIONS.memberships, id).catch(() => null)) as MembershipDoc | null;
  return m ? { ...m, id } : null;
}

export async function membershipByRef(paymentRef: string): Promise<MembershipDoc | null> {
  if (!paymentRef) return null;
  const rows = (await query(COLLECTIONS.memberships, [{ field: "paymentRef", op: "EQUAL", value: paymentRef }])
    .catch(() => [])) as unknown as MembershipDoc[];
  // Prefer the live one if a person ever has two.
  return rows.find((m) => m.status !== "cancelled") ?? rows[0] ?? null;
}

export async function currentMembership(clientId: string): Promise<MembershipDoc | null> {
  const rows = (await query(COLLECTIONS.memberships, [{ field: "clientId", op: "EQUAL", value: clientId }])
    .catch(() => [])) as unknown as MembershipDoc[];
  const rank: Record<string, number> = { active: 0, past_due: 1, pending: 2, cancelled: 3 };
  return [...rows].sort((a, b) =>
    (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || String(b.createdAt).localeCompare(String(a.createdAt))
  )[0] ?? null;
}

// ─── CSM tasks for lifecycle moments ──────────────────────────────────────

/**
 * Create the CSM task for a lifecycle moment through the shared TASK_RULES
 * engine (emitEvent). `key` makes it idempotent per episode (task id =
 * taskIdFor(event, key)); `sourceId` is the record the task points at.
 */
export async function lifecycleTask(
  event: "membership.past_due" | "membership.cancel_requested" | "feedback.low_score",
  p: {
    clientId: string;
    key: string;
    csmEmail?: string;
    detail?: string;
    sourceId?: string;
    sourceKind?: CsmTask["source"]["kind"];
  },
): Promise<string | null> {
  const ids = await emitEvent(event, {
    clientId: p.clientId,
    dedupeKey: p.key,
    sourceId: p.sourceId,
    sourceKind: p.sourceKind,
    ownerEmail: p.csmEmail,
    detail: p.detail,
  });
  return ids[0] ?? null;
}

// ─── Transitions ──────────────────────────────────────────────────────────

export type Actor = { uid: string; email: string; role: string };

/** Hooks other P2 modules attach (emails). Kept here so lifecycle has no email imports. */
export const lifecycleHooks: {
  onActivated?: (m: MembershipDoc) => Promise<void>; // P7: join confirmation email
  onRenewed?: (m: MembershipDoc, ref: string) => Promise<void>;
  onPastDue?: (m: MembershipDoc) => Promise<void>;
  onCancelled?: (m: MembershipDoc) => Promise<void>;
  onCancelRequested?: (m: MembershipDoc) => Promise<void>;
} = {};

export async function runHook(name: keyof typeof lifecycleHooks, m: MembershipDoc, ref = ""): Promise<void> {
  try {
    const fn = lifecycleHooks[name] as ((m: MembershipDoc, ref: string) => Promise<void>) | undefined;
    if (fn) await fn(m, ref);
  } catch (err) {
    log(`[lifecycle] hook ${name} failed: ${err instanceof Error ? err.message : err}`, "error");
  }
}

/** Start the next paid period now (renewal paid). */
export async function renewMembership(
  m: MembershipDoc,
  ref: string,
  actor: Actor,
  opts: { invoicePeriod?: { start: string; end: string }; invoiceId?: string; now?: Date } = {},
): Promise<MembershipDoc> {
  const now = opts.now ?? new Date();
  const fields = renewalFields(m, now, opts.invoicePeriod);
  if (opts.invoiceId) fields.lastInvoiceId = opts.invoiceId;
  await patch(COLLECTIONS.memberships, m.id, fields);
  await patch(COLLECTIONS.clients, m.clientId, { membershipStatus: "active", updatedAt: now.toISOString() }).catch(() => {});
  await auditLog({
    actor,
    action: "membership.renewed",
    target: `memberships/${m.id}`,
    meta: { ref, periodStart: fields.periodStart, periodEnd: fields.periodEnd, wasPastDue: m.status === "past_due" },
  });
  const after = { ...m, ...fields } as MembershipDoc;
  await runHook("onRenewed", after, ref);
  return after;
}

/** Payment failed (Stripe) or a manual period lapsed unpaid. Idempotent. */
export async function markPastDue(m: MembershipDoc, actor: Actor, since?: string): Promise<MembershipDoc> {
  if (m.status === "cancelled") return m;
  const now = new Date().toISOString();
  const already = m.status === "past_due" && !!m.pastDueSince;
  const fields: Doc = { status: "past_due", pastDueSince: m.pastDueSince || since || now, updatedAt: now };
  await patch(COLLECTIONS.memberships, m.id, fields);
  await patch(COLLECTIONS.clients, m.clientId, { membershipStatus: "past_due", updatedAt: now }).catch(() => {});
  const after = { ...m, ...fields } as MembershipDoc;
  if (!already) {
    await auditLog({ actor, action: "membership.past_due", target: `memberships/${m.id}`, meta: { since: fields.pastDueSince } });
    // One task per past-due episode.
    await lifecycleTask("membership.past_due", {
      clientId: m.clientId,
      key: `${m.id}_${String(fields.pastDueSince).slice(0, 10)}`,
      csmEmail: m.csmEmail,
      sourceId: m.id,
    });
  }
  await runHook("onPastDue", after);
  return after;
}

export async function markCancelled(m: MembershipDoc, actor: Actor, reason: string): Promise<MembershipDoc> {
  if (m.status === "cancelled") return m;
  const now = new Date().toISOString();
  const fields: Doc = { status: "cancelled", cancelledAt: now, updatedAt: now };
  await patch(COLLECTIONS.memberships, m.id, fields);
  await patch(COLLECTIONS.clients, m.clientId, { membershipStatus: "cancelled", updatedAt: now }).catch(() => {});
  // REL: the membership has ended, so booked calls from now on are cancelled
  // (never charged); the lawyer's day and both inboxes are told.
  const calls = await cancelUpcomingCalls(m.clientId, { email: actor.email || "system", role: "system" }, "Membership ended");
  await auditLog({ actor, action: "membership.cancelled", target: `memberships/${m.id}`, meta: { reason, cancelledCalls: calls } });
  const after = { ...m, ...fields } as MembershipDoc;
  await runHook("onCancelled", after);
  return after;
}

/**
 * Staff "Mark paid" on a membership that is already running (manual mode).
 * After periodEnd (or while past due) the next period starts now; before
 * periodEnd the payment is recorded and the sweep rolls the period on time.
 */
export async function markRenewalPaid(
  m: MembershipDoc,
  ref: string,
  actor: Actor,
  now: Date = new Date(),
): Promise<{ membership: MembershipDoc; rolled: boolean }> {
  if (m.status === "past_due" || Date.parse(m.periodEnd) <= now.getTime()) {
    return { membership: await renewMembership(m, ref, actor, { now }), rolled: true };
  }
  const fields: Doc = { renewalPaidFor: m.periodEnd, renewalPaidRef: ref, updatedAt: now.toISOString() };
  await patch(COLLECTIONS.memberships, m.id, fields);
  await auditLog({ actor, action: "membership.renewal_prepaid", target: `memberships/${m.id}`, meta: { ref, periodEnd: m.periodEnd } });
  return { membership: { ...m, ...fields } as MembershipDoc, rolled: false };
}

// ─── Stripe webhook handlers ──────────────────────────────────────────────

async function membershipForInvoice(inv: Doc): Promise<MembershipDoc | null> {
  const sub = invoiceSubscriptionId(inv);
  return (sub ? await membershipByRef(sub) : null) ?? (await membershipById(invoiceMembershipId(inv) ?? ""));
}

/**
 * invoice.paid. The first invoice is handled by checkout.session.completed
 * (`activate` is called here too in case the events arrive out of order);
 * every later invoice starts a fresh period. Idempotent per invoice id.
 */
export async function onInvoicePaid(
  inv: Doc,
  activate: (membershipId: string, ref: string) => Promise<unknown>,
): Promise<string> {
  const m = await membershipForInvoice(inv);
  const invoiceId = strOf(inv.id) ?? "";
  if (!m) return "no membership";
  if (invoiceId && m.lastInvoiceId === invoiceId) return "duplicate";
  const sub = invoiceSubscriptionId(inv) ?? "";
  if (m.status === "pending" || inv.billing_reason === "subscription_create") {
    if (m.status === "pending") await activate(m.id, sub || m.id);
    await patch(COLLECTIONS.memberships, m.id, { lastInvoiceId: invoiceId });
    return "first invoice";
  }
  if (m.status === "cancelled") return "cancelled";
  await renewMembership(m, sub, STRIPE, { invoicePeriod: invoicePeriod(inv), invoiceId });
  return "renewed";
}

export async function onInvoiceFailed(inv: Doc): Promise<string> {
  const m = await membershipForInvoice(inv);
  if (!m) return "no membership";
  if (m.status === "pending") return "not active yet"; // checkout never completed
  await markPastDue(m, STRIPE);
  return "past_due";
}

export async function onSubscriptionUpdated(sub: Doc): Promise<string> {
  const m = await membershipByRef(strOf(sub.id) ?? "");
  if (!m) return "no membership";
  const flag = sub.cancel_at_period_end === true;
  if (!!m.cancelAtPeriodEnd === flag) return "unchanged";
  await patch(COLLECTIONS.memberships, m.id, {
    cancelAtPeriodEnd: flag,
    ...(flag ? {} : { cancelRequestedAt: null }),
    updatedAt: new Date().toISOString(),
  });
  await auditLog({ actor: STRIPE, action: flag ? "membership.cancel_requested" : "membership.cancel_undone", target: `memberships/${m.id}`, meta: { via: "stripe" } });
  return flag ? "cancel_at_period_end" : "cancel undone";
}

export async function onSubscriptionDeleted(sub: Doc): Promise<string> {
  const m = await membershipByRef(strOf(sub.id) ?? "");
  if (!m) return "no membership";
  await markCancelled(m, STRIPE, "stripe subscription deleted");
  return "cancelled";
}

// ─── Manual-mode sweep (hourly) ───────────────────────────────────────────

export async function membershipRenewalSweep(now: Date = new Date()): Promise<Record<string, number>> {
  const counts: Record<string, number> = { past_due: 0, cancelled: 0, renewed: 0 };
  const rows = (await query(COLLECTIONS.memberships, [{ field: "status", op: "EQUAL", value: "active" }])
    .catch(() => [])) as unknown as MembershipDoc[];
  for (const m of rows) {
    const action = manualSweepAction(m, now);
    if (!action) continue;
    try {
      if (action === "cancelled") await markCancelled(m, SYSTEM, "cancel at period end");
      else if (action === "renewed") await renewMembership(m, String(m.renewalPaidRef ?? "manual"), SYSTEM, { now });
      else await markPastDue(m, SYSTEM, m.periodEnd);
      counts[action]++;
    } catch (err) {
      log(`[lifecycle] sweep ${m.id} failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }
  if (counts.past_due + counts.cancelled + counts.renewed) {
    log(`[lifecycle] renewal sweep: ${JSON.stringify(counts)}`, "payments");
  }
  return counts;
}
