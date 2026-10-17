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
 */

import { getGoogleAccessToken } from "./getGoogleAuthClient.ts";
import type { CalendarSlot } from "../config/integrations.ts";

const CALENDAR_TIMEZONE = "America/Costa_Rica";

function calendarId(): string {
  const id = Deno.env.get("CALENDAR_ID");
  if (!id) throw new Error("CALENDAR_ID is not configured.");
  return id;
}

/** List busy events in [from, to] as `{ start, end }` ISO strings. */
export async function listBusySlots(
  from: string,
  to: string,
): Promise<Array<{ start: string; end: string }>> {
  const token = await getGoogleAccessToken();
  const params = new URLSearchParams({
    timeMin: from,
    timeMax: to,
    singleEvents: "true",
    orderBy: "startTime",
  });
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId()}/events?${params.toString()}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to list calendar events (${res.status}): ${body}`);
  }
  const data = (await res.json()) as {
    items?: Array<{
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
    }>;
  };
  return (data.items ?? []).map((e) => ({
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
 * Create a Google Calendar event (with a Google Meet conference) and return
 * its id + htmlLink.
 */
export async function createCalendarEvent(opts: {
  slot: CalendarSlot;
  title: string;
  description?: string;
  attendees?: string[];
}): Promise<{ eventId: string; htmlLink?: string }> {
  const token = await getGoogleAccessToken();
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId()}/events?conferenceDataVersion=1`;
  const body = {
    summary: opts.title,
    description: opts.description ?? "",
    start: { dateTime: opts.slot.start, timeZone: opts.slot.timezone || CALENDAR_TIMEZONE },
    end: { dateTime: opts.slot.end, timeZone: opts.slot.timezone || CALENDAR_TIMEZONE },
    attendees: (opts.attendees ?? []).map((email) => ({ email })),
    conferenceData: {
      createRequest: {
        requestId: `ilp-${Date.now()}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to create calendar event (${res.status}): ${err}`);
  }
  const data = (await res.json()) as { id?: string; htmlLink?: string };
  return { eventId: data.id ?? "", htmlLink: data.htmlLink };
}