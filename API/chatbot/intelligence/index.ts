/**
 * API/chatbot/intelligence/index.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Single point of access for the ILP chatbot's cognitive functions.
 *
 * Ported from IRP-funnel's `API/chatbot/intelligence/index.ts`. Re-exports the
 * LLM fallback chain and the JSON extraction helper so agents can import from
 * one place.
 */

import { callLLMWithFallback } from "./llm.ts";
import { extractJSONFromLLMResponse } from "../utils/llm-json-parser.ts";

export { callLLMWithFallback, extractJSONFromLLMResponse };
export { transcribeAudio } from "./transcription.ts";