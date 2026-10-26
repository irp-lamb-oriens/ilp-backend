/**
 * API/dashboard/staffHome/compute.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Pure functions behind the staff Today page (W6): KPI strip, "Needs
 * attention" rail, members list rows and the member timeline. No I/O here, so
 * every number can be tested with plain objects (test/staffHome_test.ts).
 *
 * Money is integer cents (USD). Platform revenue (memberships) and legal fees
 * (accepted quotes, "legal GMV") are always reported apart (docs/PLAN.md).
 */

import {
  type Consultation,
  type CsmTask,
  type Handoff,
  type Matter,
  type Membership,
  type Obligation,
  PLAN_STANDARD,
  profileCompleteness,
} from "../../../schemas/contracts.ts";

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

type Doc = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const ms = (iso: unknown): number => {
  const t = Date.parse(str(iso));
  return Number.isNaN(t) ? NaN : t;
};

// ─── Profile ───────────────────────────────────────────────────────────────

/** Same merge as members/service.ts profileRecord (nested fields, then top level). */
export function profileOf(client: Doc | null | undefined): Doc {
  if (!client) return {};
  return {
    ...((client.profile as Doc) ?? {}),
    ...((client.fields as Doc) ?? {}),
    ...((client.clientFields as Doc) ?? {}),
    ...client,
  };
}

export function displayName(client: Doc | null | undefined, fallback = ""): string {
  if (!client) return fallback;
  const p = profileOf(client);
  const joined = [str(client.name), str(client.surname)].filter(Boolean).join(" ");
  return joined || str(p.fullName) || str(client.email) || fallback;
}

// ─── Quotes (embedded on the clients doc) ──────────────────────────────────

const SENT_STATUSES = new Set(["sent", "sent_to_client"]);
const ACCEPTED_STATUSES = new Set(["client_accepted", "accepted", "paid"]);

export function quoteCents(q: Doc): number {
  if (typeof q.totalMinor === "number") return Math.round(q.totalMinor);
  if (typeof q.total === "number") return Math.round(q.total * 100);
  const lines = Array.isArray(q.lines) ? (q.lines as Doc[]) : [];
  return lines.reduce((n, l) => n + (typeof l.amountMinor === "number" ? l.amountMinor : 0), 0);
}

export function quoteSentAt(q: Doc): string {
  return str(q.sentToClientAt) || str(q.sentAt) || str(q.createdAt);
}

export function quoteAcceptedAt(q: Doc): string {
  return str(q.clientAcceptedAt) || str(q.acceptedAt);
}

export function isQuoteOpen(q: Doc): boolean {
  return SENT_STATUSES.has(str(q.status));
}

export function isQuoteAccepted(q: Doc): boolean {
  return ACCEPTED_STATUSES.has(str(q.status));
}

export function quotesOf(client: Doc | null | undefined): Doc[] {
  return Array.isArray(client?.quotes) ? (client!.quotes as Doc[]) : [];
}

// ─── KPIs ──────────────────────────────────────────────────────────────────

export interface StaffKpis {
  generatedAt: string;
  mrr: { cents: number; activeMembers: number; deltaCents24h: number; deltaCents7d: number };
  retentionM3: { pct: number | null; retained: number; cohort: number };
  consultationReady: { pct: number | null; ready: number; active: number };
  handoffSla: { pct: number | null; within24h: number; total: number };
  overdueTasks: { total: number; mine: number };
  /** Kept apart from platform revenue: accepted legal-work quotes, last 30 days. */
  legalGmv30d: { cents: number; quotes: number };
  /** Membership revenue billed in the last 30 days (activation + months), for comparison. */
  platformRevenue30d: { cents: number };
}

const isLive = (m: Membership) => m.status === "active";

/** Active-member count at a past moment, reconstructed from activatedAt / cancelledAt. */
export function activeAt(memberships: Membership[], at: number): number {
  return memberships.filter((m) => {
    const a = ms(m.activatedAt);
    if (Number.isNaN(a) || a > at) return false;
    const c = ms(m.cancelledAt);
    if (!Number.isNaN(c) && c <= at) return false;
    // A membership that is not active now and has no cancel date is counted only if active now.
    return m.status === "active" || m.status === "past_due" || !Number.isNaN(c);
  }).length;
}

export function computeKpis(input: {
  memberships: Membership[];
  clients: Map<string, Doc>;
  tasks: CsmTask[];
  handoffs: Handoff[];
  consultations: Consultation[];
  me?: string;
  now?: Date;
}): StaffKpis {
  const now = (input.now ?? new Date()).getTime();
  const monthly = PLAN_STANDARD.monthlyCents;
  const ms30 = now - 30 * DAY_MS;

  // One membership per member: prefer the active one.
  const live = input.memberships.filter(isLive);
  const mrrCents = live.length * monthly;
  const activeNow = activeAt(input.memberships, now);
  const d24 = (activeNow - activeAt(input.memberships, now - DAY_MS)) * monthly;
  const d7 = (activeNow - activeAt(input.memberships, now - 7 * DAY_MS)) * monthly;

  // Month-3 retention: members activated 90+ days ago still paying (active or past_due).
  const cohort = input.memberships.filter((m) => {
    const a = ms(m.activatedAt);
    return !Number.isNaN(a) && a <= now - 90 * DAY_MS;
  });
  const retained = cohort.filter((m) => m.status === "active" || m.status === "past_due").length;

  // Consultation-ready share of active members.
  let ready = 0;
  for (const m of live) {
    if (profileCompleteness(profileOf(input.clients.get(m.clientId))).consultationReady) ready++;
  }

  // Handoff SLA: approvedAt − consultation.endedAt ≤ 24 h.
  const consById = new Map(input.consultations.map((c) => [c.id, c]));
  let slaTotal = 0;
  let slaOk = 0;
  for (const h of input.handoffs) {
    const c = consById.get(h.consultationId);
    const end = ms(c?.endedAt ?? c?.scheduledAt);
    const ok = ms(h.approvedAt);
    if (Number.isNaN(end) || Number.isNaN(ok)) continue;
    slaTotal++;
    if (ok - end <= 24 * HOUR_MS) slaOk++;
  }

  const open = input.tasks.filter((t) => t.status === "open");
  const overdue = open.filter((t) => ms(t.dueAt) < now);
  const me = (input.me ?? "").toLowerCase();

  let gmv = 0;
  let gmvQuotes = 0;
  let platform = 0;
  for (const c of input.clients.values()) {
    for (const q of quotesOf(c)) {
      if (!isQuoteAccepted(q)) continue;
      const at = ms(quoteAcceptedAt(q) || q.updatedAt || q.createdAt);
      if (Number.isNaN(at) || at < ms30) continue;
      gmv += quoteCents(q);
      gmvQuotes++;
    }
    const charges = Array.isArray(c.charges) ? (c.charges as Doc[]) : [];
    for (const ch of charges) {
      if (str(ch.status) !== "paid") continue;
      const at = ms(ch.paidAt ?? ch.createdAt);
      if (Number.isNaN(at) || at < ms30) continue;
      platform += typeof ch.amountMinor === "number" ? ch.amountMinor : 0;
    }
  }

  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

  return {
    generatedAt: new Date(now).toISOString(),
    mrr: { cents: mrrCents, activeMembers: live.length, deltaCents24h: d24, deltaCents7d: d7 },
    retentionM3: { pct: pct(retained, cohort.length), retained, cohort: cohort.length },
    consultationReady: { pct: pct(ready, live.length), ready, active: live.length },
    handoffSla: { pct: pct(slaOk, slaTotal), within24h: slaOk, total: slaTotal },
    overdueTasks: {
      total: overdue.length,
      mine: overdue.filter((t) => (t.ownerEmail ?? "").toLowerCase() === me).length,
    },
    legalGmv30d: { cents: gmv, quotes: gmvQuotes },
    platformRevenue30d: { cents: platform },
  };
}

// ─── Needs attention ───────────────────────────────────────────────────────

export interface AttentionItem {
  id: string;
  kind: "matter" | "obligation" | "quote" | "not_ready" | "unassigned";
  clientId: string;
  memberName: string;
  title: string;
  /** ISO reference: stage entry, due date, quote sent, join date. */
  at?: string;
  /** Days overdue / waiting / since joining, for sorting and badges. */
  days: number;
  ref?: string;
}

export interface Attention {
  overdueMatters: AttentionItem[];
  obligationsDue: AttentionItem[];
  quotesUnanswered: AttentionItem[];
  notReady: AttentionItem[];
  unassigned: AttentionItem[];
}

/** Matter is overdue when its next step is past due or it has sat 14+ days in its stage. */
export const MATTER_AGING_DAYS = 14;
export const QUOTE_UNANSWERED_DAYS = 5;
export const NOT_READY_AFTER_DAYS = 7;
export const OBLIGATION_WINDOW_DAYS = 14;

export function computeAttention(input: {
  memberships: Membership[];
  clients: Map<string, Doc>;
  matters: Matter[];
  obligations: Obligation[];
  now?: Date;
}): Attention {
  const now = (input.now ?? new Date()).getTime();
  const days = (from: number) => Math.max(0, Math.floor((now - from) / DAY_MS));
  const name = (id: string) => displayName(input.clients.get(id), id);
  const memberIds = new Set(input.memberships.map((m) => m.clientId));

  const overdueMatters: AttentionItem[] = [];
  for (const m of input.matters) {
    if (m.closedAt || m.stage === "closed") continue;
    const entered = ms(m.stageEnteredAt);
    const aging = Number.isNaN(entered) ? 0 : days(entered);
    const due = ms(m.nextStep?.dueAt);
    const stepLate = !Number.isNaN(due) && due < now;
    if (aging < MATTER_AGING_DAYS && !stepLate) continue;
    overdueMatters.push({
      id: `matter:${m.id}`,
      kind: "matter",
      clientId: m.clientId,
      memberName: name(m.clientId),
      title: stepLate ? `${m.title}: next step overdue (${m.nextStep!.what})` : m.title,
      at: m.stageEnteredAt,
      days: aging,
      ref: m.id,
    });
  }
  overdueMatters.sort((a, b) => b.days - a.days);

  const horizon = now + OBLIGATION_WINDOW_DAYS * DAY_MS;
  const obligationsDue: AttentionItem[] = input.obligations
    .filter((o) => (o.status === "upcoming" || o.status === "asked") && o.dueAt)
    .filter((o) => {
      const d = ms(o.dueAt);
      return !Number.isNaN(d) && d <= horizon;
    })
    .map((o) => ({
      id: `obligation:${o.id}`,
      kind: "obligation" as const,
      clientId: o.clientId,
      memberName: name(o.clientId),
      title: o.title,
      at: o.dueAt,
      days: Math.ceil((ms(o.dueAt) - now) / DAY_MS), // days left (negative = past)
      ref: o.id,
    }))
    .sort((a, b) => a.days - b.days);

  const quotesUnanswered: AttentionItem[] = [];
  for (const [clientId, c] of input.clients) {
    if (!memberIds.has(clientId)) continue;
    for (const q of quotesOf(c)) {
      if (!isQuoteOpen(q)) continue;
      const sent = ms(quoteSentAt(q));
      if (Number.isNaN(sent)) continue;
      const waited = days(sent);
      if (waited < QUOTE_UNANSWERED_DAYS) continue;
      quotesUnanswered.push({
        id: `quote:${clientId}:${str(q.id)}`,
        kind: "quote",
        clientId,
        memberName: name(clientId),
        title: str(q.title) || "Quote",
        at: quoteSentAt(q),
        days: waited,
        ref: str(q.id),
      });
    }
  }
  quotesUnanswered.sort((a, b) => b.days - a.days);

  const notReady: AttentionItem[] = [];
  const unassigned: AttentionItem[] = [];
  const assignedByClient = new Set(
    input.matters.filter((m) => !m.closedAt && m.assignedProviderId).map((m) => m.clientId),
  );
  for (const m of input.memberships) {
    if (m.status !== "active" && m.status !== "pending") continue;
    const client = input.clients.get(m.clientId);
    if (m.status === "active") {
      const joined = ms(m.activatedAt ?? m.createdAt);
      const since = Number.isNaN(joined) ? 0 : days(joined);
      const c = profileCompleteness(profileOf(client));
      if (since >= NOT_READY_AFTER_DAYS && !c.consultationReady) {
        notReady.push({
          id: `ready:${m.clientId}`,
          kind: "not_ready",
          clientId: m.clientId,
          memberName: name(m.clientId),
          title: `Profile ${Math.round(c.score * 100)}% complete`,
          at: m.activatedAt,
          days: since,
          ref: m.id,
        });
      }
    }
    if (!assignedByClient.has(m.clientId) && !str(client?.assignedProviderId)) {
      unassigned.push({
        id: `unassigned:${m.clientId}`,
        kind: "unassigned",
        clientId: m.clientId,
        memberName: name(m.clientId),
        title: m.status === "pending" ? "Pending payment, no lawyer yet" : "No lawyer assigned",
        at: m.activatedAt ?? m.createdAt,
        days: days(ms(m.activatedAt ?? m.createdAt) || now),
        ref: m.id,
      });
    }
  }
  notReady.sort((a, b) => b.days - a.days);
  unassigned.sort((a, b) => b.days - a.days);

  return { overdueMatters, obligationsDue, quotesUnanswered, notReady, unassigned };
}

// ─── Members list ──────────────────────────────────────────────────────────

export interface MemberRow {
  clientId: string;
  membershipId: string;
  name: string;
  email: string;
  status: Membership["status"];
  country: string;
  csmEmail: string | null;
  activatedAt: string | null;
  periodEnd: string | null;
  minutesUsed: number;
  minutesIncluded: number;
  callsUsed: number;
  callsIncluded: number;
  completeness: number;
  consultationReady: boolean;
  openTasks: number;
}

/** One row per member: the active membership wins, else the newest. */
export function latestMembershipPerClient(memberships: Membership[]): Membership[] {
  const by = new Map<string, Membership>();
  for (const m of memberships) {
    const cur = by.get(m.clientId);
    if (!cur) {
      by.set(m.clientId, m);
      continue;
    }
    const better = (m.status === "active" && cur.status !== "active") ||
      ((m.status === "active") === (cur.status === "active") && str(m.createdAt) > str(cur.createdAt));
    if (better) by.set(m.clientId, m);
  }
  return [...by.values()];
}

export function memberRows(
  memberships: Membership[],
  clients: Map<string, Doc>,
  tasks: CsmTask[] = [],
): MemberRow[] {
  const openByClient = new Map<string, number>();
  for (const t of tasks) if (t.status === "open") openByClient.set(t.clientId, (openByClient.get(t.clientId) ?? 0) + 1);
  return latestMembershipPerClient(memberships).map((m) => {
    const c = clients.get(m.clientId) ?? null;
    const comp = profileCompleteness(profileOf(c));
    return {
      clientId: m.clientId,
      membershipId: m.id,
      name: displayName(c, m.clientId),
      email: str(c?.email),
      status: m.status,
      country: m.country ?? "CR",
      csmEmail: m.csmEmail ?? null,
      activatedAt: m.activatedAt ?? null,
      periodEnd: m.periodEnd ?? null,
      minutesUsed: m.minutesUsed ?? 0,
      minutesIncluded: m.minutesIncluded ?? PLAN_STANDARD.minutesIncluded,
      callsUsed: m.callsUsed ?? 0,
      callsIncluded: m.callsIncluded ?? PLAN_STANDARD.callsIncluded,
      completeness: Math.round(comp.score * 1000) / 1000,
      consultationReady: comp.consultationReady,
      openTasks: openByClient.get(m.clientId) ?? 0,
    };
  });
}

export interface MemberQuery {
  status?: string;
  csm?: string;
  ready?: "ready" | "not_ready" | "";
  country?: string;
  q?: string;
  sort?: "name" | "joined" | "completeness" | "renewal";
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export function filterMembers(rows: MemberRow[], query: MemberQuery) {
  const q = (query.q ?? "").trim().toLowerCase();
  let out = rows.filter((r) =>
    (!query.status || r.status === query.status) &&
    (!query.csm || (query.csm === "none" ? !r.csmEmail : (r.csmEmail ?? "").toLowerCase() === query.csm.toLowerCase())) &&
    (!query.country || r.country === query.country) &&
    (!query.ready || (query.ready === "ready") === r.consultationReady) &&
    (!q || r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q) || r.clientId.toLowerCase().includes(q))
  );
  const dir = query.dir === "desc" ? -1 : 1;
  const key = query.sort ?? "name";
  const val = (r: MemberRow): string | number =>
    key === "joined" ? r.activatedAt ?? "" : key === "completeness" ? r.completeness : key === "renewal" ? r.periodEnd ?? "" : r.name.toLowerCase();
  out = [...out].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
  });
  const pageSize = Math.min(Math.max(1, query.pageSize ?? 25), 100);
  const total = out.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, query.page ?? 1), pages);
  return { items: out.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize, pages };
}

// ─── Member timeline ───────────────────────────────────────────────────────

export interface TimelineEntry {
  id: string;
  kind: "consultation" | "handoff" | "task" | "quote" | "note" | "audit" | "membership";
  at: string;
  title: string;
  body?: string;
  actor?: string;
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  ref?: string;
}

export function buildTimeline(input: {
  client: Doc | null;
  memberships: Membership[];
  consultations: Consultation[];
  handoffs: Handoff[];
  tasks: CsmTask[];
  audit: Doc[];
  providerNames?: Map<string, string>;
}): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const lawyer = (id: string) => input.providerNames?.get(id) ?? id;

  for (const m of input.memberships) {
    if (m.activatedAt) {
      out.push({ id: `mem:${m.id}:act`, kind: "membership", at: m.activatedAt, title: "Membership activated", tone: "success", ref: m.id });
    } else if (m.createdAt) {
      out.push({ id: `mem:${m.id}:new`, kind: "membership", at: m.createdAt, title: "Joined, payment pending", tone: "warning", ref: m.id });
    }
    if (m.cancelledAt) out.push({ id: `mem:${m.id}:cxl`, kind: "membership", at: m.cancelledAt, title: "Membership cancelled", tone: "danger", ref: m.id });
  }

  for (const c of input.consultations) {
    const label = c.status === "completed" ? "Call completed" : c.status === "booked" ? "Call booked" : `Call ${c.status.replace("_", " ")}`;
    out.push({
      id: `con:${c.id}`,
      kind: "consultation",
      at: c.status === "completed" ? c.endedAt ?? c.scheduledAt : c.scheduledAt,
      title: `${label} with ${lawyer(c.providerId)}`,
      body: c.summary?.text
        ? `${c.summary.status === "confirmed" ? "Confirmed summary" : "Suggested summary (not confirmed)"}: ${c.summary.text}`
        : c.question,
      tone: c.status === "completed" ? "success" : c.status === "no_show" || c.status === "cancelled" ? "warning" : "info",
      ref: c.id,
    });
  }

  for (const h of input.handoffs) {
    out.push({
      id: `hof:${h.id}`,
      kind: "handoff",
      at: h.approvedAt,
      title: `Handoff approved by ${lawyer(h.providerId)}`,
      body: h.legalNextSteps.map((s) => `${s.what} (${s.who})`).join("; "),
      actor: lawyer(h.providerId),
      tone: h.commercialNotes ? "info" : "neutral",
      ref: h.id,
    });
  }

  for (const t of input.tasks) {
    out.push({ id: `task:${t.id}:open`, kind: "task", at: t.createdAt, title: `Task opened: ${t.title}`, actor: t.ownerEmail, tone: "neutral", ref: t.id });
    if (t.closedAt && t.status !== "open") {
      out.push({
        id: `task:${t.id}:close`,
        kind: "task",
        at: t.closedAt,
        title: `Task ${t.status === "done" ? "closed" : "cancelled"}: ${t.title}`,
        body: t.outcome,
        actor: str((t as unknown as Doc).closedBy) || t.ownerEmail,
        tone: t.status === "done" ? "success" : "neutral",
        ref: t.id,
      });
    }
  }

  for (const q of quotesOf(input.client)) {
    const id = str(q.id);
    const created = str(q.createdAt);
    const usd = (quoteCents(q) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
    if (created) out.push({ id: `quote:${id}:new`, kind: "quote", at: created, title: `Quote created: ${str(q.title) || "Quote"}`, body: usd, actor: str(q.createdBy), ref: id });
    const sent = str(q.sentToClientAt) || (isQuoteOpen(q) ? str(q.sentAt) : "");
    if (sent && sent !== created) out.push({ id: `quote:${id}:sent`, kind: "quote", at: sent, title: `Quote sent: ${str(q.title) || "Quote"}`, body: usd, tone: "info", ref: id });
    const acc = quoteAcceptedAt(q);
    if (acc) out.push({ id: `quote:${id}:acc`, kind: "quote", at: acc, title: `Quote accepted: ${str(q.title) || "Quote"}`, body: usd, tone: "success", ref: id });
  }

  const notes = Array.isArray(input.client?.notes) ? (input.client!.notes as Doc[]) : [];
  notes.forEach((n, i) => {
    const at = str(n.createdAt) || str(n.timestamp);
    if (!at) return;
    out.push({ id: `note:${str(n.id) || i}`, kind: "note", at, title: "Note", body: str(n.text), actor: str(n.author) });
  });

  for (const a of input.audit) {
    const at = str(a.at);
    if (!at) continue;
    const actor = a.actor as Doc | undefined;
    out.push({
      id: `audit:${str(a.id) || at}`,
      kind: "audit",
      at,
      title: auditLabel(str(a.action)),
      actor: actor ? `${str(actor.email)} (${str(actor.role)})` : undefined,
      tone: "neutral",
      ref: str(a.target),
    });
  }

  return out.filter((e) => e.at).sort((a, b) => b.at.localeCompare(a.at));
}

const AUDIT_LABELS: Record<string, string> = {
  "membership.activated": "Membership payment recorded",
  "membership.created": "Membership created",
  "membership.past_due": "Payment failed (past due)",
  "membership.cancelled": "Membership cancelled",
  "staff.assign_lawyer": "Lawyer assigned",
  "staff.proposal_task": "Proposal task created from handoff",
  "auth.staff_bypass": "Staff viewed the member portal",
  "auth.login": "Signed in",
};

export function auditLabel(action: string): string {
  return AUDIT_LABELS[action] ?? action.replace(/[._]/g, " ");
}
