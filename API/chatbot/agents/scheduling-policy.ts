/**
 * ┌──────────────────────────────────────────────────────────────┐
 * │  SCHEDULING POLICY — Single Source of Truth                   │
 * └──────────────────────────────────────────────────────────────┘
 */

export const SCHEDULING_POLICIES = [
  "Working hours policy (ALL TIMES must be in GMT-6/CST)",
  "Consultation calls are only available Monday–Thursday (no Fridays or weekends)",
  "Operating Hours: 9:00 AM – 4:00 PM GMT-6",
  "Grace period: Minimum 48 hours (2 working days) lead time required.",
  "Attorneys need this time to review the client's legal context and prepare advice.",
  "If the user specifies a different timezone, convert to GMT-6 (America/Costa_Rica).",
]

export const SCHEDULING_POLICY = {
  timezone: "America/Costa_Rica",
  utcOffsetHours: -6,
  label: "GMT-6 (Costa Rica, America/Costa_Rica — no DST)",
  schedule: "Monday–Thursday, 9 AM–4 PM",

  morningStartMin: 9 * 60,
  morningEndMin:   12 * 60,
  afternoonStartMin: 13 * 60,
  afternoonEndMin:   16 * 60,

  gracePeriodWorkingDays: 2, // 48 hours rule
  maxSlotsToPresent: 5,
  slotDurationMinutes: 30,

  // Mandatory gap BETWEEN consecutive calls. Calls must never be booked
  // back-to-back: the 30-min buffer gives the team time to enter the call's
  // details into the system before moving straight to quoting.
  interCallBufferMinutes: 30,
} as const;

// Buffer in ms — every booking/availability gate expands each busy block by
// this on both sides before testing overlap, so a 30-min call at 9:00–9:30
// blocks 9:30 (too close) but leaves 10:00 free (exactly 30 min later).
export const INTER_CALL_BUFFER_MS = SCHEDULING_POLICY.interCallBufferMinutes * 60 * 1000;

/**
 * Single source of truth for "does this slot collide with an existing call?".
 *
 * A slot conflicts when it overlaps a busy block OR sits within the inter-call
 * buffer of one. Used by every gate (generateAvailableSlots, bookConsultation's
 * conflict guard, calendar-helper.isSlotAvailable) so back-to-back bookings are
 * impossible no matter which flow (hero form, chatbot, staff CRM) does the write.
 */
export function conflictsWithBusy(
  slotStartMs: number,
  slotEndMs: number,
  busySlots: Array<{ start: string; end: string }>,
  bufferMs: number = INTER_CALL_BUFFER_MS,
): boolean {
  return busySlots.some((b) => {
    const bs = new Date(b.start).getTime() - bufferMs;
    const be = new Date(b.end).getTime() + bufferMs;
    return slotStartMs < be && slotEndMs > bs;
  });
}


export function toLocalCR(d: Date): { dayOfWeek: number; minutesFromMidnight: number } {
  const offsetMs = SCHEDULING_POLICY.utcOffsetHours * 60 * 60 * 1000;
  const localMs = d.getTime() + offsetMs;
  const localDate = new Date(localMs);
  return {
    dayOfWeek: localDate.getUTCDay(),
    minutesFromMidnight: localDate.getUTCHours() * 60 + localDate.getUTCMinutes(),
  };
}

export function isSlotWithinWorkingHours(slotStart: Date, slotEnd: Date): boolean {
  const { dayOfWeek, minutesFromMidnight: startMins } = toLocalCR(slotStart);
  const { minutesFromMidnight: endMins } = toLocalCR(slotEnd);

  if (dayOfWeek === 0 || dayOfWeek === 5 || dayOfWeek === 6) return false;

  const isMorning = startMins >= SCHEDULING_POLICY.morningStartMin && endMins <= SCHEDULING_POLICY.morningEndMin;
  const isAfternoon = startMins >= SCHEDULING_POLICY.afternoonStartMin && endMins <= SCHEDULING_POLICY.afternoonEndMin;

  return isMorning || isAfternoon;
}

export function getOutsideWorkingHoursReason(slotStart: Date, _slotEnd: Date): string {
  const { dayOfWeek } = toLocalCR(slotStart);
  const dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return `${dayNames[dayOfWeek]} is a weekend. Calls are Mon-Thu only.`;
  }
  if (dayOfWeek === 5) {
    return `Friday is not available for consultations. Calls are Mon-Thu only.`;
  }

  return `Requested time is outside operating hours (9 AM - 4 PM CST, with 12-1 PM lunch break).`;
}

export function getEarliestBookableTime(): Date {
  const crOffsetMs = SCHEDULING_POLICY.utcOffsetHours * 60 * 60 * 1000;
  const cursor = new Date(Date.now() + crOffsetMs);

  // Add 2 working days
  let daysToAdd = SCHEDULING_POLICY.gracePeriodWorkingDays;
  while (daysToAdd > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 5 && dow !== 6) daysToAdd--;
  }

  cursor.setUTCHours(9, 0, 0, 0); // Start at 9am
  return new Date(cursor.getTime() - crOffsetMs);
}

export function generateAvailableSlots(
  timeMin: string,
  timeMax: string,
  busySlots: Array<{ start: string; end: string }>,
  slotDurationMinutes: number = SCHEDULING_POLICY.slotDurationMinutes,
  intervalMinutes: number = 30,
  maxSlots: number = SCHEDULING_POLICY.maxSlotsToPresent
): string[] {
  const rangeStart = new Date(timeMin);
  const rangeEnd   = new Date(timeMax);
  const earliest   = getEarliestBookableTime();
  const effectiveStart = rangeStart < earliest ? earliest : rangeStart;

  // Collect ALL available slots, grouped by day
  const slotsByDay: Map<string, string[]> = new Map();
  let cursor = new Date(effectiveStart);

  while (cursor < rangeEnd) {
    const slotEnd = new Date(cursor.getTime() + slotDurationMinutes * 60_000);
    if (slotEnd > rangeEnd) break;

    if (isSlotWithinWorkingHours(cursor, slotEnd)) {
      // Enforce the inter-call buffer so presented slots are never back-to-back.
      const hasConflict = conflictsWithBusy(cursor.getTime(), slotEnd.getTime(), busySlots);

      if (!hasConflict) {

        const crOffsetMs = SCHEDULING_POLICY.utcOffsetHours * 60 * 60 * 1000;
        const fakeDate = new Date(cursor.getTime() + crOffsetMs);
        const dayKey = `${fakeDate.getUTCFullYear()}-${fakeDate.getUTCMonth()}-${fakeDate.getUTCDate()}`;

        if (!slotsByDay.has(dayKey)) slotsByDay.set(dayKey, []);
        slotsByDay.get(dayKey)!.push(`${cursor.toISOString()} - ${slotEnd.toISOString()}`);
      }
    }

    cursor = new Date(cursor.getTime() + intervalMinutes * 60_000);
  }

  // Pick 1 slot per day, alternating morning/afternoon for variety
  const result: string[] = [];
  let preferMorning = true;

  for (const [_, daySlots] of slotsByDay) {
    if (result.length >= maxSlots) break;

    // Try to pick from preferred time (morning vs afternoon for variety)
    const morningSlots = daySlots.filter(s => {
      const startISO = s.split(" - ")[0];
      const { minutesFromMidnight } = toLocalCR(new Date(startISO));
      return minutesFromMidnight < 12 * 60;
    });
    const afternoonSlots = daySlots.filter(s => {
      const startISO = s.split(" - ")[0];
      const { minutesFromMidnight } = toLocalCR(new Date(startISO));
      return minutesFromMidnight >= 13 * 60;
    });

    const preferred = preferMorning ? morningSlots : afternoonSlots;
    const fallback = preferMorning ? afternoonSlots : morningSlots;
    const pick = (preferred.length > 0 ? preferred : fallback)[0];

    if (pick) {
      result.push(pick);
      preferMorning = !preferMorning; // Alternate for next day
    }
  }

  return result;
}

export function formatSlotForDisplay(slot: string): string {
  const [startISO] = slot.split(" - ");
  const start = new Date(startISO);
  const { minutesFromMidnight: sMins, dayOfWeek } = toLocalCR(start);
  const dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  const crOffsetMs = SCHEDULING_POLICY.utcOffsetHours * 60 * 60 * 1000;
  const fakeDate = new Date(start.getTime() + crOffsetMs);

  const h = Math.floor(sMins / 60);
  const m = sMins % 60;
  const period = h < 12 ? "AM" : "PM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const timeStr = `${h12}${m > 0 ? `:${String(m).padStart(2,"0")}` : ""} ${period}`;

  return `${dayNames[dayOfWeek]}, ${monthNames[fakeDate.getUTCMonth()]} ${fakeDate.getUTCDate()} @ ${timeStr} GMT-6`;
}