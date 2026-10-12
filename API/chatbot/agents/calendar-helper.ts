import { getGoogleAccessToken } from "../../../helper/getGoogleAuthClient.ts";
import { conflictsWithBusy } from "./scheduling-policy.ts";


export async function listCalendarEvents(timeMin: string, timeMax: string) {
  const CALENDAR_ID = Deno.env.get("CALENDAR_ID");
  const token = await getGoogleAccessToken();
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime"
  });
  const url = `https://www.googleapis.com/calendar/v3/calendars/${CALENDAR_ID}/events?${params.toString()}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error("Failed to fetch calendar events");
  const data = await response.json();
  return data.items || [];
}

/**
 * Returns false when a Calendar event no longer exists (deleted/cancelled),
 * true otherwise. Used by bookConsultation's idempotency guard so we never
 * reuse a stale Firestore→Calendar linkage and hand the client a dead
 * "event couldn't be found" Meet link.
 *
 * Fail-safe: on transient/non-404 errors we return `true` (assume it exists)
 * so a temporary Google hiccup can't cause us to spawn a duplicate event.
 */
export async function eventExists(eventId: string): Promise<boolean> {
  if (!eventId) return false;
  const CALENDAR_ID = Deno.env.get("CALENDAR_ID");
  const token = await getGoogleAccessToken();
  const url = `https://www.googleapis.com/calendar/v3/calendars/${CALENDAR_ID}/events/${encodeURIComponent(eventId)}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  // 404 = deleted, 410 = gone → definitively no longer bookable.
  if (response.status === 404 || response.status === 410) return false;
  // Any other non-OK status is treated as "still exists" to avoid duplicates.
  if (!response.ok) return true;
  const data = await response.json();
  // A cancelled event is effectively gone from the client's perspective.
  return data.status !== "cancelled";
}

export async function fetchBusySlots(timeMin: string, timeMax: string) {

  const events = await listCalendarEvents(timeMin, timeMax);
  return events.map((e: { start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string } }) => ({
    start: e.start.dateTime || e.start.date,
    end: e.end.dateTime || e.end.date
  }));
}

export function isSlotAvailable(start: string, end: string, busySlots: { start: string; end: string }[]) {
  // Includes the 30-min inter-call buffer (conflictsWithBusy) so a requested
  // slot sitting right after another call is correctly reported as unavailable.
  return !conflictsWithBusy(new Date(start).getTime(), new Date(end).getTime(), busySlots);
}


export async function createCalendarEvent(payload: { summary: string, description: string, start: string, end: string, participants: string[] }) {
  const CALENDAR_ID = Deno.env.get("CALENDAR_ID");
  const token = await getGoogleAccessToken();
  const url = `https://www.googleapis.com/calendar/v3/calendars/${CALENDAR_ID}/events?conferenceDataVersion=1`;
  const body = {
    summary: payload.summary,
    description: payload.description,
    start: { dateTime: payload.start, timeZone: "America/Costa_Rica" },
    end: { dateTime: payload.end, timeZone: "America/Costa_Rica" },
    attendees: payload.participants.map(email => ({ email })),
    conferenceData: {
      createRequest: { requestId: `ilp-chat-${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } }
    }
  };
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to create event: ${err}`);
  }
  return await response.json();
}