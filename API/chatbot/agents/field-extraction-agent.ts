import log from "../../../helper/log.ts";
import { callLLMWithFallback } from "../intelligence/llm.ts";
import { summarizeConversation } from "./agent-context.ts";
import type { ChatMessage } from "./agent-context.ts";

// ═══════════════════════════════════════════════════
//  THE SCHEMA — ILP legal-services intake fields
// ═══════════════════════════════════════════════════

const FORM_SCHEMA = {
  name: "string",
  surname: "string",
  email: "string",
  phone: "string",
  clientCountry: "string",
  jurisdiction: "string (Costa Rica | Panama | Mexico | other)",
  legalMatter: "string (residency | real-estate | corporate | immigration | tax | family | other)",
  practiceArea: "string (immigration | real-estate | corporate | tax | family | estate | other)",
  legalUrgency: "string (low | medium | high | urgent)",
  legalNotes: "string",
  referredBy: "string",
  // ── Service-specific fields (additive — absent otherwise) ──
  serviceCategory: "string",
  serviceCategories: ["string"],
  realtyIntent: "string (rent | buy | not_sure)",
  realtyBudget: "string",
  realtyPropertyType: "string (apartment | condo | house | land)",
  realtyTimeline: "string (asap | 3m | 6m | exploring)",
  realtyNotes: "string",
  corporateEntityType: "string",
  corporateJurisdiction: "string",
  corporateNotes: "string",
  coachingFocus: "string (communication | business | daily_life | family | all)",
  coachingHouseholdSize: "string (1 | 2 | 3_plus)",
  coachingDestination: "string",
  coachingTimeline: "string (asap | 3m | 6m | exploring)",
  coachingNotes: "string",
  skippedFields: ["string (list of field names the user declined to answer or skipped)"],
  customFields: {
    "camelCaseKey": "any client-volunteered fact that doesn't belong to another schema field",
  },
};

export interface FieldUpdate {
  action: "create" | "edit";
  field: string;
  value: unknown;
}

export interface FieldExtractionResult {
  updates: FieldUpdate[];
  appliedFields: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════
//  PARSE — extract JSON between --- markers
// ═══════════════════════════════════════════════════

function parseTripleDashJSON(text: string): Record<string, unknown> | null {
  const dashMatch = text.match(/---\s*([\s\S]*?)\s*---/);
  if (dashMatch) {
    try { return JSON.parse(dashMatch[1].trim()); } catch { /* fall through */ }
  }

  const codeMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeMatch) {
    try { return JSON.parse(codeMatch[1].trim()); } catch { /* fall through */ }
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0].trim()); } catch { /* fall through */ }
  }

  return null;
}

// ═══════════════════════════════════════════════════
//  FILTER — only keep fields that are in our schema
// ═══════════════════════════════════════════════════

const VALID_KEYS = new Set(Object.keys(FORM_SCHEMA));

const NAME_PLACEHOLDERS = new Set([
  "unknown", "n/a", "na", "none", "anonymous", "user", "client",
  "first name", "last name", "full name", "your name", "my name",
  "test", "asdf", "xxx", "undefined", "null",
]);

function isNamePlaceholder(s: unknown): boolean {
  if (typeof s !== "string") return false;
  return NAME_PLACEHOLDERS.has(s.trim().toLowerCase());
}

const SENTINEL_STRING_VALUES = new Set(["undefined", "null"]);

function isSentinelString(s: unknown): boolean {
  if (typeof s !== "string") return false;
  return SENTINEL_STRING_VALUES.has(s.trim().toLowerCase());
}

function filterToSchema(extracted: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(extracted)) {
    if (!VALID_KEYS.has(key)) {
      log(`[FIELD-EXTRACTION] Ignoring unknown key: "${key}"`);
      continue;
    }
    if (val === null || val === undefined || val === "") continue;
    if (typeof val === "string" && val.trim() === "") continue;
    if (Array.isArray(val) && val.length === 0) continue;
    if (isSentinelString(val)) {
      log(`[FIELD-EXTRACTION] Dropping sentinel ${key}="${val}" (not a real value)`);
      continue;
    }
    if ((key === "name" || key === "surname") && isNamePlaceholder(val)) {
      log(`[FIELD-EXTRACTION] Dropping placeholder ${key}="${val}" (honesty > guess)`);
      continue;
    }
    filtered[key] = val;
  }
  return filtered;
}

/**
 * Deterministic safety net for full-name extraction: if the LLM dumped a full
 * name into `surname` and left `name` empty, split it ourselves.
 */
function applyFullNameSplitSafetyNet(
  extracted: Record<string, unknown>,
  currentState: Record<string, unknown>,
): void {
  const extractedName = String(extracted.name ?? "").trim();
  const currentName = String(currentState.name ?? "").trim();
  const extractedSurname = String(extracted.surname ?? "").trim();
  if (extractedName || currentName) return;
  if (!extractedSurname.includes(" ")) return;
  const tokens = extractedSurname.split(/\s+/);
  const newName = tokens[0];
  const newSurname = tokens.slice(1).join(" ");
  log(`[FIELD-EXTRACTION] Full-name safety-net split applied (${tokens.length} parts)`);
  extracted.name = newName;
  extracted.surname = newSurname;
}

// ═══════════════════════════════════════════════════
//  MAIN EXTRACTION AGENT
// ═══════════════════════════════════════════════════

export async function runFieldExtractionAgent(
  userMessage: string,
  conversationHistory: ChatMessage[],
  currentFormState: Record<string, unknown>,
  sessionId?: string,
): Promise<FieldExtractionResult> {
  log("[FIELD-EXTRACTION] Extracting fields from user message...");

  const conversationSummary = summarizeConversation(conversationHistory, 10);

  const prompt = `You are a data extraction agent. Extract relevant facts from the user's latest message based on the conversation context.

CURRENT STATE (already known):
${JSON.stringify(currentFormState, null, 2)}

TARGET SCHEMA:
${JSON.stringify(FORM_SCHEMA, null, 2)}

CONVERSATION CONTEXT:
${conversationSummary}

USER'S LATEST MESSAGE: "${userMessage}"

OBJECTIVES:
1. Extract any facts, values, or entities provided in the latest message that fit the target schema.
2. If the user explicitly declines to answer, skips a question, or says they don't know, add the field name they skipped to the "skippedFields" array.
3. ACCEPT FAKE NAMES: If the user provides an obviously fake or test answer (e.g., "prueba", "test", "asdf", "123") when asked for their name or surname, EXTRACT IT ANYWAY as the name/surname. Do not apply this fake-data rule to other fields.
4. Be loose and flexible. Map the user's intent to the closest schema field.
5. DO NOT repeat data already in the current state unless the user is explicitly correcting it.
6. If there is nothing new to extract, return an empty object {}.
7. RESOLVE RELATIVE REFERENCES: If the user says "same", "there too", "the capital", "also X", etc., resolve it to the actual value using conversation context. NEVER store "same", "there", "the capital", "also", "ditto" as literal field values.
8. NEGATIVE ANSWERS FOR ARRAY FIELDS: If user says "no", "none", "nope" when asked about an array field, extract the STRING "none" — NOT an empty array [].
9. CROSS-FIELD DETECTION: If the user's answer doesn't match the question that was asked but contains data for a DIFFERENT field, extract it for the correct field.
10. NAME RULES (very important — 'name' and 'surname' are two SEPARATE fields):
    - 'name'    = the user's FIRST / GIVEN name only.
    - 'surname' = the user's LAST / FAMILY name only.
    - When the user provides their FULL name in one message, split on the FIRST whitespace:
        first whitespace-delimited token → 'name', everything after → 'surname'.
    - If the user provides only ONE word with no space, put it in 'name'; leave 'surname' for a follow-up.
    - NEVER write the literal string "Unknown", "N/A", "anonymous", "user", or anything similar into 'name' or 'surname'. If you do not know, omit the field entirely.
11. CUSTOM FIELDS (open capture): If the client volunteers any fact that doesn't fit a known schema field, store it in the \`customFields\` object using a descriptive camelCase key. Merge with existing customFields rather than replacing.

Format your response strictly as JSON wrapped in triple dashes:
---
{ "fieldName": "extractedValue" }
---`;

  try {
    const res = await callLLMWithFallback({ prompt, temperature: 0.0, sessionId });
    const extracted = parseTripleDashJSON(res.content);

    if (!extracted || Object.keys(extracted).length === 0) {
      log("[FIELD-EXTRACTION] No fields extracted.");
      return { updates: [], appliedFields: {} };
    }

    const filtered = filterToSchema(extracted);
    applyFullNameSplitSafetyNet(filtered, currentFormState);

    const appliedFields: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(filtered)) {
      const existing = currentFormState[key];
      if (JSON.stringify(existing) === JSON.stringify(val)) continue;
      appliedFields[key] = val;
      log(`[FIELD-EXTRACTION] ${existing ? "edit" : "create"} "${key}" = ${JSON.stringify(val)}`);
    }

    const updates: FieldUpdate[] = Object.entries(appliedFields).map(([field, value]) => ({
      action: currentFormState[field] ? "edit" as const : "create" as const,
      field,
      value,
    }));

    log(`[FIELD-EXTRACTION] Final: ${updates.length} fields — ${JSON.stringify(appliedFields)}`);

    return { updates, appliedFields };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[FIELD-EXTRACTION] Error: ${message}`);
    return { updates: [], appliedFields: {} };
  }
}