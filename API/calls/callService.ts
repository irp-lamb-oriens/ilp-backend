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
import { isPlaceholderDoc, isPlaceholderId, logSkipped } from "../../helper/placeholder.ts";
import {
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
  type ConsentRecord,
  type Consultation,
  COUNTRIES,
  type CountryCode,
  type CsmTask,
  type Matter,
  type Membership,
  PLAN_STANDARD,
  toCountryCode,
} from "../../schemas/contracts.ts";
import { emitEvent, taskIdFor } from "../members/events.ts";
import { applicationBlocksCalls, isProviderBookable } from "../providers/applyLogic.ts";
import { syncTransaction } from "../../db/lock.ts";
import { claimSlot, releaseSlot, withLawyerSlots } from "./slotClaims.ts";
import { decideRoute } from "../routing/service.ts"; // ROUTING
import { sendPreCallEmail } from "../routing/precall.ts"; // ROUTING
import { RECORDING_WITHDRAWN_MESSAGE, recordingAllowedFor } from "../privacy/policy.ts";
import {
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
  candidateCountries,
  CR_TZ,
  defaultAvailability,
  isTimeZone,
  type LawyerCandidate,
  normalizeAvailability,
  zoneLabel,
} from "./callLogic.ts";

type Doc = Record<string, unknown>;
const MIN = 60_000;
const DAY = 86_400_000;
const LOOKAHEAD_DAYS = 14;

/** Consultation plus the P3 bookkeeping fields stored on the same record. */
/** A consultation as API/calls reads it (P3 fields now live in contracts.ts). */
export type CallRecord = Consultation;

export const frontendUrl = () => (Deno.env.get("FRONTEND_URL") ?? "http://localhost:3000").replace(/\/$/, "");
export const lawyerBriefUrl = (consultationId: string) => `${frontendUrl()}/lawyer/calls/${encodeURIComponent(consultationId)}`;
export const memberHomeUrl = () => `${frontendUrl()}/status`;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * "Thursday, November 5, 9:00 AM (Costa Rica time)" in the reader's time
 * zone (the member's or the lawyer's). Costa Rica when unknown.
 */
export function whenLabel(iso: string, tz: string = CR_TZ): string {
  const zone = isTimeZone(tz) ? tz : CR_TZ;
  const d = new Date(iso);
  const text = d.toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: zone,
  });
  return `${text} (${zoneLabel(zone)})`;
}

/** A person's time zone: their saved one, else their country's default, else Costa Rica. */
export function personTimeZone(doc: Doc | null | undefined): string {
  const saved = str(doc?.timezone);
  if (saved && isTimeZone(saved)) return saved;
  const juris = Array.isArray(doc?.jurisdictions) ? (doc!.jurisdictions as unknown[])[0] : undefined;
  const code = toCountryCode(doc?.legalCountry) ?? toCountryCode(doc?.country) ?? toCountryCode(juris) ?? toCountryCode(doc?.jurisdiction);
  return code ? COUNTRIES[code].defaultTimeZone : CR_TZ;
}

// ─── People ────────────────────────────────────────────────────────────────

export interface CallPeople {
  member: { name: string; firstName: string; email: string | null; timezone: string };
  lawyer: { name: string; email: string | null; timezone: string };
  /** Member or lawyer is placeholder (seed) data: no Calendar event, no email. */
  placeholder?: boolean;
}

export async function peopleFor(c: Pick<Consultation, "clientId" | "providerId"> & { id?: string; placeholder?: boolean }): Promise<CallPeople> {
  const [client, provider] = await Promise.all([
    get(COLLECTIONS.clients, c.clientId).catch(() => null) as Promise<Doc | null>,
    c.providerId ? (get("providers", c.providerId).catch(() => null) as Promise<Doc | null>) : Promise.resolve(null),
  ]);
  const p = profileRecord(client);
  const first = str(p.name) ?? str(p.fullName)?.split(" ")[0] ?? "there";
  const full = str(p.fullName) ?? ([str(p.name), str(p.surname)].filter(Boolean).join(" ") || "ILP member");
  return {
    member: { name: full, firstName: first, email: str(p.email)?.toLowerCase() ?? null, timezone: personTimeZone(p) },
    lawyer: { name: str(provider?.name) ?? "your ILP lawyer", email: str(provider?.email)?.toLowerCase() ?? null, timezone: await lawyerTimeZone(c.providerId, provider) },
    placeholder: isPlaceholderDoc(c) || isPlaceholderId(c.clientId) || isPlaceholderDoc(client) ||
      isPlaceholderId(c.providerId) || isPlaceholderDoc(provider),
  };
}

// ─── Availability ──────────────────────────────────────────────────────────

/** The lawyer's time zone: their availability's, else their profile's, else their country's default. */
export async function lawyerTimeZone(providerId: string | undefined, provider?: Doc | null): Promise<string> {
  if (!providerId) return CR_TZ;
  const avail = (await get(COLLECTIONS.availability, providerId).catch(() => null)) as Doc | null;
  if (isTimeZone(avail?.timezone)) return avail!.timezone as string;
  const p = provider ?? ((await get("providers", providerId).catch(() => null)) as Doc | null);
  return personTimeZone(p);
}

/** A lawyer's saved availability, or the default hours when none is saved. */
export async function loadAvailability(providerId: string): Promise<AvailabilityDoc & { isDefault: boolean }> {
  const doc = (await get(COLLECTIONS.availability, providerId).catch(() => null)) as Doc | null;
  // Older documents have no time zone of their own: the lawyer's country decides (Costa Rica by default).
  const provider = doc?.timezone ? null : ((await get("providers", providerId).catch(() => null)) as Doc | null);
  const tz = provider ? personTimeZone(provider) : CR_TZ;
  if (!doc) return { ...defaultAvailability(providerId, new Date(), tz), calendarId: null, isDefault: true };
  const norm = normalizeAvailability(doc, providerId, new Date(), tz);
  if ("error" in norm) {
    log(`[calls] stored availability for ${providerId} is invalid (${norm.error}); using defaults`, "error");
    return { ...defaultAvailability(providerId, new Date(), tz), calendarId: null, isDefault: true };
  }
  return { ...norm.value, updatedAt: str(doc.updatedAt) ?? norm.value.updatedAt, isDefault: false };
}

export async function saveAvailability(
  providerId: string,
  body: unknown,
  actor: { email: string; role: "lawyer" | "staff" },
): Promise<{ value: AvailabilityDoc } | { error: string }> {
  const provider = (await get("providers", providerId).catch(() => null)) as Doc | null;
  const norm = normalizeAvailability(body, providerId, new Date(), personTimeZone(provider));
  if ("error" in norm) return norm;
  await put(COLLECTIONS.availability, providerId, norm.value as unknown as Doc);
  await auditLog({
    actor: { uid: actor.email, email: actor.email, role: actor.role },
    action: "availability.updated",
    target: `${COLLECTIONS.availability}/${providerId}`,
    meta: { windows: norm.value.weekly.length, blackoutDates: norm.value.blackoutDates.length, maxCallsPerDay: norm.value.maxCallsPerDay, timezone: norm.value.timezone },
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
  // T2: a lawyer whose application is in review (or declined) offers no times.
  // REL: nor does a lawyer staff switched off (active: false) or a missing profile.
  const provider = (await get("providers", providerId).catch(() => null)) as Doc | null;
  if (!isProviderBookable(provider)) return [];
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

/** The country a member's membership covers: the membership's, else the client record's, else Costa Rica. */
export async function memberCountry(clientId: string, client?: Doc | null): Promise<CountryCode> {
  const m = await currentMembership(clientId).catch(() => null);
  const fromMembership = toCountryCode(m?.country);
  if (fromMembership) return fromMembership;
  const c = client ?? ((await get(COLLECTIONS.clients, clientId).catch(() => null)) as Doc | null);
  return toCountryCode(c?.legalCountry) ?? toCountryCode(c?.country) ?? toCountryCode(c?.jurisdiction) ?? "CR";
}

/** Countries a provider profile is licensed in (jurisdictions; older profiles are Costa Rica). */
export const providerCountries = (p: Doc | null | undefined): string[] =>
  candidateCountries({ countries: Array.isArray(p?.jurisdictions) ? (p!.jurisdictions as unknown[]).map(String) : [] });

/**
 * The lawyer a member books with: the matter's assigned lawyer, else the
 * client's, else the least-loaded lawyer licensed in the member's country
 * whose specialties match the matter area (lawyer_availability.specialties,
 * falling back to providers.legalAreas), else the least-loaded lawyer
 * licensed there, else DEFAULT_PROVIDER_ID when it is licensed there.
 * Null means nobody licensed in that country can take the call yet
 * (see flagUnassignedCountry).
 */
export async function routeLawyer(clientId: string, matterId?: string): Promise<string | null> {
  const matters = await findRecords<Matter>(COLLECTIONS.matters, { clientId }, { sortBy: "openedAt", desc: true });
  const m = (matterId ? matters.find((x) => x.id === matterId) : null) ?? matters.find((x) => !x.closedAt && x.assignedProviderId);
  // REL: an assigned lawyer who is no longer bookable (switched off, in review) is skipped.
  if (m?.assignedProviderId && await bookable(m.assignedProviderId)) return m.assignedProviderId;
  const client = (await get(COLLECTIONS.clients, clientId).catch(() => null)) as Doc | null;
  const assigned = str(client?.assignedProviderId);
  if (assigned && await bookable(assigned)) return assigned;
  return routeNewLawyer(clientId, matterId, undefined, { client, matters });
}

const bookable = async (providerId: string) => isProviderBookable((await get("providers", providerId).catch(() => null)) as Doc | null);

/**
 * The lawyer routing would pick for this member now, ignoring any current
 * assignment. ROUTING: this is the router in API/routing (hard filters:
 * active and verified, licensed in the country, specialty or its area,
 * language, a free slot soon, capacity, conflicts; ranked by fit, continuity,
 * hidden rating, earliest slot, load and region). `exclude` skips one lawyer
 * (offboarding). Nothing is written here; callers persist. Null when nobody
 * passes (callers run the no-match path).
 */
export async function routeNewLawyer(
  clientId: string,
  matterId?: string,
  exclude?: string,
  _pre?: { client?: Doc | null; matters?: Matter[] },
): Promise<string | null> {
  try {
    const d = await decideRoute(clientId, { matterId, trigger: "reroute", exclude });
    return d.decision.providerId;
  } catch (err) {
    log(`[calls] routing failed for ${clientId}: ${err instanceof Error ? err.message : err}`, "error");
    return null;
  }
}

/** Every bookable lawyer with specialties and countries (applicants in review are skipped). */
async function lawyerCandidates(area: string | null, placeholderMember = false): Promise<LawyerCandidate[]> {
  const avail = (await getAll(COLLECTIONS.availability).catch(() => [])) as Doc[];
  const saved = new Map<string, string[]>();
  for (const a of avail) {
    const id = str(a.providerId) ?? str(a.id);
    if (id) saved.set(id, Array.isArray(a.specialties) ? (a.specialties as string[]) : []);
  }
  const providers = (await getAll("providers").catch(() => [])) as Doc[];
  const out: LawyerCandidate[] = [];
  for (const p of providers) {
    const providerId = str(p.id);
    if (!providerId || p.active === false || p.status === "inactive") continue;
    if (isPlaceholderId(providerId) !== placeholderMember) continue;
    // T2: availability alone does not make a lawyer bookable; applicants in review are skipped.
    if (applicationBlocksCalls(p)) continue;
    // Lawyers without saved specialties: use their provider profile's legal areas.
    const own = saved.get(providerId);
    const specialties = own?.length ? own : Array.isArray(p.legalAreas) ? (p.legalAreas as string[]) : area ? [] : [];
    const load = (await findRecords<Consultation>(COLLECTIONS.consultations, { providerId, status: "booked" }).catch(() => [])).length;
    out.push({ providerId, specialties, countries: providerCountries(p), load });
  }
  return out;
}

/** The calm line a member sees while nobody licensed in their country can take calls. */
export const matchingNotice = (country: CountryCode) =>
  `We're matching you with a lawyer licensed in ${COUNTRIES[country].name}. Your CSM will contact you.`;

/**
 * No lawyer licensed in the member's country yet: one open staff task
 * ("member.unassigned_country"), deduplicated per member and country.
 * Joining and the rest of the portal are never blocked. Never throws.
 */
export async function flagUnassignedCountry(clientId: string, country?: CountryCode): Promise<CountryCode> {
  const c = country ?? await memberCountry(clientId);
  try {
    const client = (await get(COLLECTIONS.clients, clientId).catch(() => null)) as Doc | null;
    const name = str(client?.fullName) ?? str(client?.name) ?? clientId;
    await emitEvent("member.unassigned_country", {
      clientId,
      sourceId: clientId,
      sourceKind: "membership",
      dedupeKey: `${clientId}_country_${c}`,
      ownerEmail: await csmOwner(clientId),
      detail: `unassigned member in ${COUNTRIES[c].name} (${name})`,
    });
  } catch (err) {
    log(`[calls] unassigned-country task for ${clientId} failed: ${err instanceof Error ? err.message : err}`, "error");
  }
  return c;
}

/** True when at least one bookable lawyer is licensed in `country`. */
export async function hasLawyerIn(country: CountryCode, placeholderMember = false): Promise<boolean> {
  const candidates = await lawyerCandidates(null, placeholderMember).catch(() => [] as LawyerCandidate[]);
  return candidates.some((c) => candidateCountries(c).includes(country));
}

// ─── CSM task when the calendar fails ──────────────────────────────────────

async function csmOwner(clientId: string): Promise<string | undefined> {
  const m = await currentMembership(clientId).catch(() => null);
  return m?.csmEmail || Deno.env.get("DEFAULT_CSM_EMAIL") || undefined;
}

/**
 * One open task per consultation and time: "Meet link failed: send link"
 * (TASK_RULES "call.link_failed" through emitEvent). Idempotent while open; a
 * new failure after the task was closed opens a fresh one.
 */
export async function flagCalendarProblem(c: CallRecord, memberName: string, problem: string): Promise<void> {
  let dedupeKey = `${c.id}_${c.scheduledAt}`;
  const existing = await getRecord<CsmTask>(COLLECTIONS.csmTasks, taskIdFor("call.link_failed", { clientId: c.clientId, dedupeKey }))
    .catch(() => null);
  if (existing && existing.status !== "open") dedupeKey += `_${Date.now()}`;
  const start = Date.parse(c.scheduledAt);
  // Due within 2 h, and at least an hour before the call when there is time.
  const dueAt = new Date(Math.min(Date.now() + 2 * 60 * MIN, Math.max(Date.now(), start - 60 * MIN))).toISOString();
  const ids = await emitEvent("call.link_failed", {
    clientId: c.clientId,
    matterId: c.matterId,
    sourceId: c.id,
    dedupeKey,
    dueAt,
    ownerEmail: await csmOwner(c.clientId),
    detail: `${memberName}, ${whenLabel(c.scheduledAt)} (${problem})`,
  });
  log(`[calls] calendar problem on ${c.id}: csm_task ${ids[0] ?? "not created"}`);
}

// ─── Google Meet on booking ────────────────────────────────────────────────

/** Fake Meet link in Google's xxx-xxxx-xxx shape, stable per id (placeholder calls only). */
export function placeholderMeetUrl(id: string): string {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const letters = Array.from({ length: 10 }, (_, i) => String.fromCharCode(97 + ((h >>> (i % 4) * 8) + i * 7) % 26)).join("");
  return `https://meet.google.com/${letters.slice(0, 3)}-${letters.slice(3, 7)}-${letters.slice(7)}`;
}

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
  if (who.placeholder) {
    // Placeholder (seed) call: no Calendar event or invitation, a fake Meet link.
    logSkipped("calendar event", c.id);
    const updated = await updateRecord<CallRecord>(COLLECTIONS.consultations, c.id, {
      meetUrl: placeholderMeetUrl(c.id),
      calendarError: null,
    });
    return updated ?? c;
  }
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
  try {
    if (who.member.email) {
      const m = callBookedMemberEmail({ firstName: who.member.firstName, lawyerName: who.lawyer.name, whenLabel: whenLabel(c.scheduledAt, who.member.timezone), meetUrl: c.meetUrl, portalUrl: memberHomeUrl() });
      await enqueueEmail({ to: who.member.email, ...m, placeholder: who.placeholder }, `call_booked_${c.id}_${c.providerId}_${c.scheduledAt}_${c.meetUrl ? "link" : "nolink"}_member`);
    }
    // ROUTING: the lawyer gets the full pre-call brief in their email language (API/routing/precall.ts).
    if (who.lawyer.email) await sendPreCallEmail(c, "booked");
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
  await releaseSlot(c.providerId, c.scheduledAt, c.id);
  await audit(actor, "consultation.cancelled", c, { reason });
  const who = await peopleFor(c);
  try {
    if (who.member.email) {
      await enqueueEmail({ to: who.member.email, ...callChangedEmail({ change: "cancelled", greetingName: who.member.firstName, otherName: who.lawyer.name, oldWhenLabel: whenLabel(c.scheduledAt, who.member.timezone), link: `${frontendUrl()}/status/book`, linkLabel: "Book another time" }), placeholder: who.placeholder }, `call_cancelled_${c.id}_member`);
    }
    if (who.lawyer.email) {
      await enqueueEmail({ to: who.lawyer.email, ...callChangedEmail({ change: "cancelled", greetingName: who.lawyer.name, otherName: who.member.name, oldWhenLabel: whenLabel(c.scheduledAt, who.lawyer.timezone), link: `${frontendUrl()}/lawyer`, linkLabel: "Open Today" }), placeholder: who.placeholder }, `call_cancelled_${c.id}_lawyer`);
    }
  } catch (err) {
    log(`[calls] cancel emails for ${c.id} failed: ${err instanceof Error ? err.message : err}`, "error");
  }
  return updated ?? c;
}

/**
 * REL: move a call to `newIso` if that start is still free for its lawyer:
 * under the lawyer's slot lock, re-check the offered slots (unless staff
 * force it) and claim the start time, then reschedule. Null when taken.
 */
export async function moveCallIfFree(c: CallRecord, newIso: string, actor: Actor, opts: { force?: boolean } = {}): Promise<CallRecord | null> {
  const claimed = await withLawyerSlots(c.providerId, async () => {
    if (!opts.force && !(await slotsFor(c.providerId, new Date(), c.id)).includes(newIso)) return false;
    return (await claimSlot(c.providerId, newIso, c.id)) || !!opts.force;
  });
  return claimed ? await rescheduleCall(c, newIso, actor) : null;
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
  await releaseSlot(c.providerId, old, c.id);
  await audit(actor, "consultation.rescheduled", c, { from: old, to: newIso });
  try {
    const args = (tz: string) => ({ change: "rescheduled" as const, oldWhenLabel: whenLabel(old, tz), newWhenLabel: whenLabel(newIso, tz), meetUrl: updated.meetUrl });
    if (who.member.email) {
      await enqueueEmail({ to: who.member.email, ...callChangedEmail({ ...args(who.member.timezone), greetingName: who.member.firstName, otherName: who.lawyer.name, link: memberHomeUrl(), linkLabel: "Open your ILP home" }), placeholder: who.placeholder }, `call_moved_${c.id}_${newIso}_member`);
    }
    if (who.lawyer.email) {
      await enqueueEmail({ to: who.lawyer.email, ...callChangedEmail({ ...args(who.lawyer.timezone), greetingName: who.lawyer.name, otherName: who.member.name, link: lawyerBriefUrl(c.id), linkLabel: "Open the brief" }), placeholder: who.placeholder }, `call_moved_${c.id}_${newIso}_lawyer`);
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
export async function markNoShow(c0: CallRecord, actor: Actor): Promise<{ call: CallRecord; membership: Membership | null; already?: boolean }> {
  // REL: one charge even when the button is pressed twice at once (lock + re-read).
  return await syncTransaction(COLLECTIONS.consultations, c0.id, async () => {
    const c = (await getRecord<CallRecord>(COLLECTIONS.consultations, c0.id)) ?? c0;
    if (c.status === "no_show") return { call: c, membership: null, already: true };
    return await markNoShowLocked(c, actor);
  });
}

async function markNoShowLocked(c: CallRecord, actor: Actor): Promise<{ call: CallRecord; membership: Membership | null }> {
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
export async function restoreCall(c0: CallRecord, actor: Actor): Promise<Membership | null> {
  return (await restoreCallOnce(c0, actor)).membership;
}

/** REL: lock + re-read, so two clicks restore once; `restored` is false for the second. */
export async function restoreCallOnce(c0: CallRecord, actor: Actor): Promise<{ restored: boolean; membership: Membership | null }> {
  return await syncTransaction(COLLECTIONS.consultations, c0.id, async () => {
    const c = (await getRecord<CallRecord>(COLLECTIONS.consultations, c0.id)) ?? c0;
    if (!c.chargedAt || c.restoredAt) return { restored: false, membership: null };
    return { restored: true, membership: await restoreCallLocked(c, actor) };
  });
}

async function restoreCallLocked(c: CallRecord, actor: Actor): Promise<Membership | null> {
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
/**
 * Granted on the call and not withdrawn by the member since (P7). Fails
 * closed: if the consent history cannot be read, nothing is fetched.
 */
export async function recordingStillAllowed(c: Pick<CallRecord, "clientId" | "consent">): Promise<boolean> {
  if (c.consent?.recording !== "granted") return false;
  try {
    const rows = await query(COLLECTIONS.consents, [{ field: "clientId", op: "EQUAL", value: c.clientId }]);
    return recordingAllowedFor(c, rows as unknown as ConsentRecord[]);
  } catch {
    return false;
  }
}

export async function pullMeetTranscript(c: CallRecord): Promise<{ status: "fetched" | "not_ready" | "no_event" | "no_consent"; text?: string; source?: string; message?: string }> {
  if (isPlaceholderDoc(c)) return { status: "no_event", message: "Placeholder call: no Google Meet transcript." };
  if (c.consent?.recording !== "granted") return { status: "no_consent", message: "Recording consent is not granted." };
  if (!(await recordingStillAllowed(c))) return { status: "no_consent", message: RECORDING_WITHDRAWN_MESSAGE };
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
