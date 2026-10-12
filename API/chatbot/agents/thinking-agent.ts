import log from "../../../helper/log.ts";
import { callLLMWithFallback } from "../intelligence/llm.ts";
import { extractJSONFromLLMResponse } from "../utils/llm-json-parser.ts";
import { SCHEDULING_POLICIES } from "./scheduling-policy.ts";
import { generateSharedContext, analyzeFormState, getNextEmptyFieldByPriority } from "./agent-context.ts";
import type { ThinkingAgentResponse } from "./types.ts";
import type { FormState } from "./agent-context.ts";

// Core fields required before we proactively offer scheduling
const SCHEDULING_GATE_FIELDS = [
  "email", "jurisdiction", "practiceArea"
];

// Priority fields — once most of these are filled, we should schedule
const PRIORITY_FIELDS = [
  "phone", "surname", "clientCountry", "jurisdiction",
  "legalMatter", "practiceArea", "legalUrgency", "legalNotes", "referredBy"
];

function shouldProactivelySchedule(formState: FormState): boolean {
  // All gate fields must be filled
  const gateMet = SCHEDULING_GATE_FIELDS.every(f => {
    const v = formState[f];
    return v && String(v).trim() !== "";
  });
  // Count how many priority fields are filled
  const priorityFilled = PRIORITY_FIELDS.filter(f => {
    const v = formState[f];
    return v && String(v).trim() !== "" && !(Array.isArray(v) && v.length === 0);
  }).length;
  // Schedule when gate met AND at least 7 of 9 priority fields filled
  return gateMet && priorityFilled >= 7;
}

export async function runThinkingAgent(
  userMessage: string,
  conversationContext: string = "",
  sessionId?: string,
  formState?: FormState,
  skippedFields: string[] = [],
  evoPersonaHint: string = ""
): Promise<ThinkingAgentResponse> {
  log("[THINKING-AGENT] Analyzing message...");

  const sharedCtx = generateSharedContext(formState || {}, skippedFields);
  const { filled, empty } = analyzeFormState(formState || {}, skippedFields);
  const nextField = getNextEmptyFieldByPriority(formState || {}, skippedFields);

  const prompt = `You are the orchestrator brain of ILP's legal assistant.
Your job: analyze the user's message and decide what agents should do next.

${evoPersonaHint ? `\n[EVO PERSONA INSTRUCTION]: ${evoPersonaHint}\n` : ''}

${sharedCtx}

═══════════════════════════════════════════════════
  USER INTENT CLASSIFICATION
═══════════════════════════════════════════════════
Classify as ONE of:
- "answer" → User provided ANY usable data. Short/informal answers count!
- "answer_with_uncertainty" → Starts uncertain but CONTAINS data. "no sé, como una mansión" = answer_with_uncertainty.
- "skip" → Genuinely doesn't know, NO usable data. Pure "idk", "no sé", "pass", "hmmm".
- "frustration" → Clearly upset/annoyed. NOT just short answers!
- "off_topic" → Unrelated.
- "greeting" → Starting conversation.
- "correction" → Correcting prior answer.
- "scheduling_request" → Explicitly asks to book/schedule a call.

RULE: If message contains ANY extractable info → "answer", never frustration or skip.

If intent is "skip" or "frustration", set fieldToSkip to: "${nextField || "none"}".

═══════════════════════════════════════════════════
  SCHEDULING DECISIONS
═══════════════════════════════════════════════════
- needsAvailabilityCheck=true when: user asks about availability, OR user wants to schedule
- needsScheduling=true when: user picks a specific day, time, or option (e.g. "let's do tuesday", "the first one", "wednesday"), or when the agent is about to setup the call from the last message

SCHEDULING POLICIES:
- ${SCHEDULING_POLICIES.join("\n- ")}

Return ONLY JSON:
{
  "decision": "brief analysis",
  "userIntent": "answer|skip|frustration|greeting|correction|off_topic|scheduling_request",
  "fieldToSkip": "fieldName or null",
  "responseIntent": "the ONE thing to achieve in the reply",
  "needsAvailabilityCheck": boolean,
  "needsScheduling": boolean
}`;

  const llmRes = await callLLMWithFallback({
    prompt: `User Message: "${userMessage}"\n\nConversation:\n${conversationContext}\n\nFILLED: ${filled.join(", ")}\nEMPTY: ${empty.join(", ")}\nCURRENTLY ASKING ABOUT: ${nextField || "all done"}\n\nDecision:`,
    systemInstruction: prompt,
    temperature: 0.1,
    sessionId
  });

  const cleaned = extractJSONFromLLMResponse(llmRes.content);
  const result = JSON.parse(cleaned);
  
  result.userIntent = result.userIntent || "answer";
  result.fieldToSkip = result.fieldToSkip || null;

  // ─── DETERMINISTIC PROACTIVE SCHEDULING ─────────────────
  // If we have enough info gathered, proactively check availability
  // even if the LLM didn't think to do it.
  if (!result.needsAvailabilityCheck && !result.needsScheduling) {
    if (shouldProactivelySchedule(formState || {})) {
      result.needsAvailabilityCheck = true;
      result.proactiveScheduling = true;
      log(`[THINKING-AGENT] 🗓️ Proactive scheduling triggered — gate fields met, ${empty.length} remaining.`);
    }
  }
  
  log(`[THINKING-AGENT] userIntent=${result.userIntent}, fieldToSkip=${result.fieldToSkip}, needsAvailability=${result.needsAvailabilityCheck}, decision=${result.decision?.substring(0, 100)}`);
  
  return result;
}