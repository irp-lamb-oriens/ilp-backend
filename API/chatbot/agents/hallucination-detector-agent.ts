/**
 * ILP — Legal Assistant hallucination detector.
 * Runs AFTER the ConversationalAgent produces its response. Cross-checks the
 * response against the verified fact-set (availability + scheduler results) to
 * detect claims the agent made that did NOT correspond to any real action.
 */

import log from "../../../helper/log.ts";
import { callLLMWithFallback } from "../intelligence/llm.ts";
import { extractJSONFromLLMResponse } from "../utils/llm-json-parser.ts";
import type {
  HallucinationDetectorAgentResponse,
  ChatbotGroundTruth,
} from "./types.ts";

export async function executeHallucinationDetectorAgent(
  agentResponse: string,
  groundTruth: ChatbotGroundTruth,
  userMessage: string,
): Promise<HallucinationDetectorAgentResponse> {
  log("[HALLUCINATION-DETECTOR] Analyzing response for hallucinations");

  const factSet = buildFactSet(groundTruth);

  const systemInstruction = `You are a hallucination detection auditor for an AI agent system.
Your job is to compare what the AI agent ACTUALLY DID (ground truth) against what the agent CLAIMED to have done in its response.

A hallucination occurs when the agent:
- Claims a meeting was scheduled when it was not
- Claims to have sent a notification, email, or alert that was NOT dispatched
- States an outcome as confirmed when it is uncertain or failed
- Claims to have escalated, forwarded, registered, or logged something that did not happen

A hallucination does NOT include:
- Asking clarifying questions
- Summarizing what a consultation contains
- Describing system capabilities
- Saying what CAN be done (future tense)
- Referencing actual confirmed events from the ground truth

Respond ONLY with valid JSON. No markdown, no explanation outside JSON.`;

  const prompt = `
## GROUND TRUTH (what actually happened this turn)
${factSet}

## USER MESSAGE (what the user asked)
${userMessage.slice(0, 1000)}

## AGENT RESPONSE (what the agent said to the user)
${agentResponse.slice(0, 3000)}

## TASK
Analyze the agent's response against the ground truth. Identify any claims the agent made that are NOT supported by the ground truth.

Respond with this exact JSON:
{
  "hallucinationsDetected": boolean,
  "severity": "none" | "low" | "medium" | "high",
  "detectedPatterns": [
    // Each string describes a specific hallucination found. Empty array if none.
  ],
  "verbatimClaims": [
    // Exact quotes from the agent response that are hallucinated. Empty if none.
  ],
  "reasoning": "1-2 sentence explanation of your analysis"
}`;

  try {
    const llmResponse = await callLLMWithFallback({
      systemInstruction,
      prompt,
      temperature: 0.1,
      maxTokens: 512,
    });

    const cleaned = extractJSONFromLLMResponse(llmResponse.content);
    const parsed = JSON.parse(cleaned) as {
      hallucinationsDetected?: boolean;
      severity?: string;
      detectedPatterns?: unknown;
      verbatimClaims?: unknown;
      reasoning?: string;
    };

    const result: HallucinationDetectorAgentResponse = {
      hallucinationsDetected: parsed.hallucinationsDetected === true,
      severity: (parsed.severity as HallucinationDetectorAgentResponse["severity"]) ?? "none",
      detectedPatterns: Array.isArray(parsed.detectedPatterns)
        ? (parsed.detectedPatterns as string[])
        : [],
      verbatimClaims: Array.isArray(parsed.verbatimClaims)
        ? (parsed.verbatimClaims as string[])
        : [],
      reasoning: parsed.reasoning ?? "",
    };

    if (result.hallucinationsDetected) {
      log(`[HALLUCINATION-DETECTOR] Hallucination detected! Severity: ${result.severity}`);
      for (const p of result.detectedPatterns) {
        log(`[HALLUCINATION-DETECTOR]   → ${p}`);
      }
    } else {
      log(`[HALLUCINATION-DETECTOR] No hallucinations detected`);
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[HALLUCINATION-DETECTOR] Error: ${message} — returning safe default`);
    return {
      hallucinationsDetected: false,
      severity: "none",
      detectedPatterns: [],
      verbatimClaims: [],
      reasoning: "Detection failed due to an internal error.",
    };
  }
}

function buildFactSet(store: ChatbotGroundTruth): string {
  const lines: string[] = [];

  const sched = store.scheduler;
  if (sched) {
    lines.push(`MEETING_SCHEDULED: ${sched.schedulerResult === "success"}`);
    lines.push(`SCHEDULER_RESULT: ${sched.schedulerResult}`);
    if (sched.createdEvent) {
      lines.push(`MEETING_EVENT_SUMMARY: ${sched.createdEvent.summary}`);
      lines.push(`MEETING_START: ${sched.createdEvent.start}`);
    }
  } else {
    lines.push(`MEETING_SCHEDULED: false (scheduler agent did not run)`);
  }

  const avail = store.availability;
  if (avail) {
    lines.push(`AVAILABILITY_REQUESTED: ${avail.availabilityRequested}`);
    lines.push(`AVAILABLE_SLOT_COUNT: ${avail.NON_TAKEN_MEETING_TIME_RANGES.length}`);
  } else {
    lines.push(`AVAILABILITY_REQUESTED: false (availability agent did not run)`);
  }

  return lines.join("\n");
}