/**
 * API/dashboard/extractClientFieldsServer.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Server-side client-field extraction: transcript → structured legal-intake
 * JSON. Runs through the shared 3-tier LLM fallback chain.
 */

import { callLLMWithFallback } from "../chatbot/intelligence/llm.ts";
import { extractJSONFromLLMResponse } from "../chatbot/utils/llm-json-parser.ts";

export interface ExtractedClientFields {
  name?: string;
  surname?: string;
  email?: string;
  phone?: string;
  legalArea?: string;
  legalMatter?: string;
  jurisdiction?: string;
  documents?: string[];
  notes?: string;
}

const SYSTEM_PROMPT = `You extract structured legal-intake fields from a consultation transcript.
Return ONLY a JSON object with these optional keys (omit empty ones):
name, surname, email, phone, legalArea, legalMatter, jurisdiction, documents (string array), notes.
legalArea must be one of: immigration, corporate, real_estate, notary, other.
legalMatter must be one of: residency_visa, business, property, family_estate, other.
Do not invent values. Use null or omit when absent.`;

export async function extractClientFieldsServer(
  transcript: string,
): Promise<ExtractedClientFields> {
  const res = await callLLMWithFallback({
    systemInstruction: SYSTEM_PROMPT,
    prompt: transcript,
    temperature: 0.2,
    maxTokens: 1024,
  });

  const raw = extractJSONFromLLMResponse(res.content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as ExtractedClientFields;
}