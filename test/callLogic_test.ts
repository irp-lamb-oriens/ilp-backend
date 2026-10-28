import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import {
  buildSlots,
  canChange,
  crDateKey,
  defaultAvailability,
  joinOpen,
  meetUrlOf,
  normalizeAvailability,
  noShowCheck,
  pickLawyer,
  pickMeetDocument,
  reminderToSend,
  transcriptFetchDue,
} from "../API/calls/callLogic.ts";

/**
 * P3 call rules: slots, routing, reminders, join window, no-show, Meet docs.
 * Pure functions only. Run: deno test test/callLogic_test.ts
 */

// Monday 2026-11-02 08:00 Costa Rica = 14:00 UTC.
const MON_8AM_CR = new Date("2026-11-02T14:00:00Z");
const cr = (ymd: string, hhmm: string) => new Date(`${ymd}T${hhmm}:00-06:00`).toISOString();
const rules = (over: Record<string, unknown> = {}) => ({
  weekly: [{ day: 1 as const, start: "09:00", end: "10:00" }, { day: 2 as const, start: "09:00", end: "09:40" }],
  blackoutDates: [] as string[],
  minLeadHours: 0,
  maxCallsPerDay: 6,
  ...over,
});

Deno.test("slots: weekly windows in CR time, 20-minute steps", () => {
  const slots = buildSlots({ now: MON_8AM_CR, availability: rules(), booked: [], days: 2 });
  assertEquals(slots, [
    cr("2026-11-02", "09:00"), cr("2026-11-02", "09:20"), cr("2026-11-02", "09:40"),
    cr("2026-11-03", "09:00"), cr("2026-11-03", "09:20"),
  ]);
});

Deno.test("slots: lead time removes the earliest slots", () => {
  const slots = buildSlots({ now: MON_8AM_CR, availability: rules({ minLeadHours: 1.5 as unknown as number }), booked: [], days: 1 });
  // 08:00 + 1.5 h = 09:30 → 09:40 only
  assertEquals(slots, [cr("2026-11-02", "09:40")]);
});

Deno.test("slots: blackout dates are skipped", () => {
  const slots = buildSlots({ now: MON_8AM_CR, availability: rules({ blackoutDates: ["2026-11-02"] }), booked: [], days: 2 });
  assertEquals(slots, [cr("2026-11-03", "09:00"), cr("2026-11-03", "09:20")]);
});

Deno.test("slots: booked consultations and overlapping calls are removed; cancelled ones are not", () => {
  const slots = buildSlots({
    now: MON_8AM_CR,
    availability: rules(),
    booked: [
      { scheduledAt: cr("2026-11-02", "09:20"), durationMin: 20, status: "booked" },
      { scheduledAt: cr("2026-11-02", "09:00"), durationMin: 20, status: "cancelled" },
      { scheduledAt: cr("2026-11-03", "09:10"), durationMin: 20, status: "booked" }, // off-grid, blocks 09:00 and 09:20
    ],
    days: 2,
  });
  assertEquals(slots, [cr("2026-11-02", "09:00"), cr("2026-11-02", "09:40")]);
});

Deno.test("slots: Google Calendar busy times are removed", () => {
  const slots = buildSlots({
    now: MON_8AM_CR,
    availability: rules(),
    booked: [],
    busy: [{ start: cr("2026-11-02", "09:30"), end: cr("2026-11-02", "10:30") }],
    days: 1,
  });
  assertEquals(slots, [cr("2026-11-02", "09:00")]);
});

Deno.test("slots: a day at maxCallsPerDay offers nothing", () => {
  const slots = buildSlots({
    now: MON_8AM_CR,
    availability: rules({ maxCallsPerDay: 1 }),
    booked: [{ scheduledAt: cr("2026-11-02", "11:00"), durationMin: 20, status: "completed" }],
    days: 2,
  });
  assertEquals(slots, [cr("2026-11-03", "09:00"), cr("2026-11-03", "09:20")]);
});

Deno.test("slots: CR day boundary (late evening UTC is still the CR day)", () => {
  // 2026-11-02 23:30 CR = 2026-11-03 05:30 UTC
  assertEquals(crDateKey(Date.parse("2026-11-03T05:30:00Z")), "2026-11-02");
  const late = buildSlots({
    now: new Date("2026-11-03T05:30:00Z"),
    availability: { weekly: [{ day: 1, start: "23:00", end: "24:00" }], blackoutDates: [], minLeadHours: 0, maxCallsPerDay: 6 },
    booked: [],
    days: 1,
  });
  assertEquals(late, [cr("2026-11-02", "23:40")]);
});

Deno.test("slots: default availability matches the old weekday hours", () => {
  const a = defaultAvailability("p1", MON_8AM_CR);
  const slots = buildSlots({ now: MON_8AM_CR, availability: { ...a, minLeadHours: 0 }, booked: [], days: 1 });
  assertEquals(slots.length, 24); // 8-12 and 13-17, 20-minute steps
  assertEquals(slots[0], cr("2026-11-02", "08:00"));
  assertEquals(slots.includes(cr("2026-11-02", "12:00")), false);
});

Deno.test("availability: validation and normalisation", () => {
  const ok = normalizeAvailability({
    weekly: [{ day: 3, start: "13:00", end: "15:00" }, { day: 1, start: "08:30", end: "12:00" }],
    blackoutDates: ["2026-12-24", "2026-12-24", "bad"],
    minLeadHours: "24",
    maxCallsPerDay: 4,
    specialties: ["Real Estate", "corporate", "corporate"],
    calendarId: "Adriana@Example.com",
  }, "p1");
  if (!("value" in ok)) throw new Error(ok.error);
  assertEquals(ok.value.weekly.map((w) => w.day), [1, 3]);
  assertEquals(ok.value.blackoutDates, ["2026-12-24"]);
  assertEquals(ok.value.minLeadHours, 24);
  assertEquals(ok.value.specialties, ["real_estate", "corporate"]);
  assertEquals(ok.value.calendarId, "adriana@example.com");
  assertEquals(ok.value.timezone, "America/Costa_Rica");

  const overlap = normalizeAvailability({ weekly: [{ day: 1, start: "08:00", end: "10:00" }, { day: 1, start: "09:00", end: "11:00" }] }, "p1");
  assertEquals("error" in overlap, true);
  const backwards = normalizeAvailability({ weekly: [{ day: 1, start: "10:00", end: "09:00" }] }, "p1");
  assertEquals("error" in backwards, true);
  const tooMany = normalizeAvailability({ maxCallsPerDay: 50 }, "p1");
  assertEquals("error" in tooMany, true);
});

Deno.test("routing: specialty match, least loaded, else fallback", () => {
  const c = [
    { providerId: "b", specialties: ["immigration"], load: 0 },
    { providerId: "c", specialties: ["real_estate", "corporate"], load: 3 },
    { providerId: "a", specialties: ["corporate"], load: 1 },
  ];
  assertEquals(pickLawyer("corporate", c, "dflt"), "a");
  assertEquals(pickLawyer("property", c, "dflt"), "c"); // property ≡ real_estate
  assertEquals(pickLawyer("tax", c, "dflt"), "dflt");
  assertEquals(pickLawyer(null, c, null), null);
});

Deno.test("reminders: 24h then 1h, once each", () => {
  const start = "2026-11-05T15:00:00Z";
  const base = { status: "booked" as const, scheduledAt: start, createdAt: "2026-11-01T10:00:00Z" };
  assertEquals(reminderToSend({ ...base, remindersSent: [] }, new Date("2026-11-04T14:00:00Z")).send, null);
  assertEquals(reminderToSend({ ...base, remindersSent: [] }, new Date("2026-11-04T15:05:00Z")), { send: "24h", mark: ["24h"] });
  assertEquals(reminderToSend({ ...base, remindersSent: ["24h"] }, new Date("2026-11-04T20:00:00Z")).send, null);
  assertEquals(reminderToSend({ ...base, remindersSent: ["24h"] }, new Date("2026-11-05T14:10:00Z")), { send: "1h", mark: ["1h"] });
  assertEquals(reminderToSend({ ...base, remindersSent: ["24h", "1h"] }, new Date("2026-11-05T14:30:00Z")).send, null);
  // Missed sweep: both due → only 1h, 24h marked.
  assertEquals(reminderToSend({ ...base, remindersSent: [] }, new Date("2026-11-05T14:20:00Z")), { send: "1h", mark: ["24h", "1h"] });
  // Started or not booked → nothing.
  assertEquals(reminderToSend({ ...base, remindersSent: [] }, new Date("2026-11-05T15:01:00Z")).send, null);
  assertEquals(reminderToSend({ ...base, status: "cancelled", remindersSent: [] }, new Date("2026-11-05T14:10:00Z")).send, null);
});

Deno.test("reminders: booked inside 24 h skips the 24h reminder", () => {
  const c = { status: "booked" as const, scheduledAt: "2026-11-05T15:00:00Z", createdAt: "2026-11-04T20:00:00Z", remindersSent: [] };
  assertEquals(reminderToSend(c, new Date("2026-11-04T21:00:00Z")), { send: null, mark: ["24h"] });
});

Deno.test("join window: 10 minutes before to 30 after the end", () => {
  const c = { status: "booked" as const, scheduledAt: "2026-11-05T15:00:00Z", durationMin: 20 };
  assertEquals(joinOpen(c, new Date("2026-11-05T14:49:00Z")), false);
  assertEquals(joinOpen(c, new Date("2026-11-05T14:50:00Z")), true);
  assertEquals(joinOpen(c, new Date("2026-11-05T15:50:00Z")), true);
  assertEquals(joinOpen(c, new Date("2026-11-05T15:51:00Z")), false);
  assertEquals(joinOpen({ ...c, status: "cancelled" }, new Date("2026-11-05T15:00:00Z")), false);
});

Deno.test("change: members up to 24 h before, staff any time", () => {
  const c = { status: "booked" as const, scheduledAt: "2026-11-05T15:00:00Z" };
  assertEquals(canChange(c, new Date("2026-11-04T14:59:00Z"), "member").ok, true);
  assertEquals(canChange(c, new Date("2026-11-04T15:01:00Z"), "member").ok, false);
  assertEquals(canChange(c, new Date("2026-11-05T14:59:00Z"), "staff").ok, true);
  assertEquals(canChange({ ...c, status: "completed" }, new Date("2026-11-01T00:00:00Z"), "staff").ok, false);
});

Deno.test("no-show: only after 10 minutes of waiting", () => {
  const c = { status: "booked" as const, scheduledAt: "2026-11-05T15:00:00Z" };
  assertEquals(noShowCheck(c, new Date("2026-11-05T15:09:00Z")).ok, false);
  assertEquals(noShowCheck(c, new Date("2026-11-05T15:10:00Z")).ok, true);
  assertEquals(noShowCheck({ ...c, status: "completed" }, new Date("2026-11-05T16:00:00Z")).ok, false);
});

Deno.test("meet: link and transcript document from the event", () => {
  assertEquals(meetUrlOf({ hangoutLink: "https://meet.google.com/abc-defg-hij" }), "https://meet.google.com/abc-defg-hij");
  assertEquals(meetUrlOf({ conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:1" }, { entryPointType: "video", uri: "https://meet.google.com/x" }] } }), "https://meet.google.com/x");
  assertEquals(meetUrlOf(null), null);
  const doc = "application/vnd.google-apps.document";
  assertEquals(
    pickMeetDocument([
      { title: "ILP call - 2026/11/05 - Notes by Gemini", mimeType: doc, fileId: "notes1234567" },
      { title: "ILP call (2026-11-05 09:00 GMT-6) - Transcript", mimeType: doc, fileUrl: "https://docs.google.com/document/d/tr4nscr1pt_ID/edit" },
    ]),
    { fileId: "tr4nscr1pt_ID", kind: "transcript", title: "ILP call (2026-11-05 09:00 GMT-6) - Transcript" },
  );
  assertEquals(pickMeetDocument([{ title: "Notes by Gemini", mimeType: doc, fileId: "notes1234567" }])?.kind, "notes");
  assertEquals(pickMeetDocument([{ title: "Recording", mimeType: "video/mp4", fileId: "vid123456789" }]), null);
  assertEquals(pickMeetDocument(undefined), null);
});

Deno.test("transcript sweep: only consented calls, after the call, within a day", () => {
  const c = {
    status: "booked" as const, scheduledAt: "2026-11-05T15:00:00Z", durationMin: 20,
    consent: { recording: "granted" as const }, calendarEventId: "evt1",
  };
  assertEquals(transcriptFetchDue(c, new Date("2026-11-05T15:25:00Z")), false);
  assertEquals(transcriptFetchDue(c, new Date("2026-11-05T15:31:00Z")), true);
  assertEquals(transcriptFetchDue({ ...c, consent: { recording: "declined" } }, new Date("2026-11-05T15:31:00Z")), false);
  assertEquals(transcriptFetchDue({ ...c, transcript: "x" }, new Date("2026-11-05T15:31:00Z")), false);
  assertEquals(transcriptFetchDue({ ...c, transcriptFetchAttempts: 8 }, new Date("2026-11-05T15:31:00Z")), false);
  assertEquals(transcriptFetchDue(c, new Date("2026-11-06T16:00:00Z")), false);
});

// ─── COUNTRIES: lawyers in their own time zone, routing by country ────────

Deno.test("slots follow the lawyer's time zone, including clock changes", async () => {
  const { dateKeyIn, tzOffsetMin, wallToUtc, zoneLabel } = await import("../API/calls/callLogic.ts");
  assertEquals(tzOffsetMin("America/Costa_Rica", Date.parse("2026-07-01T12:00:00Z")), -360);
  assertEquals(tzOffsetMin("Europe/Madrid", Date.parse("2026-07-01T12:00:00Z")), 120);
  assertEquals(tzOffsetMin("Europe/Madrid", Date.parse("2026-11-02T12:00:00Z")), 60);
  assertEquals(tzOffsetMin("Atlantic/Azores", Date.parse("2026-11-02T12:00:00Z")), -60);
  assertEquals(new Date(wallToUtc("Europe/Lisbon", "2026-10-26", 9 * 60)).toISOString(), "2026-10-26T09:00:00.000Z");
  assertEquals(dateKeyIn("Asia/Tokyo", Date.parse("2026-11-02T20:00:00Z")), "2026-11-03");
  assertEquals(zoneLabel("Atlantic/Canary"), "Canary Islands time");
  assertEquals(zoneLabel("America/Bogota"), "Colombia time");
  // A Madrid lawyer's 09:00 on Friday Oct 23 (summer time) and on Monday Oct 26 (after the change).
  const madrid = { ...rules({ weekly: [{ day: 5 as const, start: "09:00", end: "09:20" }, { day: 1 as const, start: "09:00", end: "09:20" }] }), timezone: "Europe/Madrid" };
  const slots = buildSlots({ now: new Date("2026-10-22T12:00:00Z"), availability: madrid, booked: [], days: 5 });
  assertEquals(slots, ["2026-10-23T07:00:00.000Z", "2026-10-26T08:00:00.000Z"]);
  // Saved settings keep the lawyer's zone; an unknown zone is refused.
  const ok = normalizeAvailability({ weekly: [], timezone: "America/Mexico_City" }, "p1");
  assertEquals("value" in ok && ok.value.timezone, "America/Mexico_City");
  assertEquals("error" in normalizeAvailability({ weekly: [], timezone: "Mars/Base" }, "p1"), true);
  const pt = normalizeAvailability({ weekly: [] }, "p1", new Date(), "Europe/Lisbon");
  assertEquals("value" in pt && pt.value.timezone, "Europe/Lisbon");
  assertEquals(defaultAvailability("p1", new Date(), "America/Bogota").timezone, "America/Bogota");
});

Deno.test("routing by country: only lawyers licensed there; null when there is none", () => {
  const c = [
    { providerId: "cr1", specialties: ["corporate"], load: 0 }, // older profile: Costa Rica
    { providerId: "es1", specialties: ["immigration"], countries: ["ES"], load: 2 },
    { providerId: "es2", specialties: ["tax"], countries: ["ES", "PT"], load: 0 },
  ];
  assertEquals(pickLawyer("corporate", c, "dflt", "CR"), "cr1");
  assertEquals(pickLawyer("immigration", c, "dflt", "ES"), "es1");
  assertEquals(pickLawyer("corporate", c, "dflt", "ES"), "es2"); // no specialty match: least loaded in Spain
  assertEquals(pickLawyer("tax", c, null, "PT"), "es2");
  assertEquals(pickLawyer("tax", c, null, "CO"), null); // nobody licensed in Colombia yet
  assertEquals(pickLawyer("tax", c, "co_default", "CO"), "co_default"); // caller vouches for the fallback
  assertEquals(pickLawyer("corporate", c, "dflt"), "cr1"); // no country: as before
});

// ─── REL: calls nobody wrapped up ─────────────────────────────────────────
Deno.test("callOutcomeMissing: booked a day after the end, completed two days without a handoff, not older than 30 days", async () => {
  const { callOutcomeMissing } = await import("../API/calls/callLogic.ts");
  const c = { scheduledAt: "2026-10-21T15:00:00.000Z", durationMin: 20 };
  const at = (iso: string) => new Date(iso);
  assertEquals(callOutcomeMissing({ ...c, status: "booked" }, at("2026-10-22T15:19:00.000Z")), false, "less than a day after the end");
  assertEquals(callOutcomeMissing({ ...c, status: "booked" }, at("2026-10-22T15:20:00.000Z")), true);
  assertEquals(callOutcomeMissing({ ...c, status: "in_progress" }, at("2026-10-23T00:00:00.000Z")), true);
  assertEquals(callOutcomeMissing({ ...c, status: "completed", endedAt: "2026-10-21T15:20:00.000Z" }, at("2026-10-23T15:19:00.000Z")), false);
  assertEquals(callOutcomeMissing({ ...c, status: "completed", endedAt: "2026-10-21T15:20:00.000Z" }, at("2026-10-23T15:20:00.000Z")), true);
  assertEquals(callOutcomeMissing({ ...c, status: "completed", handoffId: "h1" }, at("2026-10-25T00:00:00.000Z")), false);
  assertEquals(callOutcomeMissing({ ...c, status: "no_show" }, at("2026-10-25T00:00:00.000Z")), false);
  assertEquals(callOutcomeMissing({ ...c, status: "cancelled" }, at("2026-10-25T00:00:00.000Z")), false);
  assertEquals(callOutcomeMissing({ ...c, status: "booked" }, at("2026-11-21T00:00:00.000Z")), false, "older than 30 days");
});

