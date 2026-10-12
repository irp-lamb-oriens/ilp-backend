/**
 * Centralized context generator for all ILP chatbot agents.
 * Single source of truth for legal-intake fields, required/optional
 * classification, conversation summarization, and shared prompt templates.
 */

// ═══════════════════════════════════════════════════
//  FORM FIELD DEFINITIONS + REQUIRED/OPTIONAL
// ═══════════════════════════════════════════════════

export const FORM_FIELDS = [
  "name", "surname", "email", "phone",
  "clientCountry", "jurisdiction",
  "legalMatter", "practiceArea",
  "legalUrgency", "legalNotes",
  "referredBy"
] as const;

export type FormFieldName = typeof FORM_FIELDS[number];

/** A single chat message in the rolling conversation window. */
export interface ChatMessage {
  role?: string;
  content?: string;
  extractedFields?: Record<string, unknown>;
}

/** The intake form state, keyed by field name. */
export type FormState = Record<string, unknown>;

/** Fields that the intake form validates as required — the chatbot MUST try harder for these. */
const REQUIRED_FIELDS: Set<FormFieldName> = new Set([
  "name", "surname",
  "clientCountry", "jurisdiction",
  "legalMatter", "practiceArea"
  // NOTE: "phone" was intentionally removed — it is now optional.
  // Clients may skip it; the chatbot still asks once but accepts "skip"/"idk".
]);

export function isRequired(field: FormFieldName): boolean {
  return REQUIRED_FIELDS.has(field);
}

// ═══════════════════════════════════════════════════
//  QUESTION PRIORITY ORDER
// ═══════════════════════════════════════════════════

export const QUESTION_PRIORITY_ORDER: FormFieldName[] = [
  // Identity first — collected via a single "What's your full name?" question
  // (see generateQuestionPriorityBlock + field-extraction-agent NAME RULES).
  "name", "surname", "email",
  "phone", "clientCountry", "jurisdiction",
  "legalMatter", "practiceArea", "legalUrgency",
  "legalNotes", "referredBy"
];


/**
 * Returns the first empty field in QUESTION PRIORITY ORDER.
 * Used by the router to determine which field to skip.
 */
export function getNextEmptyFieldByPriority(formState: FormState, skippedFields: string[] = []): string | null {
  for (const field of QUESTION_PRIORITY_ORDER) {
    if (skippedFields.includes(field)) continue;
    const val = formState[field];
    if (val === undefined || val === null || val === "" || (Array.isArray(val) && val.length === 0)) {
      return field;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════
//  CONVERSATION SUMMARIZER (rolling window)
// ═══════════════════════════════════════════════════

export function summarizeConversation(history: ChatMessage[], maxMessages: number = 20): string {
  const recent = history.slice(-maxMessages);
  const lines: string[] = [];

  for (const msg of recent) {
    const role = msg.role?.toUpperCase() || "UNKNOWN";
    const content = (msg.content || "").substring(0, 200);
    lines.push(`[${role}]: ${content}`);

    if (msg.extractedFields && Object.keys(msg.extractedFields).length > 0) {
      const fields = Object.entries(msg.extractedFields)
        .filter(([_, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ");
      if (fields) lines.push(`  [EXTRACTED]: ${fields}`);
    }
  }

  return lines.join("\n");
}

/**
 * Build a smart context window: condensed summary of older messages + full recent messages.
 * This prevents context loss in long conversations.
 */
export function buildConversationContext(history: ChatMessage[], recentCount: number = 6): { summary: string; recentMessages: ChatMessage[] } {
  if (history.length <= recentCount) {
    return { summary: "", recentMessages: history };
  }

  const olderMessages = history.slice(0, -recentCount);
  const recentMessages = history.slice(-recentCount);

  // Condensed summary of older messages — key facts only
  const summaryLines: string[] = [];
  for (const msg of olderMessages) {
    const role = msg.role === "user" ? "User" : "ILP assistant";
    const content = (msg.content || "").substring(0, 120);
    summaryLines.push(`${role}: ${content}`);
    if (msg.extractedFields && Object.keys(msg.extractedFields).length > 0) {
      const fields = Object.entries(msg.extractedFields)
        .filter(([_, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ");
      if (fields) summaryLines.push(`  → Extracted: ${fields}`);
    }
  }

  return {
    summary: `[CONVERSATION SUMMARY — ${olderMessages.length} earlier messages]\n${summaryLines.join("\n")}`,
    recentMessages
  };
}

// ═══════════════════════════════════════════════════
//  FORM STATE ANALYSIS
// ═══════════════════════════════════════════════════

export function analyzeFormState(formState: FormState, skippedFields: string[] = []): { filled: string[]; empty: string[]; skipped: string[] } {
  const filled: string[] = [];
  const empty: string[] = [];
  const skipped: string[] = [];

  for (const field of FORM_FIELDS) {
    if (skippedFields.includes(field)) {
      skipped.push(field);
      continue;
    }
    const val = formState[field];
    if (val !== undefined && val !== null && val !== "" && !(Array.isArray(val) && val.length === 0)) {
      filled.push(field);
    } else {
      empty.push(field);
    }
  }

  return { filled, empty, skipped };
}

// ═══════════════════════════════════════════════════
//  SHARED PROMPT SECTIONS
// ═══════════════════════════════════════════════════

export function generateFormStateBlock(formState: FormState, skippedFields: string[] = []): string {
  const { filled, empty, skipped } = analyzeFormState(formState, skippedFields);

  // Annotate empty fields with (REQUIRED) or (optional)
  const emptyAnnotated = empty.map(f => {
    const req = REQUIRED_FIELDS.has(f as FormFieldName);
    return `${f}${req ? " ⚠️REQUIRED" : " (optional)"}`;
  });

  return `
CURRENT FORM STATE: ${JSON.stringify(formState)}
FIELDS ALREADY FILLED (${filled.length}): ${filled.join(", ") || "none"}
FIELDS STILL EMPTY (${empty.length}): ${emptyAnnotated.join(", ") || "none — all fields collected!"}
FIELDS SKIPPED BY USER (${skipped.length}): ${skipped.join(", ") || "none"} — DO NOT ask about these again!`;
}

export function generateFieldKnowledgeBlock(): string {
  return `
═══════════════════════════════════════════════════
  📋 FIELD KNOWLEDGE
═══════════════════════════════════════════════════

LEGAL MATTER (legalMatter):
  Options: "residency", "real-estate", "corporate", "immigration", "tax", "family", "other"
  INFERENCE: "DIMEX"/"residency renewal" → "residency". "buying property"/"SRL" → "real-estate"/"corporate".

PRACTICE AREA (practiceArea):
  Options: "immigration", "real-estate", "corporate", "tax", "family", "estate", "other"

JURISDICTION (jurisdiction):
  Options: "Costa Rica", "Panama", "Mexico", "other"
  INFERENCE: "CR"→"Costa Rica", "PA"→"Panama", "MX"→"Mexico".

LEGAL URGENCY (legalUrgency):
  Options: "low", "medium", "high", "urgent"

REFERRAL (referredBy): How the client heard about ILP.
PHONE: Store EXACTLY as typed.
COUNTRIES: CR→Costa Rica, US→United States, PA→Panama, MX→Mexico, CA→Canada.`;
}

export function generateNeverReaskBlock(): string {
  return `
⛔ ABSOLUTE RULES:
1. NEVER re-ask a FILLED field.
2. NEVER re-ask a SKIPPED field.
3. NEVER repeat the same question the user already answered, even if the answer was informal.`;
}

export function generateQuestionPriorityBlock(): string {
  return `
QUESTION PRIORITY (ask the FIRST one that is in FIELDS STILL EMPTY):
Be specific. Always name the exact piece of info you need.

1. name (and surname) → "What's your full name, including your surname? (e.g. *John Smith* or *María José Pérez González*)"
   ⚠️ ECHO-CONFIRMATION RULE: After the user answers a full-name question, your VERY NEXT reply MUST start with a one-line confirmation in this exact format:
        "Got it — first name **<NAME>**, surname **<SURNAME>**. Correct? (If not, just tell me how you'd like it split.)"
   …and THEN continue with the next question. This gives the user a chance to fix mis-splits like compound first names ("María José") or multi-token surnames ("de la Rosa"). If they correct it, update both fields.
   Treat the answer to this question as filling BOTH the "name" and "surname" fields — do NOT also ask "what's your name?" or "what's your last name?" separately.
2. email → "What's your email?"
3. phone → "What's the best phone number to reach you?"
4. clientCountry → "Which country are you currently based in?"
5. jurisdiction → "Which country does your legal matter concern? (Costa Rica, Panama, or Mexico)"
6. legalMatter → "What kind of legal matter do you need help with? (residency, real estate, corporate, immigration, tax, family, or other)"
7. practiceArea → "Which practice area does this fall under?"
8. legalUrgency → "How urgent is this? (low, medium, high, or urgent)" (optional — accept "idk" and move on)
9. legalNotes → "Anything else you'd like to note about your matter?" (optional)
10. referredBy → "How did you hear about ILP?"

REQUIRED vs OPTIONAL:
- ⚠️REQUIRED fields: Try up to 2 times. If user still can't answer, skip gracefully.
- (optional) fields: Accept "idk" immediately and move on.

🌎 COLLOQUIAL NAMES: Accept slang — "CR"→"Costa Rica", "PA"→"Panama", "MX"→"Mexico". Don't question valid answers.`;
}


// ═══════════════════════════════════════════════════
//  FULL CONTEXT GENERATOR — Used by all agents
// ═══════════════════════════════════════════════════

export function generateSharedContext(formState: FormState, skippedFields: string[] = []): string {
  return [
    generateFormStateBlock(formState, skippedFields),
    generateNeverReaskBlock(),
    generateFieldKnowledgeBlock(),
    generateQuestionPriorityBlock()
  ].join("\n");
}