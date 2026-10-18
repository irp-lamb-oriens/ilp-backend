/**
 * summarization-agent.ts — LLM conversation/thread summaries for long threads.
 */

import log from "../../../helper/log.ts";
import { callLLMWithFallback } from "../intelligence/llm.ts";
import type { SummarizationAgentResponse } from "./types.ts";

export async function runSummarizationAgent(
  messages: Array<{ role: string; content: string }>,
  sessionId?: string,
): Promise<SummarizationAgentResponse> {
  if (messages.length === 0) return { summary: "", messageCount: 0 };

  const transcript = messages
    .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
    .join("\n");

  try {
    const res = await callLLMWithFallback({
      systemInstruction: "Summarize the following legal-intake conversation into a concise, factual summary (max 250 words) capturing the client's legal area, jurisdiction, matter, and any next steps agreed.",
      prompt: transcript,
      temperature: 0.2,
      sessionId,
    });
    return { summary: (res.content ?? "").trim(), messageCount: messages.length };
  } catch (err) {
    log(`[SUMMARIZATION-AGENT] error: ${err instanceof Error ? err.message : err}`);
    return { summary: "", messageCount: messages.length };
  }
}
