/**
 * ILP — Legal Assistant LLM client (OpenAI-compatible).
 * Uses Deno-native fetch; no npm deps.
 */

import { OPENAI_API_KEY, OPENAI_MODEL } from "../config.ts";
import type { ChatMessage } from "../agents/types.ts";

const OPENAI_BASE_URL = "https://api.openai.com/v1";

export interface LlmOptions {
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
}

export async function complete(
  messages: ChatMessage[],
  options: LlmOptions = {},
): Promise<string> {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 1024,
      ...(options.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM request failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const content: string | undefined = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM response missing content");
  }
  return content;
}

/**
 * Single-shot completion with a system instruction, matching the IRP
 * `callLLMWithFallback` contract the agents expect. ILP has a single OpenAI
 * provider (no OpenRouter/Gemini/scraper fallback chain), so "fallback" here
 * is a thin adapter over `complete` that returns the same `{ content }` shape.
 */
export interface LlmRequest {
  prompt?: string;
  systemInstruction?: string;
  maxTokens?: number;
  temperature?: number;
  sessionId?: string;
}

export interface LlmResponse {
  content: string;
}

export async function callLLMWithFallback(
  request: LlmRequest,
): Promise<LlmResponse> {
  const messages: ChatMessage[] = [
    ...(request.systemInstruction
      ? [{ role: "system" as const, content: request.systemInstruction }]
      : []),
    { role: "user" as const, content: request.prompt ?? "" },
  ];

  const content = await complete(messages, {
    temperature: request.temperature,
    maxTokens: request.maxTokens,
  });

  return { content };
}