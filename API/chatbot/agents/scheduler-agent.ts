import log from "../../../helper/log.ts";
import { callLLMWithFallback } from "../intelligence/llm.ts";
import { extractJSONFromLLMResponse } from "../utils/llm-json-parser.ts";
import { fetchBusySlots, createCalendarEvent } from "./calendar-helper.ts";
import {
  SCHEDULING_POLICIES,
  getEarliestBookableTime,
  generateAvailableSlots,
  isSlotWithinWorkingHours,
} from "./scheduling-policy.ts";
import type { SchedulerAgentResponse } from "./types.ts";

interface BookingExtraction {
  explicitBookingRequested: boolean;
  start: string | null;
  summary: string;
  participants: string[];
}

// ── Pick next valid slot from available slots list ─────────────────────────
function pickNextValidSlot(availableSlots: string[], afterISO?: string): string | null {
  const afterTime = afterISO ? new Date(afterISO).getTime() : 0;
  for (const slot of availableSlots) {
    const startISO = slot.split(" - ")[0];
    if (new Date(startISO).getTime() >= afterTime) {
      return startISO;
    }
  }
  return null;
}

// ── Main Scheduler Agent ───────────────────────────────────────────────────
export async function runSchedulerAgent(
  userMessage: string,
  formContext: Record<string, unknown>,
  conversationHistory: string = "",
  sessionId?: string,
): Promise<SchedulerAgentResponse> {
  log("[SCHEDULER-AGENT] Checking booking intent...");

  let senderEmail = String(formContext.email || "");
  if (!senderEmail) {
    const emailMatch = userMessage.match(/[\w.-]+@[\w.-]+\.\w+/);
    if (emailMatch) senderEmail = emailMatch[0];
  }
  if (!senderEmail) senderEmail = "Unknown";

  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const todayStr = now.toISOString().split("T")[0];
  const tomorrowStr = tomorrow.toISOString().split("T")[0];

  const extractionPrompt = `You are a scheduling assistant. Extract event details from the user message.

CURRENT DATE/TIME: ${now.toISOString()} (timezone: America/Costa_Rica, UTC-6)
TODAY's date: ${todayStr}
TOMORROW's date: ${tomorrowStr}

User message: "${userMessage}"
Conversation context: ${conversationHistory}
Sender email: ${senderEmail}

SCHEDULING POLICIES:
- ${SCHEDULING_POLICIES.join("\n- ")}

CRITICAL INSTRUCTIONS:
- "tomorrow" = ${tomorrowStr}
- "today" = ${todayStr}
- "tomorrow at 3 PM" = "${tomorrowStr}T15:00:00-06:00"
- "tomorrow at 10 AM" = "${tomorrowStr}T10:00:00-06:00"
- Always resolve relative dates to ABSOLUTE ISO dates with -06:00 offset.
- If the user mentions a time for a call, the "start" field MUST be a valid ISO 8601 string, NEVER null.
- Set explicitBookingRequested to true if the user mentions any time/date for a call or meeting.

Return ONLY valid JSON:
{
  "explicitBookingRequested": boolean,
  "start": "YYYY-MM-DDTHH:MM:SS-06:00 or null",
  "summary": "string",
  "participants": ["email"]
}`;

  const res = await callLLMWithFallback({ prompt: extractionPrompt, temperature: 0.1, sessionId });
  const cleaned = extractJSONFromLLMResponse(res.content);
  log(`[SCHEDULER-AGENT] LLM extraction raw: ${cleaned}`);
  const parsed = JSON.parse(cleaned) as BookingExtraction;
  log(`[SCHEDULER-AGENT] Parsed: explicitBookingRequested=${parsed.explicitBookingRequested}, start=${parsed.start}, summary=${parsed.summary}`);

  if (!parsed.explicitBookingRequested || !parsed.start) {
    log(`[SCHEDULER-AGENT] No valid booking — returning not_requested`);
    return {
      canSchedule: false,
      calendarAction: "none",
      eventPayload: null,
      schedulerResult: "not_requested",
      schedulerMessage: "No valid booking request.",
    };
  }

  // ── Attempt booking with retry on policy violation ───────────────────
  const MAX_RETRIES = 2;
  let currentStart = parsed.start;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    log(`[SCHEDULER-AGENT] Booking attempt ${attempt + 1} for slot: ${currentStart}`);

    try {
      const startDate = new Date(currentStart);
      const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);

      // Working-hours guard (Mon-Thu, 9-4, 48h grace).
      if (!isSlotWithinWorkingHours(startDate, endDate)) {
        const earliest = getEarliestBookableTime();
        const rangeEnd = new Date(earliest.getTime() + 14 * 24 * 60 * 60 * 1000);
        const busySlots = await fetchBusySlots(earliest.toISOString(), rangeEnd.toISOString());
        const availableSlots = generateAvailableSlots(earliest.toISOString(), rangeEnd.toISOString(), busySlots);
        const nextSlot = pickNextValidSlot(availableSlots, earliest.toISOString());
        if (nextSlot) {
          log(`[SCHEDULER-AGENT] Outside hours — auto-correcting to next slot: ${nextSlot}`);
          currentStart = nextSlot;
          continue;
        }
        return {
          canSchedule: false,
          calendarAction: "none",
          eventPayload: parsed,
          schedulerResult: "policy_violation",
          schedulerMessage: "Requested time is outside working hours.",
        };
      }

      // Busy-window guard.
      const busySlots = await fetchBusySlots(
        new Date(startDate.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        new Date(endDate.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      );
      const conflicts = busySlots.some((b: { start: string; end: string }) => {
        const bs = new Date(b.start).getTime();
        const be = new Date(b.end).getTime();
        return startDate.getTime() < be && endDate.getTime() > bs;
      });
      if (conflicts) {
        const earliest = getEarliestBookableTime();
        const rangeEnd = new Date(earliest.getTime() + 14 * 24 * 60 * 60 * 1000);
        const availableSlots = generateAvailableSlots(earliest.toISOString(), rangeEnd.toISOString(), busySlots);
        const nextSlot = pickNextValidSlot(availableSlots, currentStart);
        if (nextSlot) {
          log(`[SCHEDULER-AGENT] Slot taken — auto-correcting to next slot: ${nextSlot}`);
          currentStart = nextSlot;
          continue;
        }
        return {
          canSchedule: false,
          calendarAction: "none",
          eventPayload: parsed,
          schedulerResult: "policy_violation",
          schedulerMessage: "This slot is already taken.",
        };
      }

      const fullName = `${String(formContext.name || "Unknown")} ${String(formContext.surname || "")}`.trim();
      const event = await createCalendarEvent({
        summary: `Consultation with ${fullName}`,
        description: parsed.summary || "Legal consultation",
        start: currentStart,
        end: endDate.toISOString(),
        participants: [senderEmail],
      });

      const htmlLink: string = event.htmlLink || "";
      const hangoutLink: string = event.hangoutLink || event.conferenceData?.entryPoints?.[0]?.uri || "";

      return {
        canSchedule: true,
        calendarAction: "create_event",
        eventPayload: parsed,
        schedulerResult: "success",
        schedulerMessage: "Call scheduled successfully.",
        createdEvent: {
          id: event.id || "direct-booking",
          htmlLink,
          hangoutLink,
          summary: `Consultation with ${fullName}`,
          start: currentStart,
          end: endDate.toISOString(),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[SCHEDULER-AGENT] Error during booking attempt ${attempt + 1}: ${message}`);
      if (attempt === MAX_RETRIES - 1) {
        return {
          canSchedule: false,
          calendarAction: "none",
          eventPayload: parsed,
          schedulerResult: "failure",
          schedulerMessage: message,
        };
      }
    }
  }

  return {
    canSchedule: false,
    calendarAction: "none",
    eventPayload: parsed,
    schedulerResult: "failure",
    schedulerMessage: "All booking attempts failed.",
  };
}