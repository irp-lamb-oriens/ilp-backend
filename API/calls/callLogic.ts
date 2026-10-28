/**
 * API/calls/callLogic.ts — pure rules for the call itself (P3).
 * ──────────────────────────────────────────────────────────────────────────
 * No Firestore, no network, no Deno APIs: everything here is unit-tested in
 * test/callLogic_test.ts. The routes (callsRouter.ts), the booking functions
 * (clientStatus/memberHome.ts) and the reminder job (jobs/callReminders.ts)
 * call these.
 *
 * Each lawyer's weekly windows are wall-clock times in the lawyer's own time
 * zone (availability.timezone, IANA). Spain, Portugal and parts of Mexico
 * change clocks, so conversions go through Intl per instant, never a fixed
 * offset. Costa Rica (UTC-6, no daylight saving) stays the default for older
 * availability documents.
 */

import { COUNTRIES, COUNTRY_CODES, type Consultation, type LawyerAvailability, type WeeklyWindow } from "../../schemas/contracts.ts";

export const CR_TZ = "America/Costa_Rica" as const;
export const CR_OFFSET_MIN = 6 * 60;

// ─── Time zones ────────────────────────────────────────────────────────────

/** True when `tz` is an IANA zone this runtime knows. */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsIn(tz: string, t: number) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(t))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return o;
}

/** Minutes the zone is ahead of UTC at instant `t` (Costa Rica: -360; Madrid in summer: 120). */
export function tzOffsetMin(tz: string, t: number): number {
  const p = partsIn(tz, t);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(t / 1000) * 1000) / MIN);
}

/**
 * Plain name of a zone: "Costa Rica time", "Canary Islands time" (from the
 * country table), else the IANA city ("New York time").
 */
export function zoneLabel(tz: string): string {
  for (const c of COUNTRY_CODES) {
    const z = COUNTRIES[c].timeZones.find((x) => x.id === tz);
    if (z) return COUNTRIES[c].timeZones.length === 1 ? `${COUNTRIES[c].name} time` : `${z.label} time`;
  }
  const city = tz.split("/").pop() ?? tz;
  return `${city.replace(/_/g, " ")} time`;
}

/** "YYYY-MM-DD" of the calendar day in `tz` that contains `t` (ms). */
export function dateKeyIn(tz: string, t: number): string {
  const p = partsIn(tz, t);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** UTC ms of the wall-clock time `minutes` after 00:00 on day `key` in `tz`. */
export function wallToUtc(tz: string, key: string, minutes = 0): number {
  const [y, m, d] = key.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d) + minutes * MIN;
  let t = naive - tzOffsetMin(tz, naive) * MIN;
  // A second pass settles the offset on days the clocks change.
  t = naive - tzOffsetMin(tz, t) * MIN;
  return t;
}
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Join opens this many minutes before the start. */
export const JOIN_OPENS_MIN = 10;
/** Join stays open this long after the booked end. */
export const JOIN_CLOSES_AFTER_END_MIN = 30;
/** Members may cancel or reschedule up to this many hours before the call. */
export const MEMBER_CHANGE_CUTOFF_HOURS = 24;
/** A lawyer can mark "member didn't join" after waiting this long. */
export const NO_SHOW_WAIT_MIN = 10;

// ─── Availability ──────────────────────────────────────────────────────────

export type AvailabilityRules = Pick<
  LawyerAvailability,
  "weekly" | "blackoutDates" | "minLeadHours" | "maxCallsPerDay"
> & { timezone?: string };

/**
 * Used until a lawyer saves their own settings: the hours booking offered
 * before availability existed (weekdays 8:00-12:00 and 13:00-17:00), in the
 * lawyer's time zone (their country's default; Costa Rica for older lawyers).
 */
export function defaultAvailability(providerId: string, now = new Date(), timezone: string = CR_TZ): LawyerAvailability {
  const weekly: WeeklyWindow[] = [];
  for (const day of [1, 2, 3, 4, 5] as const) {
    weekly.push({ day, start: "08:00", end: "12:00" }, { day, start: "13:00", end: "17:00" });
  }
  return {
    id: providerId,
    providerId,
    timezone: isTimeZone(timezone) ? timezone : CR_TZ,
    weekly,
    blackoutDates: [],
    minLeadHours: 18,
    maxCallsPerDay: 6,
    specialties: [],
    updatedAt: now.toISOString(),
  };
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Settings as saved: the contract fields plus an optional calendar to read busy times from. */
export type AvailabilityDoc = LawyerAvailability;

/**
 * Validate and normalise an availability body. Returns the record to store,
 * or a plain-language error for the settings form.
 */
export function normalizeAvailability(
  input: unknown,
  providerId: string,
  now = new Date(),
  defaultTimezone: string = CR_TZ,
): { value: AvailabilityDoc } | { error: string } {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (o.timezone !== undefined && o.timezone !== null && o.timezone !== "" && !isTimeZone(o.timezone)) {
    return { error: "Choose your time zone from the list." };
  }
  const timezone = isTimeZone(o.timezone) ? o.timezone : isTimeZone(defaultTimezone) ? defaultTimezone : CR_TZ;
  const rawWeekly = Array.isArray(o.weekly) ? o.weekly : [];
  if (rawWeekly.length > 28) return { error: "Too many time windows (28 at most)." };
  const weekly: WeeklyWindow[] = [];
  for (const w of rawWeekly) {
    const x = (w ?? {}) as Record<string, unknown>;
    const day = Number(x.day);
    const start = String(x.start ?? "");
    const end = String(x.end ?? "");
    if (!Number.isInteger(day) || day < 0 || day > 6) return { error: "Each window needs a day of the week." };
    if (!HHMM.test(start) || !HHMM.test(end)) return { error: "Times must look like 08:30." };
    if (toMinutes(start) >= toMinutes(end)) return { error: `A window on ${DAY_NAMES[day]} ends before it starts.` };
    weekly.push({ day: day as WeeklyWindow["day"], start, end });
  }
  weekly.sort((a, b) => a.day - b.day || toMinutes(a.start) - toMinutes(b.start));
  for (let i = 1; i < weekly.length; i++) {
    const a = weekly[i - 1];
    const b = weekly[i];
    if (a.day === b.day && toMinutes(b.start) < toMinutes(a.end)) {
      return { error: `Two windows overlap on ${DAY_NAMES[a.day]}.` };
    }
  }

  const blackout = Array.isArray(o.blackoutDates) ? o.blackoutDates : [];
  const blackoutDates = [...new Set(blackout.map(String).filter((d) => YMD.test(d) && !Number.isNaN(Date.parse(d))))]
    .sort()
    .slice(-366);

  const intIn = (v: unknown, lo: number, hi: number, dflt: number) => {
    if (v === undefined || v === null || v === "") return dflt;
    const n = Number(v);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : NaN;
  };
  const minLeadHours = intIn(o.minLeadHours, 0, 168, 18);
  if (Number.isNaN(minLeadHours)) return { error: "Notice must be between 0 and 168 hours." };
  const maxCallsPerDay = intIn(o.maxCallsPerDay, 1, 20, 6);
  if (Number.isNaN(maxCallsPerDay)) return { error: "Calls per day must be between 1 and 20." };

  const specialties = [...new Set(
    (Array.isArray(o.specialties) ? o.specialties : [])
      .map((s) => String(s).trim().toLowerCase().replace(/\s+/g, "_"))
      .filter((s) => /^[a-z_]{2,40}$/.test(s)),
  )].slice(0, 20);

  let calendarId: string | null = null;
  if (typeof o.calendarId === "string" && o.calendarId.trim()) {
    const c = o.calendarId.trim().toLowerCase();
    if (!EMAIL.test(c)) return { error: "The calendar must be an email address, like name@example.com." };
    calendarId = c;
  }

  return {
    value: {
      id: providerId,
      providerId,
      timezone,
      weekly,
      blackoutDates,
      minLeadHours,
      maxCallsPerDay,
      specialties,
      calendarId,
      updatedAt: now.toISOString(),
    },
  };
}

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ─── Costa Rica dates (older callers; new code uses dateKeyIn / wallToUtc) ──

/** "YYYY-MM-DD" of the Costa Rica calendar day containing `t` (ms). */
export function crDateKey(t: number): string {
  return new Date(t - CR_OFFSET_MIN * MIN).toISOString().slice(0, 10);
}

/** UTC ms of 00:00 Costa Rica time on a "YYYY-MM-DD" day. */
export function crMidnight(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d) + CR_OFFSET_MIN * MIN;
}

// ─── Slots ─────────────────────────────────────────────────────────────────

export interface SlotInput {
  now: Date;
  availability: AvailabilityRules;
  /** This lawyer's consultations that hold time (anything not cancelled). */
  booked: Array<Pick<Consultation, "scheduledAt"> & { durationMin?: number; status?: string }>;
  /** Busy intervals from the lawyer's Google Calendar, if they have one. */
  busy?: Array<{ start: string; end: string }>;
  /** Calendar days to look ahead (default 14). */
  days?: number;
  /** Call length in minutes (default 20). */
  lengthMin?: number;
}

const overlaps = (s1: number, e1: number, s2: number, e2: number) => s1 < e2 && s2 < e1;

/**
 * Bookable start times (ISO, UTC): the lawyer's weekly windows in the
 * lawyer's time zone (availability.timezone, default Costa Rica), minus
 * blackout dates, minus booked consultations, minus calendar busy times, no
 * sooner than minLeadHours from now, and no slots on a day that already holds
 * maxCallsPerDay calls.
 */
export function buildSlots(o: SlotInput): string[] {
  const len = o.lengthMin ?? 20;
  const days = o.days ?? 14;
  const a = o.availability;
  const tz = isTimeZone(a.timezone) ? a.timezone : CR_TZ;
  const nowMs = o.now.getTime();
  const earliest = nowMs + Math.max(0, a.minLeadHours ?? 0) * HOUR;
  const blackout = new Set(a.blackoutDates ?? []);

  const held = o.booked
    .filter((c) => c.status !== "cancelled")
    .map((c) => {
      const s = Date.parse(c.scheduledAt);
      return { s, e: s + (c.durationMin || len) * MIN, day: Number.isNaN(s) ? "" : dateKeyIn(tz, s) };
    })
    .filter((x) => !Number.isNaN(x.s));
  const busy = (o.busy ?? [])
    .map((b) => ({ s: Date.parse(b.start), e: Date.parse(b.end) }))
    .filter((b) => !Number.isNaN(b.s) && !Number.isNaN(b.e) && b.e > b.s);

  const perDay = new Map<string, number>();
  for (const h of held) perDay.set(h.day, (perDay.get(h.day) ?? 0) + 1);

  const out: string[] = [];
  const [fy, fm, fd] = dateKeyIn(tz, nowMs).split("-").map(Number);
  for (let i = 0; i < days; i++) {
    const cal = new Date(Date.UTC(fy, fm - 1, fd + i));
    const key = cal.toISOString().slice(0, 10);
    if (blackout.has(key)) continue;
    if ((perDay.get(key) ?? 0) >= Math.max(1, a.maxCallsPerDay ?? 6)) continue;
    const dow = cal.getUTCDay();
    const windows = (a.weekly ?? []).filter((w) => w.day === dow)
      .sort((x, y) => toMinutes(x.start) - toMinutes(y.start));
    for (const w of windows) {
      const wEnd = toMinutes(w.end);
      for (let m = toMinutes(w.start); m + len <= wEnd; m += len) {
        const s = wallToUtc(tz, key, m);
        const e = s + len * MIN;
        if (s < earliest) continue;
        if (held.some((h) => overlaps(s, e, h.s, h.e))) continue;
        if (busy.some((b) => overlaps(s, e, b.s, b.e))) continue;
        out.push(new Date(s).toISOString());
      }
    }
  }
  return [...new Set(out)].sort();
}

// ─── Routing ───────────────────────────────────────────────────────────────

/** Areas that mean the same thing for routing. */
const AREA_ALIASES: Record<string, string> = { property: "real_estate", realestate: "real_estate", company: "corporate" };
const normArea = (a: string) => {
  const k = a.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return AREA_ALIASES[k] ?? k;
};

export interface LawyerCandidate {
  providerId: string;
  specialties: string[];
  /** Countries the lawyer is licensed in (CountryCode). Empty or missing = Costa Rica (older profiles). */
  countries?: string[];
  /** Upcoming booked calls; the least loaded match wins. */
  load?: number;
}

/** Countries a candidate is licensed in; older profiles without any are Costa Rica lawyers. */
export const candidateCountries = (c: Pick<LawyerCandidate, "countries">): string[] =>
  c.countries?.length ? c.countries.map((x) => x.toUpperCase()) : ["CR"];

/**
 * The lawyer for a member with no assigned lawyer: the least-loaded lawyer
 * whose specialties include the matter's area, else the fallback
 * (DEFAULT_PROVIDER_ID). Ties break on providerId so the choice is stable.
 *
 * With `country`, only lawyers licensed in that country are considered: the
 * least-loaded specialty match, else the least-loaded lawyer licensed there,
 * else the fallback (the caller passes it only when it is licensed there),
 * else null: nobody can take the call yet.
 */
export function pickLawyer(
  area: string | null | undefined,
  candidates: LawyerCandidate[],
  fallback: string | null,
  country?: string | null,
): string | null {
  const byLoad = (x: LawyerCandidate, y: LawyerCandidate) => (x.load ?? 0) - (y.load ?? 0) || x.providerId.localeCompare(y.providerId);
  const pool = country
    ? candidates.filter((c) => c.providerId && candidateCountries(c).includes(country.toUpperCase()))
    : candidates;
  if (area) {
    const want = normArea(area);
    const matches = pool.filter((c) => c.providerId && c.specialties.some((s) => normArea(s) === want)).sort(byLoad);
    if (matches.length) return matches[0].providerId;
  }
  if (country) {
    const any = pool.filter((c) => c.providerId).sort(byLoad);
    if (any.length) return any[0].providerId;
  }
  return fallback || null;
}

// ─── Reminders ─────────────────────────────────────────────────────────────

export type ReminderKey = "24h" | "1h";
export const REMINDERS: Array<{ key: ReminderKey; beforeMin: number }> = [
  { key: "24h", beforeMin: 24 * 60 },
  { key: "1h", beforeMin: 60 },
];

/**
 * Which reminder (if any) to send now for a consultation, and which keys to
 * record in remindersSent. Rules:
 * - only booked calls that have not started;
 * - a key fires once (remindersSent);
 * - when both are due (a missed sweep, or a call booked less than an hour
 *   ahead) only the 1-hour reminder is sent and 24h is marked as skipped;
 * - a call booked inside the 24-hour window skips the 24h reminder (the
 *   booking confirmation already went out).
 */
export function reminderToSend(
  c: Pick<Consultation, "status" | "scheduledAt" | "remindersSent" | "createdAt">,
  now: Date,
): { send: ReminderKey | null; mark: ReminderKey[] } {
  const none = { send: null, mark: [] as ReminderKey[] };
  if (c.status !== "booked") return none;
  const start = Date.parse(c.scheduledAt);
  const t = now.getTime();
  if (Number.isNaN(start) || t >= start) return none;
  const sent = new Set(c.remindersSent ?? []);
  const due = REMINDERS.filter((r) => !sent.has(r.key) && t >= start - r.beforeMin * MIN).map((r) => r.key);
  if (!due.length) return none;
  if (due.includes("1h")) {
    return { send: "1h", mark: due };
  }
  // Only 24h is due here.
  const created = c.createdAt ? Date.parse(c.createdAt) : NaN;
  if (!Number.isNaN(created) && created >= start - 24 * HOUR) return { send: null, mark: ["24h"] };
  return { send: "24h", mark: ["24h"] };
}

// ─── Join, change, no-show ─────────────────────────────────────────────────

/**
 * REL: a call nobody wrapped up. Still booked or in progress a day after its
 * booked end (no completion, no no-show: minutes never charged), or completed
 * two days ago without a handoff (the member has no next step). Calls older
 * than 30 days are left alone. Pure.
 */
export function callOutcomeMissing(
  c: Pick<Consultation, "status" | "scheduledAt" | "durationMin" | "handoffId" | "endedAt">,
  now: Date,
): boolean {
  const start = Date.parse(c.scheduledAt);
  if (Number.isNaN(start)) return false;
  const end = start + (c.durationMin || 20) * MIN;
  const t = now.getTime();
  if (t - start > 30 * DAY) return false;
  if (c.status === "booked" || c.status === "in_progress") return t >= end + DAY;
  if (c.status === "completed" && !c.handoffId) {
    const ended = c.endedAt ? Date.parse(c.endedAt) : end;
    return t >= (Number.isNaN(ended) ? end : ended) + 2 * DAY;
  }
  return false;
}

/** Join buttons are active from 10 minutes before until 30 minutes after the booked end. */
export function joinOpen(c: Pick<Consultation, "scheduledAt" | "durationMin" | "status">, now: Date): boolean {
  if (c.status !== "booked" && c.status !== "in_progress") return false;
  const s = Date.parse(c.scheduledAt);
  if (Number.isNaN(s)) return false;
  const t = now.getTime();
  return t >= s - JOIN_OPENS_MIN * MIN && t <= s + ((c.durationMin || 20) + JOIN_CLOSES_AFTER_END_MIN) * MIN;
}

/** Members can cancel or reschedule a booked call up to 24 hours before it. Staff can at any time. */
export function canChange(
  c: Pick<Consultation, "scheduledAt" | "status">,
  now: Date,
  by: "member" | "staff",
): { ok: true } | { ok: false; reason: string } {
  if (c.status !== "booked") return { ok: false, reason: "Only a booked call can be changed." };
  if (by === "staff") return { ok: true };
  const s = Date.parse(c.scheduledAt);
  if (s - now.getTime() < MEMBER_CHANGE_CUTOFF_HOURS * HOUR) {
    return { ok: false, reason: "Calls can be changed up to 24 hours before they start. Message your team and they will help." };
  }
  return { ok: true };
}

/**
 * No-show policy: the lawyer marks "member didn't join" once they have waited
 * 10 minutes past the start. A no-show uses the call and its booked minutes
 * (the lawyer's time was held); the CSM can restore it.
 */
export function noShowCheck(
  c: Pick<Consultation, "scheduledAt" | "status">,
  now: Date,
): { ok: true } | { ok: false; reason: string } {
  if (c.status !== "booked" && c.status !== "in_progress") return { ok: false, reason: "This call is not open." };
  const s = Date.parse(c.scheduledAt);
  if (now.getTime() < s + NO_SHOW_WAIT_MIN * MIN) {
    return { ok: false, reason: `Wait until ${NO_SHOW_WAIT_MIN} minutes after the start before marking a no-show.` };
  }
  return { ok: true };
}

// ─── Google Calendar / Meet shapes ─────────────────────────────────────────

export interface CalendarAttachment {
  fileId?: string;
  fileUrl?: string;
  title?: string;
  mimeType?: string;
}

export interface CalendarEventShape {
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  attachments?: CalendarAttachment[];
  description?: string;
}

/** The Meet link on a calendar event. */
export function meetUrlOf(e: CalendarEventShape | null | undefined): string | null {
  if (!e) return null;
  if (e.hangoutLink) return e.hangoutLink;
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video" && p.uri);
  return video?.uri ?? null;
}

const GOOGLE_DOC = "application/vnd.google-apps.document";

/** Drive file id from an attachment (fileId, else parsed from the docs URL). */
export function attachmentFileId(a: CalendarAttachment): string | null {
  if (a.fileId) return a.fileId;
  const m = a.fileUrl?.match(/\/d\/([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : null;
}

/**
 * The document to read after a Meet call. Meet attaches "… - Transcript" when
 * transcription is on, and "Notes by Gemini" when note-taking is on. The
 * verbatim transcript wins; Gemini notes are the fallback.
 */
export function pickMeetDocument(attachments: CalendarAttachment[] | undefined): { fileId: string; kind: "transcript" | "notes"; title: string } | null {
  const docs = (attachments ?? []).filter((a) => (!a.mimeType || a.mimeType === GOOGLE_DOC) && attachmentFileId(a));
  const transcript = docs.find((a) => /transcript|transcripci/i.test(a.title ?? ""));
  if (transcript) return { fileId: attachmentFileId(transcript)!, kind: "transcript", title: transcript.title ?? "" };
  const notes = docs.find((a) => /gemini|notes|notas/i.test(a.title ?? ""));
  if (notes) return { fileId: attachmentFileId(notes)!, kind: "notes", title: notes.title ?? "" };
  return null;
}

/** Should the sweep try to fetch the Meet transcript for this call now? */
export function transcriptFetchDue(
  c: Pick<Consultation, "scheduledAt" | "durationMin" | "status" | "consent" | "transcript" | "calendarEventId" | "transcriptFetchAttempts">,
  now: Date,
  maxAttempts = 8,
): boolean {
  if (c.consent?.recording !== "granted") return false;
  if (!c.calendarEventId || c.transcript) return false;
  if (c.status === "cancelled" || c.status === "no_show") return false;
  if ((c.transcriptFetchAttempts ?? 0) >= maxAttempts) return false;
  const end = Date.parse(c.scheduledAt) + (c.durationMin || 20) * MIN;
  const t = now.getTime();
  // Meet needs a few minutes after the call to write the transcript doc.
  return t >= end + 10 * MIN && t <= end + DAY;
}
