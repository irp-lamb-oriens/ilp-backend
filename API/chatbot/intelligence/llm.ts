/**
 * API/chatbot/intelligence/llm.ts
 * ──────────────────────────────────────────────────────────────────────────
 * ILP — Legal Assistant LLM client with a 3-tier fallback chain.
 *
 * Ported from IRP-funnel's `API/chatbot/intelligence/llm.ts`:
 *   1. OpenRouter (primary model, then fallback model, with 429 backoff)
 *   2. Gemini direct (generativelanguage API)
 *   3. Selenium Gemini web scraper (ultimate free fallback)
 *
 * Cost tracking writes to the `llm_costs` collection when a `sessionId` is
 * present. The public `callLLMWithFallback` keeps the `{ content }` shape the
 * agents already consume, so this is a drop-in upgrade of the previous
 * single-provider OpenAI adapter.
 */

import log from "../../../helper/log.ts";
import put from "../../../db/put.ts";
import type { ChatMessage } from "../agents/types.ts";
import { GeminiWebAdapter, type Message } from "./scraperLLM.ts";

// ── Provider config (inline from env vars) ────────────────────────────────
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") || "";
const OPENROUTER_MODEL_PRIMARY =
  Deno.env.get("OPENROUTER_MODEL_PRIMARY") || "google/gemini-2.5-flash";
const OPENROUTER_MODEL_FALLBACK =
  Deno.env.get("OPENROUTER_MODEL_FALLBACK") || "google/gemini-3-flash-preview";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const GEMINI_API_KEY =
  Deno.env.get("GEMINI_API_KEY") || Deno.env.get("GOOGLE_API_KEY") || "";
const GEMINI_MODEL = "gemini-flash-latest";

// Price per million tokens (gemini-flash): input $0.5, output $3.0.
const PRICE_INPUT_PER_M = 0.5;
const PRICE_OUTPUT_PER_M = 3.0;

export interface LlmRequest {
  prompt?: string;
  systemInstruction?: string;
  messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
  sessionId?: string;
}

export interface LlmResponse {
  content: string;
  provider?: "openrouter" | "google" | "selenium_scraper";
  model?: string;
  tokensUsed?: number;
  costEstimate?: number;
  latencyMs?: number;
  usage?: { inputTokens: number; outputTokens: number };
}

interface CostRecord {
  timestamp: string;
  sessionId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

async function recordCostInFirestore(record: Omit<CostRecord, "timestamp">) {
  const fullRecord: CostRecord = {
    ...record,
    timestamp: new Date().toISOString(),
  };
  try {
    const recordId = `cost_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    await put("llm_costs", recordId, fullRecord as unknown as Record<string, unknown>);
    log(`[LLM-COST] Cost recorded: $${record.costUSD.toFixed(6)}`);
  } catch (err) {
    log(`[LLM-COST] ERROR recording cost: ${err instanceof Error ? err.message : err}`);
  }
}

function calculateCost(input: number, output: number): number {
  return (input / 1_000_000) * PRICE_INPUT_PER_M +
    (output / 1_000_000) * PRICE_OUTPUT_PER_M;
}

async function exponentialBackoff(
  retries: number,
  fn: () => Promise<LlmResponse>,
): Promise<LlmResponse> {
  let delay = 1000;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("429") || message.includes("rate-limit")) {
        log(`[LLM] Rate limit hit, retrying in ${delay / 1000}s (attempt ${i + 1}/${retries})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      } else {
        throw error;
      }
    }
  }
  throw new Error(`[LLM] Failed after ${retries} retries.`);
}

export async function callLLMWithFallback(request: LlmRequest): Promise<LlmResponse> {
  // 1. OpenRouter (primary → fallback model, with retries)
  if (OPENROUTER_API_KEY) {
    try {
      return await exponentialBackoff(3, async () => {
        try {
          return await callOpenRouter(request, OPENROUTER_MODEL_PRIMARY);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("429") || message.includes("rate-limit")) {
            log(`[LLM] OpenRouter primary rate-limited, trying fallback model...`);
            return await callOpenRouter(request, OPENROUTER_MODEL_FALLBACK);
          }
          throw error;
        }
      });
    } catch (openRouterError) {
      log(`[LLM] OpenRouter failed, trying Gemini direct: ${openRouterError}`);
    }
  }

  // 2. Gemini direct
  if (GEMINI_API_KEY) {
    try {
      return await callGeminiDirect(request);
    } catch (geminiError) {
      log(`[LLM] Gemini direct failed, falling back to web scraper: ${geminiError}`);
    }
  }

  // 3. Selenium web scraper
  log("[LLM] Using Gemini Web Scraper (no API keys or API failed)...");
  return await callGeminiScraper(request);
}

async function callOpenRouter(request: LlmRequest, model: string): Promise<LlmResponse> {
  const startTime = Date.now();
  const messages: Array<{ role: string; content: string }> = request.messages
    ? [...request.messages]
    : [
        ...(request.systemInstruction
          ? [{ role: "system" as const, content: request.systemInstruction }]
          : []),
        { role: "user" as const, content: request.prompt ?? "" },
      ];

  const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: request.maxTokens || 4096,
      temperature: request.temperature ?? 0.7,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${errorBody}`);
  }

  const result = await response.json();
  const latencyMs = Date.now() - startTime;
  const content = result.choices?.[0]?.message?.content || "";
  const inputTokens = result.usage?.prompt_tokens || 0;
  const outputTokens = result.usage?.completion_tokens || 0;
  const totalTokens = result.usage?.total_tokens || 0;
  const costUSD = calculateCost(inputTokens, outputTokens);

  log(`[LLM] OpenRouter responded (${model}): ${totalTokens} tokens, ${latencyMs}ms`);

  if (request.sessionId) {
    await recordCostInFirestore({
      sessionId: request.sessionId,
      model,
      provider: "openrouter",
      inputTokens,
      outputTokens,
      costUSD,
    });
  }

  return {
    content,
    provider: "openrouter",
    model,
    tokensUsed: totalTokens,
    costEstimate: costUSD,
    latencyMs,
    usage: { inputTokens, outputTokens },
  };
}

async function callGeminiDirect(request: LlmRequest): Promise<LlmResponse> {
  const startTime = Date.now();
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  let contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  if (request.messages) {
    const systemMsg = request.messages.find((m) => m.role === "system");
    const sysPrefix = systemMsg ? systemMsg.content + "\n\n" : "";
    const nonSystem = request.messages.filter((m) => m.role !== "system");
    let prefixApplied = false;
    contents = nonSystem.map((m) => {
      const role = m.role === "assistant" ? "model" : "user";
      let text = m.content;
      if (!prefixApplied && role === "user" && sysPrefix) {
        text = sysPrefix + text;
        prefixApplied = true;
      }
      return { role, parts: [{ text }] };
    });
    if (contents.length === 0) {
      contents = [{ role: "user", parts: [{ text: sysPrefix || " " }] }];
    }
  } else {
    contents = [{
      role: "user",
      parts: [{
        text: (request.systemInstruction ? request.systemInstruction + "\n\n" : "") +
          (request.prompt ?? ""),
      }],
    }];
  }

  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: request.maxTokens || 2048,
      temperature: request.temperature ?? 0.7,
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${errorText}`);
  }

  const result = await response.json();
  const latencyMs = Date.now() - startTime;
  const content = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const inputTokens = result.usageMetadata?.promptTokenCount || 0;
  const outputTokens = result.usageMetadata?.candidatesTokenCount || 0;
  const totalTokens = result.usageMetadata?.totalTokenCount || 0;
  const costUSD = calculateCost(inputTokens, outputTokens);

  log(`[LLM] Gemini direct responded: ${totalTokens} tokens, ${latencyMs}ms`);

  if (request.sessionId) {
    await recordCostInFirestore({
      sessionId: request.sessionId,
      model: GEMINI_MODEL,
      provider: "google",
      inputTokens,
      outputTokens,
      costUSD,
    });
  }

  return {
    content,
    provider: "google",
    model: GEMINI_MODEL,
    tokensUsed: totalTokens,
    costEstimate: costUSD,
    latencyMs,
    usage: { inputTokens, outputTokens },
  };
}

async function callGeminiScraper(request: LlmRequest): Promise<LlmResponse> {
  const startTime = Date.now();
  const adapter = new GeminiWebAdapter();

  const messages: Message[] = request.messages
    ? request.messages.map((m) => ({ role: m.role, content: m.content }))
    : [
        ...(request.systemInstruction
          ? [{ role: "system" as const, content: request.systemInstruction }]
          : []),
        { role: "user" as const, content: request.prompt ?? "" },
      ];

  try {
    const rawResult = await adapter.createCompletion({ messages });
    const content = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
    const latencyMs = Date.now() - startTime;

    log(`[LLM] Selenium Scraper responded in ${latencyMs}ms (Cost: $0.00)`);

    return {
      content,
      provider: "selenium_scraper",
      model: "gemini-web-ui",
      tokensUsed: 0,
      costEstimate: 0,
      latencyMs,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  } catch (error) {
    log(`[LLM] Selenium Scraper completely failed: ${error instanceof Error ? error.message : error}`);
    throw error;
  }
}

// ── Backward-compatible single-shot helper (kept for any direct importers) ──
export async function complete(
  messages: ChatMessage[],
  options: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const res = await callLLMWithFallback({
    messages,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
  });
  return res.content;
}