/**
 * helper/calendar.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Google Calendar integration for ILP.
 *
 * Wires the previously NOT_IMPLEMENTED `listAvailableSlots` /
 * `createCalendarEvent` placeholders in `config/integrations.ts` to the real
 * Google Calendar REST API, reusing the existing service-account token helper
 * (`getGoogleAuthClient.ts`).
 *
 * The chatbot's `agents/calendar-helper.ts` already implements event creation
 * and busy-slot listing; this module exposes the same capability under the
 * stable `CalendarSlot` contract so the consultations router and the future
 * dashboard reschedule flow share one implementation.
 *
 * P3 adds: Meet link on create (meetUrl), move/delete for reschedule and
 * cancel, free/busy for a lawyer's own calendar, and reading the Meet
 * transcript (or Gemini notes) a call leaves on its event.
 */

import { getGoogleAccessToken } from "./getGoogleAuthClient.ts";
import type { CalendarSlot } from "../config/integrations.ts";
import { type CalendarAttachment, meetUrlOf, pickMeetDocument } from "../API/calls/callLogic.ts";

const CALENDAR_TIMEZONE = "America/Costa_Rica";

function calendarId(): string {
  const id = Deno.env.get("CALENDAR_ID");
  if (!id) throw new Error("CALENDAR_ID is not configured.");
  return id;
}

/** The parts of a Calendar event ILP reads. */
export interface CalendarEvent {
  id?: string;
  status?: string;
  description?: string;
  summary?: string;
  hangoutLink?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  attachments?: CalendarAttachment[];
}

/** Fetch a single calendar event by id (sync-meet-notes, Meet transcripts). */
export async function getCalendarEvent(eventId: string): Promise<CalendarEvent | null> {
  const token = await getGoogleAccessToken();
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId())}/events/${encodeURIComponent(eventId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to fetch calendar event (${res.status}): ${body}`);
  }
  return (await res.json()) as CalendarEvent;
}

/**
 * Busy intervals in [from, to] as `{ start, end }` ISO strings.
 *
 * Without `forCalendarId` this lists the events on the ILP calendar
 * (CALENDAR_ID), as before. With it, it asks the Calendar free/busy API for
 * that calendar (a lawyer's Google Calendar, by email). Free/busy works for
 * any calendar in the Workspace domain, and for an outside calendar only when
 * its owner shares free/busy with the impersonated user (GOOGLE_SUBJECT_EMAIL)
 * or publicly; otherwise Google reports an error for that calendar and this
 * throws, so callers can ignore it and fall back to ILP's own bookings.
 */
export async function listBusySlots(
  from: string,
  to: string,
  forCalendarId?: string,
): Promise<Array<{ start: string; end: string }>> {
  const token = await getGoogleAccessToken();
  if (forCalendarId) {
    const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin: from, timeMax: to, timeZone: CALENDAR_TIMEZONE, items: [{ id: forCalendarId }] }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to read free/busy (${res.status}): ${body}`);
    }
    const data = (await res.json()) as {
      calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: Array<{ reason?: string }> }>;
    };
    const cal = data.calendars?.[forCalendarId] ?? Object.values(data.calendars ?? {})[0];
    if (cal?.errors?.length) {
      throw new Error(`Free/busy unavailable for ${forCalendarId}: ${cal.errors.map((e) => e.reason).join(", ")}`);
    }
    return (cal?.busy ?? []).map((b) => ({ start: b.start, end: b.end }));
  }
  const params = new URLSearchParams({
    timeMin: from,
    timeMax: to,
    singleEvents: "true",
    orderBy: "startTime",
  });
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId())}/events?${params.toString()}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to list calendar events (${res.status}): ${body}`);
  }
  const data = (await res.json()) as {
    items?: Array<{
      status?: string;
      transparency?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
    }>;
  };
  return (data.items ?? [])
    .filter((e) => e.status !== "cancelled" && e.transparency !== "transparent")
    .map((e) => ({
      start: e.start?.dateTime || e.start?.date || "",
      end: e.end?.dateTime || e.end?.date || "",
    }));
}

/**
 * List available slots for a provider within [from, to]. This is a thin
 * availability check: it returns the requested window as a single slot when
 * it does not collide with any busy event. A full free-slot generator is a
 * later phase; this satisfies the `listAvailableSlots` contract.
 */
export async function listAvailableSlots(opts: {
  providerId: string;
  from: string;
  to: string;
}): Promise<CalendarSlot[]> {
  void opts.providerId;
  const busy = await listBusySlots(opts.from, opts.to);
  const start = new Date(opts.from).getTime();
  const end = new Date(opts.to).getTime();
  const collides = busy.some((b) => {
    const bs = new Date(b.start).getTime();
    const be = new Date(b.end).getTime();
    return bs < end && be > start;
  });
  if (collides) return [];
  return [{ start: opts.from, end: opts.to, timezone: CALENDAR_TIMEZONE }];
}

/**
 * Create a Google Calendar event with a Google Meet conference on the ILP
 * calendar and return its id, htmlLink and Meet link.
 *
 * `requestId` makes the Meet request idempotent (pass the consultation id).
 * Attendees get Google's own invitation email unless CALENDAR_SEND_UPDATES
 * is "none".
 */
export async function createCalendarEvent(opts: {
  slot: CalendarSlot;
  title: string;
  description?: string;
  attendees?: string[];
  requestId?: string;
  /** Private extended properties (e.g. { consultationId }) for tracing. */
  privateProps?: Record<string, string>;
}): Promise<{ eventId: string; htmlLink?: string; meetUrl?: string }> {
  const token = await getGoogleAccessToken();
  const params = new URLSearchParams({ conferenceDataVersion: "1", sendUpdates: sendUpdates() });
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId())}/events?${params}`;
  const body: Record<string, unknown> = {
    summary: opts.title,
    description: opts.description ?? "",
    start: { dateTime: opts.slot.start, timeZone: opts.slot.timezone || CALENDAR_TIMEZONE },
    end: { dateTime: opts.slot.end, timeZone: opts.slot.timezone || CALENDAR_TIMEZONE },
    attendees: [...new Set((opts.attendees ?? []).filter(Boolean).map((e) => e.trim().toLowerCase()))].map((email) => ({ email })),
    guestsCanInviteOthers: false,
    conferenceData: {
      createRequest: {
        requestId: (opts.requestId || `ilp-${Date.now()}`).slice(0, 64),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
  };
  if (opts.privateProps) body.extendedProperties = { private: opts.privateProps };
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to create calendar event (${res.status}): ${err}`);
  }
  const data = (await res.json()) as CalendarEvent;
  return { eventId: data.id ?? "", htmlLink: data.htmlLink, meetUrl: meetUrlOf(data) ?? undefined };
}

function sendUpdates(): "all" | "externalOnly" | "none" {
  const v = Deno.env.get("CALENDAR_SEND_UPDATES");
  return v === "none" || v === "externalOnly" ? v : "all";
}

/** Move an event to a new slot (reschedule). Keeps its Meet link. */
export async function updateCalendarEventTime(eventId: string, slot: CalendarSlot): Promise<CalendarEvent> {
  const token = await getGoogleAccessToken();
  const params = new URLSearchParams({ sendUpdates: sendUpdates() });
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId())}/events/${encodeURIComponent(eventId)}?${params}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      start: { dateTime: slot.start, timeZone: slot.timezone || CALENDAR_TIMEZONE },
      end: { dateTime: slot.end, timeZone: slot.timezone || CALENDAR_TIMEZONE },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to move calendar event (${res.status}): ${err}`);
  }
  return (await res.json()) as CalendarEvent;
}

/** Delete an event (cancellation). A missing event counts as deleted. */
export async function deleteCalendarEvent(eventId: string): Promise<void> {
  const token = await getGoogleAccessToken();
  const params = new URLSearchParams({ sendUpdates: sendUpdates() });
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId())}/events/${encodeURIComponent(eventId)}?${params}`;
  const res = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    const err = await res.text();
    throw new Error(`Failed to delete calendar event (${res.status}): ${err}`);
  }
}

/** Export a Google Doc as plain text through the Drive API (drive.readonly). */
export async function exportGoogleDocText(fileId: string): Promise<string> {
  const token = await getGoogleAccessToken();
  const url =
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text%2Fplain&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to export Google Doc ${fileId} (${res.status}): ${err}`);
  }
  return (await res.text()).replace(/^\uFEFF/, "").trim();
}

export type MeetNotesResult =
  | { status: "fetched"; source: "transcript" | "notes" | "description"; text: string; fileId?: string; title?: string }
  | { status: "not_ready" | "no_event"; message: string };

/**
 * Read what Meet left on a calendar event after the call. Meet attaches a
 * "… - Transcript" Google Doc when transcription is on, and "Notes by
 * Gemini" when note-taking is on; both live in the organizer's Drive (the
 * impersonated GOOGLE_SUBJECT_EMAIL). Preference: transcript, then notes,
 * then (when `allowDescription`) the event description, which is where the
 * older sync-meet-notes flow found pasted notes.
 */
export async function fetchMeetNotes(eventId: string, opts: { allowDescription?: boolean } = {}): Promise<MeetNotesResult> {
  const event = await getCalendarEvent(eventId);
  if (!event) return { status: "no_event", message: "The calendar event no longer exists." };
  const doc = pickMeetDocument(event.attachments);
  if (doc) {
    const text = await exportGoogleDocText(doc.fileId);
    if (text) return { status: "fetched", source: doc.kind, text, fileId: doc.fileId, title: doc.title };
  }
  const description = (event.description ?? "").trim();
  if (opts.allowDescription && description) return { status: "fetched", source: "description", text: description };
  return {
    status: "not_ready",
    message: "Meet has not attached a transcript to the calendar event yet. It usually appears a few minutes after the call ends.",
  };
}
