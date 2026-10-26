/**
 * API/calls/callService.ts — the call itself (P3): availability storage,
 * slot lookup, lawyer routing, Google Meet events, booking emails, cancel /
 * reschedule, no-show charging and Meet transcripts.
 * ──────────────────────────────────────────────────────────────────────────
 * Rules live in callLogic.ts (pure, tested). This file does the I/O.
 * Used by callsRouter.ts, clientStatus/memberHome.ts (booking) and
 * jobs/callReminders.ts.
 */

import get from "../../db/get.ts";
import put from "../../db/put.ts";
import getAll from "../../db/getAll.ts";
import query from "../../db/query.ts";
import log from "../../helper/log.ts";
import auditLog from "../../helper/auditLog.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import {
  callBookedLawyerEmail,
  callBookedMemberEmail,
  callChangedEmail,
} from "../../helper/emailTemplates.ts";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  fetchMeetNotes,
  listBusySlots,
  updateCalendarEventTime,
} from "../../helper/calendar.ts";
import {
  COLLECTIONS,
  type Consultation,
  type CsmTask,
  type Matter,
  type Membership,
  PLAN_STANDARD,
} from "../../schemas/contracts.ts";
import {
  createRecord,
  currentMembership,
  findRecords,
  getRecord,
  nowIso,
  profileRecord,
  updateRecord,
} from "../members/service.ts";
import {
  type AvailabilityDoc,
  buildSlots,
  CR_TZ,
  defaultAvailability,
  type LawyerCandidate,
  normalizeAvailability,
  pickLawyer,
} from "./callLogic.ts";

type Doc = Record<string, unknown>;
const MIN = 60_000;
const DAY = 86_400_000;
const LOOKAHEAD_DAYS = 14;

/** Consultation plus the P3 bookkeeping fields stored on the same record. */
export type CallRecord = Consultation & {
  calendarError?: string | null;
  chargedAt?: string;
  restoredAt?: string;
  transcriptFetchAttempts?: number;
  transcriptSource?: string;
  bookedBy?: string;
};

export const frontendUrl = () => (Deno.env.get("FRONTEND_URL") ?? "http://localhost:3000").replace(/\/$/, "");
export const lawyerBriefUrl = (consultationId: string) => `${frontendUrl()}/lawyer/calls/${encodeURIComponent(consultationId)}`;
export const memberHomeUrl = () => `${frontendUrl()}/status`;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** "Thursday, November 5, 9:00 AM" in Costa Rica time. */
export function whenLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: CR_TZ,
  });
}

// ─── People ────────────────────────────────────────────────────────────────

export interface CallPeople {
  member: { name: string; firstName: string; email: string | null };
  lawyer: { name: string; email: string | null };
}

export async function peopleFor(c: Pick<Consultation, "clientId" | "providerId">): Promise<CallPeople> {
  const [client, provider] = await Promise.all([
    get(COLLECTIONS.clients, c.clientId).catch(() => null) as Promise<Doc | null>,
    c.providerId ? (get("providers", c.providerId).catch(() => null) as Promise<Doc | null>) : Promise.resolve(null),
  ]);
  const p = profileRecord(client);
  const first = str(p.name) ?? str(p.fullName)?.split(" ")[0] ?? "there";
  const full = str(p.fullName) ?? ([str(p.name), str(p.surname)].filter(Boolean).join(" ") || "ILP member");
  return {
    member: { name: full, firstName: first, email: str(p.email)?.toLowerCase() ?? null },
    lawyer: { name: str(provider?.name) ?? "your ILP lawyer", email: str(provider?.email)?.toLowerCase() ?? null },
  };
}

// ─── Availability ──────────────────────────────────────────────────────────

/** A lawyer's saved availability, or the default hours when none is saved. */
export async function loadAvailability(providerId: string): Promise<AvailabilityDoc & { isDefault: boolean }> {
  const doc = (await get(COLLECTIONS.availability, providerId).catch(() => null)) as Doc | null;
  if (!doc) return { ...defaultAvailability(providerId), calendarId: null, isDefault: true };
  const norm = normalizeAvailability(doc, providerId);
  if ("error" in norm) {
    log(`[calls] stored availability for ${providerId} is invalid (${norm.error}); using defaults`, "error");
    return { ...defaultAvailability(providerId), calendarId: null, isDefault: true };
  }
  return { ...norm.value, updatedAt: str(doc.updatedAt) ?? norm.value.updatedAt, isDefault: false };
}

export async function saveAvailability(
  providerId: string,
  body: unknown,
  actor: { email: string; role: "lawyer" | "staff" },
): Promise<{ value: AvailabilityDoc } | { error: string }> {
  const norm = normalizeAvailability(body, providerId);
  if ("error" in norm) return norm;
  await put(COLLECTIONS.availability, providerId, norm.value as unknown as Doc);
  await auditLog({
    actor: { uid: actor.email, email: actor.email, role: actor.role },
    action: "availability.updated",
    target: `${COLLECTIONS.availability}/${providerId}`,
    meta: { windows: norm.value.weekly.length, blackoutDates: norm.value.blackoutDates.length, maxCallsPerDay: norm.value.maxCallsPerDay },
  }).catch(() => undefined);
  return norm;
}

// ─── Slots ─────────────────────────────────────────────────────────────────

/** This lawyer's consultations that hold time from `fromMs` on. */
async function heldBy(providerId: string, fromMs: number, excludeId?: string): Promise<CallRecord[]> {
  const all = await findRecords<CallRecord>(COLLECTIONS.consultations, { providerId });
  const from = new Date(fromMs - DAY).toISOString();
  return all.filter((c) => c.id !== excludeId && c.status !== "cancelled" && c.scheduledAt >= from);
}

/**
 * Bookable slots for a lawyer: weekly windows − blackout dates − booked calls
 * − Google Calendar busy times (when a calendar is set), with lead time and
 * the daily cap. `excludeId` ignores one consultation (the one being moved).
 */
export async function slotsFor(providerId: string, now = new Date(), excludeId?: string): Promise<string[]> {
  const availability = await loadAvailability(providerId);
  const held = await heldBy(providerId, now.getTime(), excludeId);
  let busy: Array<{ start: string; end: string }> = [];
  if (availability.calendarId) {
    try {
      busy = await listBusySlots(now.toISOString(), new Date(now.getTime() + (LOOKAHEAD_DAYS + 1) * DAY).toISOString(), availability.calendarId);
    } catch (err) {
      log(`[calls] busy times for ${providerId} unavailable: ${err instanceof Error ? err.message : err}`);
    }
  }
  return buildSlots({ now, availability, booked: held, busy, days: LOOKAHEAD_DAYS, lengthMin: PLAN_STANDARD.callLengthMin });
}

// ─── Routing ───────────────────────────────────────────────────────────────

/**
 * The lawyer a member books with: the matter's assigned lawyer, else the
 * client's, else the least-loaded lawyer whose specialties match the matter
 * area (lawyer_availability.specialties, falling back to providers.legalAreas),
 * else DEFAULT_PROVIDER_ID.
 */
export async function routeLawyer(clientId: string, matterId?: string): Promise<string | null> {
  const matters = await findRecords<Matter>(COLLECTIONS.matters, { clientId }, { sortBy: "openedAt", desc: true });
  const m = (matterId ? matters.find((x) => x.id === matterId) : null) ?? matters.find((x) => !x.closedAt && x.assignedProviderId);
  if (m?.assignedProviderId) return m.assignedProviderId;
  const client = (await get(COLLECTIONS.clients, clientId).catch(() => null)) as Doc | null;
  const assigned = str(client?.assignedProviderId);
  if (assigned) return assigned;
  const fallback = Deno.env.get("DEFAULT_PROVIDER_ID") || null;
  const matter = matterId ? matters.find((x) => x.id === matterId) : matters.find((x) => !x.closedAt);
  const area = matter?.area ?? str(client?.legalArea);
  if (!area) return fallback;
  try {
    const candidates = await lawyerCandidates(area);
    return pickLawyer(area, candidates, fallback);
  } catch (err) {
    log(`[calls] routing failed for ${clientId}: ${err instanceof Error ? err.message : err}`, "error");
    return fallback;
  }
}

async function lawyerCandidates(area: string): Promise<LawyerCandidate[]> {
  const avail = (await getAll(COLLECTIONS.availability).catch(() => [])) as Doc[];
  const byId = new Map<string, string[]>();
  for (const a of avail) {
    const id = str(a.providerId) ?? str(a.id);
    if (id) byId.set(id, Array.isArray(a.specialties) ? (a.specialties as string[]) : []);
  }
  // Lawyers without saved specialties: use their provider profile's legal areas.
  const providers = (await query("providers", [{ field: "legalAreas", op: "ARRAY_CONTAINS", value: area }]).catch(() => [])) as Doc[];
  for (const p of providers) {
    const id = str(p.id);
    if (!id || p.active === false || p.status === "inactive") continue;
    const saved = byId.get(id);
    if (!saved || saved.length === 0) byId.set(id, Array.isArray(p.legalAreas) ? (p.legalAreas as string[]) : [area]);
  }
  const out: LawyerCandidate[] = [];
  for (const [providerId, specialties] of byId) {
    if (!specialties.length) continue;
    const load = (await findRecords<Consultation>(COLLECTIONS.consultations, { providerId, status: "booked" }).catch(() => [])).length;
    out.push({ providerId, specialties, load });
  }
  return out;
}

// ─── CSM task when the calendar fails ──────────────────────────────────────

async function csmOwner(clientId: string): Promise<string | undefined> {
  const m = await currentMembership(clientId).catch(() => null);
  return m?.csmEmail || Deno.env.get("DEFAULT_CSM_EMAIL") || undefined;
}

/** One open task per consultation: "send the Meet link by email". Idempotent. */
export async function flagCalendarProblem(c: CallRecord, memberName: string, problem: string): Promise<void> {
  const id = `task_calendar_link__${c.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const existing = await getRecord<CsmTask>(COLLECTIONS.csmTasks, id).catch(() => null);
  if (existing && existing.status === "open") return;
  const start = Date.parse(c.scheduledAt);
  const due = new Date(Math.min(Date.now() + 2 * 60 * MIN, Math.max(Date.now(), start - 60 * MIN))).toISOString();
  const task: CsmTask = {
    id,
    clientId: c.clientId,
    type: "follow_up",
    title: `Send the Google Meet link by email: ${memberName}, ${whenLabel(c.scheduledAt)} (${problem})`,
    dueAt: due,
    status: "open",
    source: { kind: "consultation", id: c.id },
    createdAt: nowIso(),
  };
  if (c.matterId) task.matterId = c.matterId;
  const owner = await csmOwner(c.clientId);
  if (owner) task.ownerEmail = owner;
  await createRecord(COLLECTIONS.csmTasks, task);
  log(`[calls] calendar problem on ${c.id}: csm_task ${id}`);
}

// ─── Google Meet on booking ────────────────────────────────────────────────

const slotOf = (iso: string, durationMin: number) => ({
  start: iso,
  end: new Date(Date.parse(iso) + durationMin * MIN).toISOString(),
  timezone: CR_TZ,
});

/**
 * Create the Calendar event with a Meet link for a booked consultation and
 * store meetUrl + calendarEventId. Never throws: on failure the booking stays,
 * `calendarError` is set and the CSM gets a task to send the link by email.
 */
export async function attachMeeting(c: CallRecord, people?: CallPeople): Promise<CallRecord> {
  const who = people ?? (await peopleFor(c));
  try {
    const ev = await createCalendarEvent({
      slot: slotOf(c.scheduledAt, c.durationMin || PLAN_STANDARD.callLengthMin),
      title: `ILP call: ${who.member.name} with ${who.lawyer.name}`,
      description:
        "Your 20-minute ILP membership call. Join with the Google Meet link on this invitation.\n" +
        `Members: ${memberHomeUrl()}\nLawyer brief: ${lawyerBriefUrl(c.id)}`,
      attendees: [who.member.email, who.lawyer.email].filter((e): e is string => !!e),
      requestId: c.id,
      privateProps: { consultationId: c.id, clientId: c.clientId },
    });
    if (!ev.eventId) throw new Error("Calendar returned no event id");
    if (!ev.meetUrl) log(`[calls] event ${ev.eventId} for ${c.id} has no Meet link yet`, "error");
    const updated = await updateRecord<CallRecord>(COLLECTIONS.consultations, c.id, {
      calendarEventId: ev.eventId,
      meetUrl: ev.meetUrl ?? null,
      calendarError: ev.meetUrl ? null : "no_meet_link",
    });
    if (!ev.meetUrl) await flagCalendarProblem(c, who.member.name, "no Meet link on the event");
    return updated ?? c;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[calls] calendar event for ${c.id} failed: ${msg}`, "error");
    const updated = await updateRecord<CallRecord>(COLLECTIONS.consultations, c.id, { calendarError: msg.slice(0, 300) });
    await flagCalendarProblem(c, who.member.name, "calendar invite failed");
    return updated ?? c;
  }
}

/** Booking emails to the member and the lawyer (deduped per consultation). */
export async function sendBookingEmails(c: CallRecord, people?: CallPeople): Promise<void> {
  const who = people ?? (await peopleFor(c));
  const when = whenLabel(c.scheduledAt);
  try {
    if (who.member.email) {
      const m = callBookedMemberEmail({ firstName: who.member.firstName, lawyerName: who.lawyer.name, whenLabel: when, meetUrl: c.meetUrl, portalUrl: memberHomeUrl() });
      await enqueueEmail({ to: who.member.email, ...m }, `call_booked_${c.id}_${c.scheduledAt}_${c.meetUrl ? "link" : "nolink"}_member`);
    }
    if (who.lawyer.email) {
      const l = callBookedLawyerEmail({ lawyerName: who.lawyer.name, memberName: who.member.name, whenLabel: when, question: c.question, briefUrl: lawyerBriefUrl(c.id) });
      await enqueueEmail({ to: who.lawyer.email, ...l }, `call_booked_${c.id}_${c.scheduledAt}_lawyer`);
    }
  } catch (err) {
    log(`[calls] booking emails for ${c.id} failed: ${err instanceof Error ? err.message : err}`, "error");
  }
}

// ─── Cancel / reschedule ───────────────────────────────────────────────────

type Actor = { email: string; role: "client" | "staff" | "lawyer" };

async function audit(actor: Actor, action: string, c: Pick<Consultation, "id" | "clientId">, meta: Doc = {}) {
  await auditLog({
    actor: { uid: actor.email, email: actor.email, role: actor.role },
    action,
    target: `consultations/${c.id}`,
    meta: { clientId: c.clientId, ...meta },
  }).catch(() => undefined);
}

/**
 * Cancel a call: status cancelled, Calendar event deleted, and, if it had
 * already been charged (a no-show), the call and minutes go back.
 * A booked call is never charged, so cancelling restores it automatically.
 */
export async function cancelCall(c: CallRecord, actor: Actor, reason?: string): Promise<CallRecord> {
  const updated = await updateRecord<CallRecord>(COLLECTIONS.consultations, c.id, {
    status: "cancelled",
    cancelledAt: nowIso(),
    cancelledBy: actor.email,
    cancelReason: reason?.slice(0, 500),
  });
  if (c.calendarEventId) {
    await deleteCalendarEvent(c.calendarEventId).catch((err) =>
      log(`[calls] could not delete event ${c.calendarEventId}: ${err instanceof Error ? err.message : err}`, "error")
    );
  }
  if (c.chargedAt && !c.restoredAt) await restoreCall(c, actor);
  await audit(actor, "consultation.cancelled", c, { reason });
  const who = await peopleFor(c);
  const old = whenLabel(c.scheduledAt);
  try {
    if (who.member.email) {
      await enqueueEmail({ to: who.member.email, ...callChangedEmail({ change: "cancelled", greetingName: who.member.firstName, otherName: who.lawyer.name, oldWhenLabel: old, link: `${frontendUrl()}/status/book`, linkLabel: "Book another time" }) }, `call_cancelled_${c.id}_member`);
    }
    if (who.lawyer.email) {
      await enqueueEmail({ to: who.lawyer.email, ...callChangedEmail({ change: "cancelled", greetingName: who.lawyer.name, otherName: who.member.name, oldWhenLabel: old, link: `${frontendUrl()}/lawyer`, linkLabel: "Open Today" }) }, `call_cancelled_${c.id}_lawyer`);
    }
  } catch (err) {
    log(`[calls] cancel emails for ${c.id} failed: ${err instanceof Error ? err.message : err}`, "error");
  }
  return updated ?? c;
}

/**
 * Move a call to a new slot (already validated against slotsFor). The Calendar
 * event moves with it and keeps its Meet link; reminders start over.
 */
export async function rescheduleCall(c: CallRecord, newIso: string, actor: Actor): Promise<CallRecord> {
  const old = c.scheduledAt;
  let updated = await updateRecord<CallRecord>(COLLECTIONS.consultations, c.id, {
    scheduledAt: newIso,
    remindersSent: [],
    rescheduledAt: nowIso(),
    rescheduledBy: actor.email,
    previousScheduledAt: old,
  }) ?? { ...c, scheduledAt: newIso };
  const who = await peopleFor(c);
  if (c.calendarEventId) {
    try {
      await updateCalendarEventTime(c.calendarEventId, slotOf(newIso, c.durationMin || PLAN_STANDARD.callLengthMin));
    } catch (err) {
      log(`[calls] could not move event ${c.calendarEventId}: ${err instanceof Error ? err.message : err}`, "error");
      updated = await updateRecord<CallRecord>(COLLECTIONS.consultations, c.id, { calendarError: "move_failed" }) ?? updated;
      await flagCalendarProblem(updated, who.member.name, "calendar move failed");
    }
  } else {
    updated = await attachMeeting(updated, who);
  }
  await audit(actor, "consultation.rescheduled", c, { from: old, to: newIso });
  try {
    const args = { change: "rescheduled" as const, oldWhenLabel: whenLabel(old), newWhenLabel: whenLabel(newIso), meetUrl: updated.meetUrl };
    if (who.member.email) {
      await enqueueEmail({ to: who.member.email, ...callChangedEmail({ ...args, greetingName: who.member.firstName, otherName: who.lawyer.name, link: memberHomeUrl(), linkLabel: "Open your ILP home" }) }, `call_moved_${c.id}_${newIso}_member`);
    }
    if (who.lawyer.email) {
      await enqueueEmail({ to: who.lawyer.email, ...callChangedEmail({ ...args, greetingName: who.lawyer.name, otherName: who.member.name, link: lawyerBriefUrl(c.id), linkLabel: "Open the brief" }) }, `call_moved_${c.id}_${newIso}_lawyer`);
    }
  } catch (err) {
    log(`[calls] reschedule emails for ${c.id} failed: ${err instanceof Error ? err.message : err}`, "error");
  }
  return updated;
}

// ─── No-show and restore ───────────────────────────────────────────────────

/**
 * The lawyer waited 10 minutes and the member did not join: status no_show,
 * and the call plus its booked minutes are charged once (chargedAt).
 */
export async function markNoShow(c: CallRecord, actor: Actor): Promise<{ call: CallRecord; membership: Membership | null }> {
  const minutes = c.durationMin || PLAN_STANDARD.callLengthMin;
  let membership: Membership | null = null;
  const fields: Doc = { status: "no_show", noShowAt: nowIso(), noShowMarkedBy: actor.email, endedAt: nowIso() };
  if (!c.chargedAt) {
    const m = await currentMembership(c.clientId);
    if (m) {
      membership = await updateRecord<Membership>(COLLECTIONS.memberships, m.id, {
        minutesUsed: (m.minutesUsed ?? 0) + minutes,
        callsUsed: (m.callsUsed ?? 0) + 1,
        updatedAt: nowIso(),
      });
      fields.chargedAt = nowIso();
      fields.minutesUsed = minutes;
    }
  }
  const call = await updateRecord<CallRecord>(COLLECTIONS.consultations, c.id, fields) ?? c;
  await audit(actor, "consultation.no_show", c, { charged: !!fields.chargedAt, minutes });
  return { call, membership };
}

/** CSM: give back a charged call (no-show or otherwise). Idempotent via restoredAt. */
export async function restoreCall(c: CallRecord, actor: Actor): Promise<Membership | null> {
  if (!c.chargedAt || c.restoredAt) return null;
  const m = await currentMembership(c.clientId);
  let updated: Membership | null = null;
  if (m) {
    const minutes = Math.max(0, Math.round(c.minutesUsed ?? c.durationMin ?? PLAN_STANDARD.callLengthMin));
    updated = await updateRecord<Membership>(COLLECTIONS.memberships, m.id, {
      minutesUsed: Math.max(0, (m.minutesUsed ?? 0) - minutes),
      callsUsed: Math.max(0, (m.callsUsed ?? 0) - 1),
      updatedAt: nowIso(),
    });
  }
  await updateRecord(COLLECTIONS.consultations, c.id, { restoredAt: nowIso(), restoredBy: actor.email });
  await audit(actor, "consultation.call_restored", c, {});
  return updated;
}

// ─── Consent ───────────────────────────────────────────────────────────────

export async function setConsent(c: CallRecord, recording: "granted" | "declined", actor: Actor, where: string): Promise<CallRecord> {
  const updated = await updateRecord<CallRecord>(COLLECTIONS.consultations, c.id, {
    consent: { recording, at: nowIso(), by: actor.role, where },
  }) ?? c;
  await audit(actor, `consent.${recording}`, c, { where });
  return updated;
}

// ─── Transcript from Meet ──────────────────────────────────────────────────

/**
 * Pull the Meet transcript (or Gemini notes) attached to the call's Calendar
 * event and store it on the consultation. Only for calls with recording
 * consent granted. Counts attempts so the sweep gives up after a while.
 */
export async function pullMeetTranscript(c: CallRecord): Promise<{ status: "fetched" | "not_ready" | "no_event" | "no_consent"; text?: string; source?: string; message?: string }> {
  if (c.consent?.recording !== "granted") return { status: "no_consent", message: "Recording consent is not granted." };
  if (!c.calendarEventId) return { status: "no_event", message: "This call has no Google Calendar event." };
  const r = await fetchMeetNotes(c.calendarEventId);
  if (r.status === "fetched") {
    await updateRecord(COLLECTIONS.consultations, c.id, {
      transcript: r.text.slice(0, 200_000),
      transcriptSource: `meet_${r.source}`,
      transcriptFetchedAt: nowIso(),
    });
    return { status: "fetched", text: r.text, source: r.source };
  }
  await updateRecord(COLLECTIONS.consultations, c.id, { transcriptFetchAttempts: (c.transcriptFetchAttempts ?? 0) + 1 });
  return { status: r.status, message: r.message };
}
