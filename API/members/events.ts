/**
 * API/members/events.ts
 * ──────────────────────────────────────────────────────────────────────────
 * TASK_RULES engine. Server events create CSM tasks; screens never do.
 *
 *   emitEvent("membership.activated", { clientId, sourceId: membershipId })
 *
 * Rules live in schemas/contracts.ts (TASK_RULES). Every task id is derived
 * from the event name and its source id, so emitting the same event twice is
 * a no-op (safe for retries, cron sweeps and seed scripts).
 *
 * Other routers import `emitEvent`; the record hooks below are called by
 * membersRouter.ts on create/update.
 */

import log from "../../helper/log.ts";
import { derivedStamp, isPlaceholderClient, isPlaceholderId, PLACEHOLDER_PREFIX } from "../../helper/placeholder.ts";
import {
  COLLECTIONS,
  type CsmTask,
  type Handoff,
  type Lead,
  type Membership,
  type Obligation,
  TASK_RULES,
} from "../../schemas/contracts.ts";
import { createRecord, findRecords, getRecord, updateRecord } from "../../db/records.ts";
import { recordFirstCallBooked } from "../analytics/funnel.ts"; // P2
import { handoffNeedsOpportunity } from "../opportunities/logic.ts"; // P5
import { createOpportunityFromHandoff } from "../opportunities/store.ts"; // P5

export type EventName = keyof typeof TASK_RULES;

export interface EventPayload {
  clientId: string;
  matterId?: string;
  /** Id of the record that caused the event (membership, consultation, handoff, quote …). */
  sourceId?: string;
  /** Owner override; otherwise the membership's CSM, then DEFAULT_CSM_EMAIL. */
  ownerEmail?: string;
  /** Extra text appended to the rule's title (e.g. the member's name or the quote title). */
  detail?: string;
  /** Override the computed due date (ISO). */
  dueAt?: string;
  /**
   * Idempotency key when one source can raise the event more than once
   * (e.g. one past-due task per episode of the same membership). Defaults to
   * sourceId; source.id on the task stays the real record id.
   */
  dedupeKey?: string;
  /** Override the source kind derived from the event prefix. */
  sourceKind?: CsmTask["source"]["kind"];
}

const SOURCE_KIND: Record<string, CsmTask["source"]["kind"]> = {
  membership: "membership",
  consultation: "consultation",
  handoff: "handoff",
  document: "document",
  quote: "quote",
  call: "consultation",
  privacy: "privacy_request",
};

export function isTaskEvent(name: string): name is EventName {
  return Object.prototype.hasOwnProperty.call(TASK_RULES, name);
}

/** Deterministic task id: one task per (event, source). */
export function taskIdFor(name: string, payload: Pick<EventPayload, "clientId" | "sourceId" | "dedupeKey">): string {
  const src = (payload.dedupeKey || payload.sourceId || payload.clientId).replace(/[^A-Za-z0-9_-]/g, "_");
  // Tasks about placeholder (seed) members, or raised by a placeholder record on a real
  // member (account seed), get the ph_ prefix, so removePlaceholders clears them too.
  const prefix = isPlaceholderId(payload.clientId) || isPlaceholderId(payload.sourceId) ? PLACEHOLDER_PREFIX : "";
  return `${prefix}task_${name.replace(/[^a-z0-9]+/gi, "_")}__${src}`.slice(0, 1400);
}

/**
 * Pure: the CSM task a rule produces for an event, or null for an unknown event.
 * Exported for tests.
 */
export function buildTask(
  name: string,
  payload: EventPayload,
  now: Date = new Date(),
  defaultOwner?: string,
): CsmTask | null {
  if (!isTaskEvent(name) || !payload.clientId) return null;
  const rule = TASK_RULES[name];
  const kind = payload.sourceKind ?? SOURCE_KIND[name.split(".")[0]] ?? "manual";
  const dueAt = payload.dueAt ?? new Date(now.getTime() + rule.dueInHours * 3600_000).toISOString();
  const task: CsmTask = {
    id: taskIdFor(name, payload),
    clientId: payload.clientId,
    type: rule.type,
    title: payload.detail ? `${rule.title}: ${payload.detail}` : rule.title,
    dueAt,
    status: "open",
    source: payload.sourceId ? { kind, id: payload.sourceId } : { kind },
    createdAt: now.toISOString(),
  };
  if (payload.matterId) task.matterId = payload.matterId;
  if (isPlaceholderId(payload.clientId) || isPlaceholderId(payload.sourceId)) Object.assign(task, derivedStamp());
  const owner = payload.ownerEmail || defaultOwner;
  if (owner) task.ownerEmail = owner;
  return task;
}

async function resolveOwner(payload: EventPayload): Promise<string | undefined> {
  if (payload.ownerEmail) return payload.ownerEmail;
  try {
    const ms = await findRecords<Membership>(COLLECTIONS.memberships, { clientId: payload.clientId });
    const withCsm = ms.find((m) => m.status === "active" && m.csmEmail) ?? ms.find((m) => m.csmEmail);
    if (withCsm?.csmEmail) return withCsm.csmEmail;
  } catch {
    // fall through to the default owner
  }
  return Deno.env.get("DEFAULT_CSM_EMAIL") || undefined;
}

/**
 * Emit a server event. Creates the CSM task its rule defines (once per source)
 * and returns the task ids created or already present. Unknown events return [].
 * Never throws: task creation must not break the request that caused it.
 */
export async function emitEvent(name: string, payload: EventPayload): Promise<string[]> {
  // P2 funnel: first booked call per member (never throws, idempotent).
  if (name === "consultation.booked") await recordFirstCallBooked(payload.clientId);
  try {
    if (!isTaskEvent(name)) {
      log(`[events] ${name} has no task rule`);
      return [];
    }
    const id = taskIdFor(name, payload);
    const existing = await getRecord<CsmTask>(COLLECTIONS.csmTasks, id);
    if (existing) return [id];
    const task = buildTask(name, payload, new Date(), await resolveOwner(payload));
    if (!task) return [];
    // The login-alias placeholder member keeps a real-looking id: flag its tasks.
    if (!isPlaceholderId(payload.clientId) && await isPlaceholderClient(payload.clientId)) Object.assign(task, derivedStamp());
    await createRecord(COLLECTIONS.csmTasks, task);
    log(`[events] ${name} → csm_task ${id} (${task.ownerEmail ?? "unassigned"})`);
    return [id];
  } catch (err) {
    log(`[events] ${name} failed: ${err instanceof Error ? err.message : err}`, "error");
    return [];
  }
}

// ─── Check findings → obligations ──────────────────────────────────────────

/** Pure: obligations a converted lead's findings produce. Exported for tests. */
export function obligationsFromLead(clientId: string, lead: Pick<Lead, "country" | "findings">): Obligation[] {
  return (lead.findings ?? []).map((f) => {
    const o: Obligation = {
      id: `obl_${clientId}_${f.ruleId}`.replace(/[^A-Za-z0-9_-]/g, "_"),
      clientId,
      country: lead.country,
      ruleId: f.ruleId,
      title: f.title,
      status: "upcoming",
    };
    if (f.dueAt) o.dueAt = f.dueAt;
    return o;
  });
}

/**
 * When a membership activates, copy its source lead's check findings into
 * obligations so the member home shows them from day one. Idempotent
 * (deterministic ids, existing obligations are left alone). Never throws.
 */
export async function seedObligationsFromLead(membership: Doc): Promise<number> {
  try {
    const clientId = str(membership.clientId);
    if (!clientId) return 0;
    let lead: Lead | null = null;
    const leadId = str(membership.sourceLeadId);
    if (leadId) lead = await getRecord<Lead>(COLLECTIONS.leads, leadId);
    if (!lead) {
      const leads = await findRecords<Lead>(COLLECTIONS.leads, { convertedClientId: clientId });
      lead = leads[0] ?? null;
    }
    if (!lead) return 0;
    let n = 0;
    for (const o of obligationsFromLead(clientId, lead)) {
      if (await getRecord<Obligation>(COLLECTIONS.obligations, o.id)) continue;
      await createRecord(COLLECTIONS.obligations, o);
      n++;
    }
    if (n) log(`[events] ${n} obligations seeded from lead ${lead.id} for ${clientId}`);
    return n;
  } catch (err) {
    log(`[events] obligations from lead failed: ${err instanceof Error ? err.message : err}`, "error");
    return 0;
  }
}

// ─── Record hooks (called by membersRouter) ───────────────────────────────

export type HookCtx = { actor?: string };

type Doc = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Events implied by a record transition. Pure; exported for tests. */
export function eventsFor(slug: string, before: Doc | null, after: Doc): Array<[EventName, EventPayload]> {
  const clientId = str(after.clientId);
  if (!clientId) return [];
  const id = str(after.id);
  const out: Array<[EventName, EventPayload]> = [];
  if (slug === "memberships" && after.status === "active" && before?.status !== "active") {
    out.push(["membership.activated", { clientId, sourceId: id, ownerEmail: str(after.csmEmail) }]);
  }
  if (slug === "consultations" && after.status === "booked" && !before) {
    out.push(["consultation.booked", { clientId, matterId: str(after.matterId), sourceId: id }]);
  }
  if (slug === "handoffs" && !before) {
    out.push(["handoff.approved", { clientId, matterId: str(after.matterId), sourceId: id }]);
    const notes = str(after.commercialNotes)?.trim();
    if (notes) {
      out.push(["handoff.opportunity", {
        clientId,
        matterId: str(after.matterId),
        sourceId: id,
        detail: notes.length > 80 ? `${notes.slice(0, 77)}…` : notes,
      }]);
    }
  }
  return out;
}

async function run(slug: string, before: Doc | null, after: Doc): Promise<string[]> {
  const ids: string[] = [];
  for (const [name, payload] of eventsFor(slug, before, after)) ids.push(...(await emitEvent(name, payload)));
  // Side effects that keep records consistent with the events.
  if (slug === "memberships" && after.status === "active" && before?.status !== "active") {
    await seedObligationsFromLead(after);
  }
  if (slug === "memberships" && after.status === "active" && !after.activatedAt && after.id) {
    await updateRecord(COLLECTIONS.memberships, String(after.id), { activatedAt: new Date().toISOString() });
  }
  // P5: commercial notes on a handoff (at creation or added later by staff) open an opportunity.
  if (slug === "handoffs" && handoffNeedsOpportunity(before, after)) {
    await createOpportunityFromHandoff(after);
  }
  if (slug === "handoffs" && ids.length && after.id) {
    const prev = Array.isArray(after.csmTaskIds) ? (after.csmTaskIds as string[]) : [];
    await updateRecord<Handoff>(COLLECTIONS.handoffs, String(after.id), {
      csmTaskIds: Array.from(new Set([...prev, ...ids])),
    });
  }
  return ids;
}

export function onRecordCreated(slug: string, record: object, _ctx: HookCtx = {}): Promise<string[]> {
  return run(slug, null, record as Doc);
}

export function onRecordUpdated(
  slug: string,
  before: object,
  after: object,
  _ctx: HookCtx = {},
): Promise<string[]> {
  return run(slug, before as Doc, after as Doc);
}
