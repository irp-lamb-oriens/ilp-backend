import log from "../../../helper/log.ts";
import { callLLMWithFallback } from "../intelligence/llm.ts";
import { extractJSONFromLLMResponse } from "../utils/llm-json-parser.ts";
import { fetchBusySlots, isSlotAvailable } from "./calendar-helper.ts";
import {
  generateAvailableSlots,
  isSlotWithinWorkingHours,
  getEarliestBookableTime,
  formatSlotForDisplay,
  SCHEDULING_POLICIES
} from "./scheduling-policy.ts";
import type { AvailabilityAgentResponse } from "./types.ts";

interface AvailabilityIntent {
  type: "general_availability" | "slot_check" | "none";
  requestedSlot: { start: string; end: string } | null;
}

async function parseAvailabilityIntent(userMessage: string, sessionId?: string) {
  const prompt = `You are a calendar intent classifier.
Analyze: "${userMessage}"
Is the user asking for general availability, or checking a specific slot (e.g., "3pm tomorrow")?

Return JSON:
{
  "type": "general_availability" | "slot_check" | "none",
  "requestedSlot": { "start": "ISO", "end": "ISO" } | null
}`;
  const res = await callLLMWithFallback({ prompt, temperature: 0.1, sessionId });
  return JSON.parse(extractJSONFromLLMResponse(res.content));
}

export async function runAvailabilityAgent(userMessage: string, sessionId?: string, proactive: boolean = false): Promise<AvailabilityAgentResponse> {
  log(`[AVAILABILITY-AGENT] Checking availability... (proactive=${proactive})`);

  // If triggered proactively (by thinking agent), skip LLM classification and just fetch open slots
  const intent: AvailabilityIntent = proactive
    ? { type: "general_availability", requestedSlot: null }
    : await parseAvailabilityIntent(userMessage, sessionId);

  if (intent.type === "none") {
    return { availabilityRequested: false, NON_TAKEN_MEETING_TIME_RANGES: [], missingFields: [], collisionDetected: false };
  }

  const earliest = getEarliestBookableTime();
  const maxRange = new Date(earliest.getTime() + 14 * 24 * 60 * 60 * 1000);
  const busySlots = await fetchBusySlots(earliest.toISOString(), maxRange.toISOString());

  if (intent.type === "slot_check" && intent.requestedSlot) {
    const start = new Date(intent.requestedSlot.start);
    const end = new Date(intent.requestedSlot.end);
    const inHours = isSlotWithinWorkingHours(start, end);
    const free = inHours && isSlotAvailable(intent.requestedSlot.start, intent.requestedSlot.end, busySlots);

    return {
      availabilityRequested: true,
      NON_TAKEN_MEETING_TIME_RANGES: free ? [] : generateAvailableSlots(earliest.toISOString(), maxRange.toISOString(), busySlots),
      missingFields: [],
      collisionDetected: !free,
      slotConfirmedAvailable: free,
      schedulingPolicies: SCHEDULING_POLICIES
    };
  }

  const slots = generateAvailableSlots(earliest.toISOString(), maxRange.toISOString(), busySlots);
  return {
    availabilityRequested: true,
    NON_TAKEN_MEETING_TIME_RANGES: slots,
    formattedAvailableSlots: slots.map(formatSlotForDisplay),
    missingFields: [],
    collisionDetected: false,
    schedulingPolicies: SCHEDULING_POLICIES
  };
}