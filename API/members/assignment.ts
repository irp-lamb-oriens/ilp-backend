/**
 * API/members/assignment.ts — which lawyer a member works with (REL).
 * ──────────────────────────────────────────────────────────────────────────
 * The member-level assignment (`clients.assignedProviderId`) is the source
 * of truth. Matters follow it unless staff gave a matter its own lawyer; a
 * call keeps the lawyer it was booked with until it is moved here.
 *
 *   ensureAssigned(clientId)            activation / booking: route once and persist
 *   assignMember(clientId, to, actor)   staff assign or reassign; system re-match
 *   offboardLawyer(providerId, actor)   lawyer switched off: re-match their members
 *
 * Reassignment rule for the member's upcoming calls with the previous lawyer:
 * the call MOVES to the new lawyer when the new lawyer offers that same start
 * time (Calendar invitation recreated, both told), otherwise it is CANCELLED
 * (never charged; the member is asked to book again). With no new lawyer
 * (offboarding with nobody licensed in the member's country) every upcoming
 * call with the previous lawyer is cancelled and staff get the
 * "Match a lawyer licensed in the member's country" task.
 * Open quotes stay on the member record (staff decide); payouts already owed
 * to the previous lawyer stay theirs (settlements carry providerIds).
 */

import get from "../../db/get.ts";
import put from "../../db/put.ts";
import query from "../../db/query.ts";
import log from "../../helper/log.ts";
import auditLog from "../../helper/auditLog.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import { callChangedEmail } from "../../helper/emailTemplates.ts";
import { deleteCalendarEvent } from "../../helper/calendar.ts";
import { isPlaceholderClient, isPlaceholderId } from "../../helper/placeholder.ts";
import { COLLECTIONS, type Consultation, COUNTRIES, type Matter } from "../../schemas/contracts.ts";
import { findRecords, nowIso, updateRecord } from "./service.ts";
import { isProviderBookable } from "../providers/applyLogic.ts";
import {
  attachMeeting,
  type CallRecord,
  cancelCall,
  flagUnassignedCountry,
  frontendUrl,
  memberCountry,
  peopleFor,
  providerCountries,
  routeNewLawyer,
  sendBookingEmails,
  slotsFor,
  whenLabel,
} from "../calls/callService.ts";
import { claimSlot, releaseSlot, withLawyerSlots } from "../calls/slotClaims.ts";
import { routeAndAssign } from "../routing/service.ts"; // ROUTING

type Doc = Record<string, unknown>;
export type Actor = { email: string; role: "staff" | "lawyer" | "client" | "system" };
export const SYSTEM_ACTOR: Actor = { email: "system", role: "system" };

export interface AssignResult {
  clientId: string;
  providerId: string | null;
  previous: string | null;
  matters: string[];
  moved: string[];
  cancelled: string[];
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Why staff may not assign this lawyer to this member (null when they may). */
export async function assignBlock(clientId: string, providerId: string): Promise<{ status: number; error: string } | null> {
  const [client, provider] = await Promise.all([
    get(COLLECTIONS.clients, clientId).catch(() => null) as Promise<Doc | null>,
    get("providers", providerId).catch(() => null) as Promise<Doc | null>,
  ]);
  if (!client) return { status: 404, error: "Member not found." };
  if (!provider) return { status: 404, error: "Lawyer not found." };
  if (!isProviderBookable(provider)) return { status: 409, error: "This lawyer is not active (application in review, declined or switched off)." };
  const country = await memberCountry(clientId, client);
  if (!providerCountries(provider).includes(country)) {
    return { status: 409, error: `This lawyer is not licensed in ${COUNTRIES[country].name}, the member's country.` };
  }
  if (isPlaceholderId(providerId) !== (await isPlaceholderClient(clientId))) {
    return { status: 409, error: "Seed (placeholder) lawyers and real members are never matched." };
  }
  return null;
}

/**
 * Move one upcoming call to `to` when that lawyer offers the same start time,
 * else cancel it. Returns what happened. Never throws on Calendar errors.
 */
async function moveOrCancel(c: CallRecord, to: string | null, actor: Actor, reason: string): Promise<"moved" | "cancelled"> {
  const by = { email: actor.email, role: (actor.role === "system" ? "staff" : actor.role) as "staff" | "lawyer" | "client" };
  if (to) {
    const moved = await withLawyerSlots(to, async () => {
      const open = (await slotsFor(to, new Date(), c.id)).includes(c.scheduledAt);
      if (!open || !(await claimSlot(to, c.scheduledAt, c.id))) return null;
      const from = c.providerId;
      if (c.calendarEventId) {
        await deleteCalendarEvent(c.calendarEventId).catch((err) =>
          log(`[assignment] could not delete event ${c.calendarEventId}: ${err instanceof Error ? err.message : err}`, "error")
        );
      }
      const updated = await updateRecord<CallRecord>(COLLECTIONS.consultations, c.id, {
        providerId: to,
        previousProviderId: from,
        calendarEventId: null,
        meetUrl: null,
        calendarError: null,
        remindersSent: [],
        reassignedAt: nowIso(),
        reassignedBy: actor.email,
      });
      await releaseSlot(from, c.scheduledAt, c.id);
      return { updated: updated ?? { ...c, providerId: to }, from };
    });
    if (moved) {
      const people = await peopleFor(moved.updated);
      const withMeet = await attachMeeting(moved.updated, people);
      await sendBookingEmails(withMeet, people);
      // The previous lawyer: this call is no longer theirs.
      const old = await peopleFor({ ...c, providerId: moved.from });
      if (old.lawyer.email) {
        await enqueueEmail({
          to: old.lawyer.email,
          ...callChangedEmail({ change: "cancelled", greetingName: old.lawyer.name, otherName: old.member.name, oldWhenLabel: whenLabel(c.scheduledAt, old.lawyer.timezone), link: `${frontendUrl()}/lawyer`, linkLabel: "Open Today" }),
          placeholder: old.placeholder,
        }, `call_reassigned_${c.id}_${moved.from}_lawyer`).catch(() => undefined);
      }
      await auditLog({ actor: { uid: actor.email, email: actor.email, role: actor.role }, action: "consultation.reassigned", target: `consultations/${c.id}`, meta: { clientId: c.clientId, from: moved.from, to, reason } }).catch(() => undefined);
      return "moved";
    }
  }
  await cancelCall(c, by, reason);
  return "cancelled";
}

/**
 * Assign (or reassign, or clear with `to = null`) the member's lawyer.
 * Callers check `assignBlock` first for staff choices. Idempotent.
 */
export async function assignMember(clientId: string, to: string | null, actor: Actor, opts: { reason?: string; auto?: boolean } = {}): Promise<AssignResult> {
  const client = (await get(COLLECTIONS.clients, clientId)) as Doc | null;
  if (!client) throw new Error(`client ${clientId} not found`);
  const previous = str(client.assignedProviderId);
  const now = nowIso();
  const result: AssignResult = { clientId, providerId: to, previous, matters: [], moved: [], cancelled: [] };
  if (previous !== to) {
    await put(COLLECTIONS.clients, clientId, {
      assignedProviderId: to,
      assignedAt: now,
      assignedBy: actor.email,
      autoAssigned: !!opts.auto,
      updatedAt: now,
      activityLog: [
        ...(Array.isArray(client.activityLog) ? client.activityLog : []),
        { type: to ? "client_assigned" : "client_unassigned", providerId: to, previousProviderId: previous, actor: actor.email, auto: !!opts.auto, timestamp: now },
      ],
    });
  }
  // Open matters without their own lawyer (unassigned, or the previous one) follow the member.
  const matters = await findRecords<Matter>(COLLECTIONS.matters, { clientId });
  for (const m of matters) {
    if (m.closedAt) continue;
    if (!m.assignedProviderId || (previous && m.assignedProviderId === previous)) {
      if (m.assignedProviderId === (to ?? undefined)) continue;
      await updateRecord(COLLECTIONS.matters, m.id, { assignedProviderId: to });
      result.matters.push(m.id);
    }
  }
  // Upcoming calls with the previous lawyer: move or cancel.
  if (previous && previous !== to) {
    const calls = (await findRecords<CallRecord>(COLLECTIONS.consultations, { clientId, providerId: previous }))
      .filter((c) => c.status === "booked" && Date.parse(c.scheduledAt) > Date.now())
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    for (const c of calls) {
      const outcome = await moveOrCancel(c, to, actor, opts.reason ?? (to ? "Your lawyer changed" : "Your lawyer is no longer available"));
      result[outcome === "moved" ? "moved" : "cancelled"].push(c.id);
    }
  }
  if (!to) await flagUnassignedCountry(clientId);
  if (previous !== to) {
    await auditLog({
      actor: { uid: actor.email, email: actor.email, role: actor.role },
      action: previous ? (to ? "member.reassigned" : "member.unassigned") : "member.assigned",
      target: `clients/${clientId}`,
      meta: { from: previous, to, auto: !!opts.auto, matters: result.matters.length, moved: result.moved, cancelled: result.cancelled, reason: opts.reason ?? null },
    }).catch(() => undefined);
    log(`[assignment] ${clientId}: ${previous ?? "none"} → ${to ?? "none"} (moved ${result.moved.length}, cancelled ${result.cancelled.length})`);
  }
  return result;
}

/**
 * The member has a bookable lawyer: keep it; else route one (country,
 * specialty, load) and persist it. Null when nobody licensed in the member's
 * country can take calls (staff get a task). Never throws.
 */
export async function ensureAssigned(clientId: string, actor: Actor = SYSTEM_ACTOR): Promise<string | null> {
  try {
    const client = (await get(COLLECTIONS.clients, clientId)) as Doc | null;
    if (!client) return null;
    const current = str(client.assignedProviderId);
    if (current) {
      const p = (await get("providers", current).catch(() => null)) as Doc | null;
      if (isProviderBookable(p)) return current;
    }
    // ROUTING: the router picks, persists "Why this lawyer" and assigns; no match
    // runs the no-match path (staff alert, member notice, sales call).
    const r = await routeAndAssign(clientId, { trigger: "activation", actor });
    if (!r.providerId && current) await assignMember(clientId, null, actor, { auto: true, reason: "No lawyer matches the member's needs" });
    return r.providerId;
  } catch (err) {
    log(`[assignment] ensureAssigned ${clientId} failed: ${err instanceof Error ? err.message : err}`, "error");
    return null;
  }
}

/**
 * A lawyer was switched off: every member assigned to them is re-matched
 * (another lawyer licensed in the member's country) or left unassigned with
 * a CSM task; their upcoming calls move or are cancelled (assignMember).
 * Matters and calls they held for members assigned to someone else go back
 * to that member's lawyer. Returns the members touched.
 */
export async function offboardLawyer(providerId: string, actor: Actor, reason = "Your lawyer is no longer available"): Promise<{ members: AssignResult[] }> {
  const members: AssignResult[] = [];
  const assigned = (await query(COLLECTIONS.clients, [{ field: "assignedProviderId", op: "EQUAL", value: providerId }]).catch(() => [])) as Doc[];
  const done = new Set<string>();
  for (const c of assigned) {
    const clientId = String(c.id);
    done.add(clientId);
    const to = await routeNewLawyer(clientId, undefined, providerId);
    members.push(await assignMember(clientId, to, actor, { auto: true, reason }));
    // ROUTING: nobody else fits: the no-match path tells staff and the member and books a sales call.
    if (!to) await routeAndAssign(clientId, { trigger: "reroute", exclude: providerId }).catch(() => undefined);
  }
  // Matter-level and call-level links for members assigned to someone else.
  const [matters, calls] = await Promise.all([
    findRecords<Matter>(COLLECTIONS.matters, { assignedProviderId: providerId }),
    findRecords<CallRecord>(COLLECTIONS.consultations, { providerId, status: "booked" }),
  ]);
  for (const m of matters.filter((x) => !x.closedAt && !done.has(x.clientId))) {
    const client = (await get(COLLECTIONS.clients, m.clientId).catch(() => null)) as Doc | null;
    await updateRecord(COLLECTIONS.matters, m.id, { assignedProviderId: str(client?.assignedProviderId) });
  }
  for (const c of calls.filter((x) => !done.has(x.clientId) && Date.parse(x.scheduledAt) > Date.now())) {
    const client = (await get(COLLECTIONS.clients, c.clientId).catch(() => null)) as Doc | null;
    await moveOrCancel(c, str(client?.assignedProviderId), actor, reason);
  }
  await auditLog({
    actor: { uid: actor.email, email: actor.email, role: actor.role },
    action: "provider.deactivated",
    target: `providers/${providerId}`,
    meta: { members: members.map((m) => ({ clientId: m.clientId, to: m.providerId, moved: m.moved.length, cancelled: m.cancelled.length })) },
  }).catch(() => undefined);
  return { members };
}

/** Upcoming booked calls of a member, cancelled (membership ended). Never charged. */
export async function cancelUpcomingCalls(clientId: string, actor: Actor, reason: string, fromIso = new Date().toISOString()): Promise<string[]> {
  const out: string[] = [];
  try {
    const calls = (await findRecords<Consultation>(COLLECTIONS.consultations, { clientId, status: "booked" }))
      .filter((c) => c.scheduledAt >= fromIso);
    for (const c of calls) {
      await cancelCall(c as CallRecord, { email: actor.email, role: actor.role === "system" ? "staff" : actor.role as "staff" | "lawyer" | "client" }, reason);
      out.push(c.id);
    }
  } catch (err) {
    log(`[assignment] cancelling calls of ${clientId} failed: ${err instanceof Error ? err.message : err}`, "error");
  }
  return out;
}
