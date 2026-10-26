/**
 * API/members/service.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Domain helpers for the member core loop, shared by the staff, client and
 * lawyer routes in membersRouter.ts and importable by other routers
 * (W3 join, W4 client home, W5 lawyer home, W6 staff home).
 */

import get from "../../db/get.ts";
import {
  createRecord,
  findRecords,
  getRecord,
  listByClient,
  stripFields,
  updateRecord,
} from "../../db/records.ts";
import {
  CLIENT_HIDDEN_FIELDS,
  COLLECTIONS,
  type Consultation,
  type CountryCode,
  type CsmTask,
  type Handoff,
  type LegalNextStep,
  LAWYER_HIDDEN_FIELDS,
  type Matter,
  type Membership,
  type Obligation,
  PLAN_STANDARD,
  profileCompleteness,
} from "../../schemas/contracts.ts";

export const nowIso = () => new Date().toISOString();

/** URL slug → collection. Slugs are what the REST routes accept. */
export const SLUG_TO_COLLECTION = {
  leads: COLLECTIONS.leads,
  memberships: COLLECTIONS.memberships,
  matters: COLLECTIONS.matters,
  consultations: COLLECTIONS.consultations,
  handoffs: COLLECTIONS.handoffs,
  "csm-tasks": COLLECTIONS.csmTasks,
  obligations: COLLECTIONS.obligations,
} as const;
export type Slug = keyof typeof SLUG_TO_COLLECTION;
export const isSlug = (s: string): s is Slug => s in SLUG_TO_COLLECTION;

/** Fields a POST must carry, per collection. */
export const REQUIRED_FIELDS: Record<Slug, string[]> = {
  leads: ["email", "country"],
  memberships: ["clientId"],
  matters: ["clientId", "title", "area"],
  consultations: ["clientId", "providerId", "scheduledAt"],
  handoffs: ["consultationId", "clientId", "providerId"],
  "csm-tasks": ["clientId", "type", "title", "dueAt"],
  obligations: ["clientId", "ruleId", "title"],
};

export function missingFields(slug: Slug, body: Record<string, unknown>): string[] {
  return REQUIRED_FIELDS[slug].filter((k) => body[k] === undefined || body[k] === null || body[k] === "");
}

/** Fill contract defaults so partial POST bodies become valid records. */
export function withDefaults(slug: Slug, body: Record<string, unknown>): Record<string, unknown> {
  const now = nowIso();
  const country = (body.country as CountryCode) ?? "CR";
  switch (slug) {
    case "leads":
      return { answers: {}, findings: [], source: "deadline_check", createdAt: now, ...body };
    case "memberships": {
      const start = (body.periodStart as string) ?? now;
      return {
        plan: PLAN_STANDARD.id,
        status: "pending",
        country,
        periodStart: start,
        periodEnd: addMonths(start, 1),
        minutesIncluded: PLAN_STANDARD.minutesIncluded,
        minutesUsed: 0,
        callsIncluded: PLAN_STANDARD.callsIncluded,
        callsUsed: 0,
        createdAt: now,
        updatedAt: now,
        ...body,
      };
    }
    case "matters":
      return { country, stage: "intake", stageEnteredAt: now, openedAt: now, ...body };
    case "consultations":
      return {
        durationMin: PLAN_STANDARD.callLengthMin,
        status: "booked",
        consent: { recording: "pending" },
        createdAt: now,
        ...body,
      };
    case "handoffs":
      return { legalNextSteps: [], approvedAt: now, csmTaskIds: [], ...body };
    case "csm-tasks":
      return { status: "open", source: { kind: "manual" }, createdAt: now, ...body };
    case "obligations":
      return { country, status: "upcoming", ...body };
  }
}

export function addMonths(iso: string, n: number): string {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString();
}

// ─── Visibility ────────────────────────────────────────────────────────────

/** Remove fields lawyers must never see (margins, commercial notes). */
export function forLawyer<T>(value: T): T {
  return stripFields(value, LAWYER_HIDDEN_FIELDS);
}

/** Remove fields clients must never see; handoffs also drop CSM task links. */
export function forClient<T>(value: T): T {
  return stripFields(value, [...CLIENT_HIDDEN_FIELDS, "csmTaskIds", "ownerEmail"]);
}

// ─── Membership ────────────────────────────────────────────────────────────

/** The member's current membership (active first, then most recent). */
export async function currentMembership(clientId: string): Promise<Membership | null> {
  const all = await listByClient<Membership>(COLLECTIONS.memberships, clientId, {
    sortBy: "createdAt",
    desc: true,
  });
  return all.find((m) => m.status === "active") ?? all[0] ?? null;
}

export function minutesLeft(m: Membership | null): number {
  if (!m) return 0;
  return Math.max(0, (m.minutesIncluded ?? 0) - (m.minutesUsed ?? 0));
}

export function callsLeft(m: Membership | null): number {
  if (!m) return 0;
  return Math.max(0, (m.callsIncluded ?? 0) - (m.callsUsed ?? 0));
}

/**
 * Charge a completed consultation against the member's membership once.
 * Idempotent: the consultation carries `chargedAt` after the first charge.
 */
export async function chargeConsultation(c: Consultation & { chargedAt?: string }): Promise<Membership | null> {
  if (c.status !== "completed" || c.chargedAt) return null;
  const m = await currentMembership(c.clientId);
  if (!m) return null;
  const minutes = Math.max(0, Math.round(c.minutesUsed ?? c.durationMin ?? PLAN_STANDARD.callLengthMin));
  const updated = await updateRecord<Membership>(COLLECTIONS.memberships, m.id, {
    minutesUsed: (m.minutesUsed ?? 0) + minutes,
    callsUsed: (m.callsUsed ?? 0) + 1,
    updatedAt: nowIso(),
  });
  await updateRecord(COLLECTIONS.consultations, c.id, { chargedAt: nowIso(), minutesUsed: minutes });
  return updated;
}

// ─── Member aggregate ──────────────────────────────────────────────────────

export interface MemberBundle {
  client: Record<string, unknown> | null;
  completeness: ReturnType<typeof profileCompleteness>;
  membership: Membership | null;
  minutesLeft: number;
  callsLeft: number;
  matters: Matter[];
  consultations: Consultation[];
  handoffs: Handoff[];
  tasks: CsmTask[];
  obligations: Obligation[];
  nextStep: { what: string; who: string; dueAt?: string; matterId?: string } | null;
}

/** Profile fields read from the client doc, with nested `fields` / `profile` fallbacks. */
export function profileRecord(client: Record<string, unknown> | null): Record<string, unknown> {
  if (!client) return {};
  const nested = {
    ...((client.profile as Record<string, unknown>) ?? {}),
    ...((client.fields as Record<string, unknown>) ?? {}),
    ...((client.clientFields as Record<string, unknown>) ?? {}),
  };
  return { ...nested, ...client };
}

/** The single most useful "what happens next" for a member. */
export function pickNextStep(
  matters: Matter[],
  handoffs: Handoff[],
): MemberBundle["nextStep"] {
  const open = matters.filter((m) => !m.closedAt && m.nextStep);
  const fromMatter = open
    .map((m) => ({ ...m.nextStep!, matterId: m.id }))
    .sort((a, b) => String(a.dueAt ?? "9999").localeCompare(String(b.dueAt ?? "9999")))[0];
  if (fromMatter) return fromMatter;
  const latest = [...handoffs].sort((a, b) => b.approvedAt.localeCompare(a.approvedAt))[0];
  const step: LegalNextStep | undefined = latest?.legalNextSteps?.[0];
  return step ? { ...step, matterId: latest.matterId } : null;
}

export async function memberBundle(clientId: string): Promise<MemberBundle> {
  const [client, membership, matters, consultations, handoffs, tasks, obligations] = await Promise.all([
    get(COLLECTIONS.clients, clientId),
    currentMembership(clientId),
    listByClient<Matter>(COLLECTIONS.matters, clientId, { sortBy: "openedAt", desc: true }),
    listByClient<Consultation>(COLLECTIONS.consultations, clientId, { sortBy: "scheduledAt", desc: true }),
    listByClient<Handoff>(COLLECTIONS.handoffs, clientId, { sortBy: "approvedAt", desc: true }),
    listByClient<CsmTask>(COLLECTIONS.csmTasks, clientId, { sortBy: "dueAt" }),
    listByClient<Obligation>(COLLECTIONS.obligations, clientId, { sortBy: "dueAt" }),
  ]);
  const c = client ? { ...(client as Record<string, unknown>), id: clientId } : null;
  return {
    client: c,
    completeness: profileCompleteness(profileRecord(c)),
    membership,
    minutesLeft: minutesLeft(membership),
    callsLeft: callsLeft(membership),
    matters,
    consultations,
    handoffs,
    tasks,
    obligations,
    nextStep: pickNextStep(matters, handoffs),
  };
}

/** Client-safe view of the bundle: no CSM tasks, no transcripts, no unconfirmed AI summaries. */
export function clientView(b: MemberBundle) {
  return forClient({
    ...b,
    tasks: undefined,
    consultations: b.consultations.map((c) => ({
      ...c,
      transcript: undefined,
      summary: c.summary?.status === "confirmed" ? c.summary : undefined,
    })),
  });
}

/** Does this lawyer work with this client (assigned matter or a consultation)? */
export async function lawyerCanSee(providerId: string, clientId: string): Promise<boolean> {
  if (!providerId) return false;
  const [m, c] = await Promise.all([
    findRecords<Matter>(COLLECTIONS.matters, { clientId, assignedProviderId: providerId }, { limit: 1 }),
    findRecords<Consultation>(COLLECTIONS.consultations, { clientId, providerId }, { limit: 1 }),
  ]);
  return m.length > 0 || c.length > 0;
}

export { createRecord, findRecords, getRecord, updateRecord };
