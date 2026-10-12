import log from "../../../helper/log.ts";
import { callLLMWithFallback } from "../intelligence/llm.ts";
import { extractJSONFromLLMResponse } from "../utils/llm-json-parser.ts";
import { analyzeFormState, buildConversationContext, QUESTION_PRIORITY_ORDER } from "./agent-context.ts";
import type { ChatMessage, FormState, FormFieldName } from "./agent-context.ts";
import type { ConversationalAgentResponse, ThinkingAgentResponse, AvailabilityAgentResponse, SchedulerAgentResponse } from "./types.ts";
import { SCHEDULING_POLICIES } from "./scheduling-policy.ts";
import {
  getServiceConfig,
  evaluateCondition,
} from "../../consultations/serviceConfig/index.ts";

// ─── Canonical field options from the intake form (single source of truth) ───
const FIELD_OPTIONS_BLOCK = `
CANONICAL FIELD VALUES — use these exact codes when mapping user answers to fields:

legalMatter valid values:
  • "residency"    — residency / DIMEX / renewal / status
  • "real-estate"  — property purchase / sale / title / closing
  • "corporate"    — SRL / corporation / entity formation / compliance
  • "immigration"  — visa / entry / pathway
  • "tax"          — tax obligations / filings
  • "family"       — family law / estate
  • "other"        — anything else

practiceArea valid values:
  • "immigration", "real-estate", "corporate", "tax", "family", "estate", "other"

jurisdiction valid values:
  • "Costa Rica", "Panama", "Mexico", "other"

legalUrgency valid values:
  • "low", "medium", "high", "urgent"
`;

export async function executeConversationalAgent(
  _thinkingDecision: ThinkingAgentResponse,
  availability: AvailabilityAgentResponse | null,
  scheduler: SchedulerAgentResponse | null,
  conversationHistory: ChatMessage[] = [],
  sessionId?: string,
  formContext?: FormState,
  skippedFields: string[] = [],
  _preferredLanguage: string = 'en'
): Promise<ConversationalAgentResponse> {
  log("[CONVERSATIONAL-AGENT] Generating reply...");

  const { empty } = analyzeFormState(formContext || {}, skippedFields);
  const { summary, recentMessages } = buildConversationContext(conversationHistory, 20);

  // ── Build what we know / what we still need ──
  const knownFields = Object.entries(formContext || {})
    .filter(([_, v]) => v && String(v).trim() !== "" && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join("\n");

  // Split into priority vs nice-to-have so the LLM focuses correctly
  const PRIORITY_FIELDS = new Set([
    "phone", "surname", "clientCountry", "jurisdiction",
    "legalMatter", "practiceArea", "legalUrgency", "legalNotes", "referredBy"
  ]);
  const NICE_TO_HAVE = new Set(["email"]);

  // Sort empty fields based on QUESTION_PRIORITY_ORDER
  const sortedEmpty = [...empty].sort((a, b) => {
    const aIdx = QUESTION_PRIORITY_ORDER.indexOf(a as FormFieldName);
    const bIdx = QUESTION_PRIORITY_ORDER.indexOf(b as FormFieldName);
    return (aIdx !== -1 ? aIdx : 999) - (bIdx !== -1 ? bIdx : 999);
  });

  const priorityNeeded = sortedEmpty.filter(f => PRIORITY_FIELDS.has(f));
  const niceToHave = sortedEmpty.filter(f => NICE_TO_HAVE.has(f));

  let stillNeeded = priorityNeeded.length > 0
    ? `PRIORITY: ${priorityNeeded.join(", ")}${niceToHave.length > 0 ? `\n  NICE-TO-HAVE (ask only after priority fields are done): ${niceToHave.join(", ")}` : ""}`
    : niceToHave.length > 0
      ? `Only nice-to-have left: ${niceToHave.join(", ")} — consider moving to scheduling.`
      : "All fields collected! Time to schedule a consultation call.";

  // ── Service-aware intake (legal / immigration / realty / corporate) ─────
  // The legal intake has no idea about service-specific fields because they are
  // not part of the base FORM_FIELDS list. Resolve the selected service(s)
  // from the cumulative context and prepend the still-missing service-specific
  // fields so the bot asks them in priority order — without touching the
  // base question flow at all.
  const serviceCategories =
    Array.isArray(formContext?.serviceCategories) && formContext.serviceCategories.length > 0
      ? formContext.serviceCategories.map((s: unknown) => String(s))
      : [formContext?.serviceCategory].filter(Boolean).map(String);
  const serviceConfig = getServiceConfig(serviceCategories);
  const stateForConditions: FormState = formContext || {};
  // Fields that belong to the service intakes rather than the shared legal
  // intake. Identity ("name", etc.) and scheduling are handled by the base
  // flow, so they are intentionally absent from this set.
  const SERVICE_FIELD_IDS = new Set([
    "legalMatter", "legalCountry", "legalUrgency", "legalNotes",
    "realtyIntent", "realtyBudget", "realtyPropertyType", "realtyTimeline", "realtyNotes",
    "corporateEntityType", "corporateJurisdiction", "corporateNotes",
  ]);
  const missingServiceFields = serviceConfig.chatbotFields
    .filter((f) => SERVICE_FIELD_IDS.has(f.id))
    .filter((f) => evaluateCondition(f.showWhen, stateForConditions))
    .filter((f) => {
      const v = stateForConditions[f.id];
      return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    })
    .sort((a, b) => a.priority - b.priority);

   // Build a compact service-field options block so the LLM maps answers to the
   // exact canonical codes even though the base FIELD_OPTIONS_BLOCK doesn't
   // know about them.
   const serviceFieldOptionsBlock = serviceConfig.chatbotFields
     .filter((f) => SERVICE_FIELD_IDS.has(f.id) && f.options?.length)
     .map((f) => {
       const opts = (f.options || []).map((o) => `"${o.value}"`).join(" | ");
       return `${f.id}: ${opts}${f.showWhen ? ` (only when ${JSON.stringify(f.showWhen)})` : ""}`;
     })
     .join("\n");

   // Map each service-specific field to the service whose context it belongs
   // to, so the assistant can name the service (e.g. "for legal advice…") when
   // asking that question. Derived from the resolver's `serviceLabel` annotation.
   const serviceFieldContextBlock = serviceConfig.chatbotFields
     .filter((f) => SERVICE_FIELD_IDS.has(f.id) && f.serviceLabel)
     .map((f) => `${f.id}: ${f.serviceLabel}`)
     .join("\n");

  if (missingServiceFields.length > 0) {
    const serviceNeeded = `SERVICE PRIORITY: ${missingServiceFields.map((f) => f.id).join(", ")}`;
    stillNeeded =
      stillNeeded === "All fields collected! Time to schedule a consultation call."
        ? serviceNeeded
        : `${serviceNeeded}\n${stillNeeded}`;
  }

  // ── Scheduling context ──
  let schedulingCtx = "";
  if (scheduler?.schedulerResult === "success" && scheduler.createdEvent) {
    schedulingCtx = `\n🗓️ CALL JUST SCHEDULED SUCCESSFULLY!
  → Confirm the booking warmly. You MUST explicitly output the exact placeholders <<<--MEET-LINK-->>> and <<<--CALENDAR-LINK-->>> in your message where you want the links to appear. Do not try to generate the raw URLs yourself.`;
  } else if (availability?.formattedAvailableSlots?.length) {
    const slotList = availability.formattedAvailableSlots.slice(0, 5).map((s: string, i: number) => `${i + 1}. ${s}`).join("\n");
    schedulingCtx = `\n🗓️ YOU MUST LIST THESE EXACT TIME SLOTS in your reply (copy them verbatim):
${slotList}
  → Write them as a numbered list in your message. Do NOT use placeholders like "[AVAILABLE TIME SLOTS]".
  → If the user asked for a specific day and these don't include it, say honestly what you DO have.
  → NEVER say "let me check" — you already have the results. List them NOW in your reply.`;
  } else if (scheduler?.schedulerResult === "policy_violation") {
    schedulingCtx = `\n🗓️ SCHEDULING ISSUE: The requested time couldn't be booked because: ${scheduler.schedulerMessage || "scheduling policy violation"}.
  → Tell the user naturally that the time they wanted isn't available and suggest they pick from the available slots instead.
  → Do NOT mention "policy violation" or technical terms. Just say something like "That time isn't available, but here are some times that work..."`;
    if (availability?.formattedAvailableSlots?.length) {
      const slotList = availability.formattedAvailableSlots.slice(0, 5).map((s: string, i: number) => `${i + 1}. ${s}`).join("\n");
      schedulingCtx += `\nAVAILABLE ALTERNATIVES:\n${slotList}`;
    }
  } else if (scheduler?.schedulerResult === "duplicate") {
    schedulingCtx = `\n🗓️ DUPLICATE BOOKING: The user already has a consultation booked near this time.
  → Tell them warmly: "It looks like you already have a call scheduled around that time! Would you like to keep it or pick a different time?"
  → Do NOT show any error or technical message.`;
  } else if (availability && !availability.formattedAvailableSlots?.length) {
    schedulingCtx = `\n🗓️ NO SLOTS AVAILABLE in the next 2 weeks. Tell the user honestly and ask them to call back or try next week.`;
  }

  const systemPrompt = `You are the ILP assistant, a specialist legal intake consultant at ILP (International Legal Partner).
You are an EXPERT in legal services — residency, immigration, real estate, corporate structuring, tax, and family law.
Your team includes silent note-takers who extract and save data. You just TALK naturally.

YOUR OBJECTIVE:
Gather all the information needed to prepare a legal consultation BEFORE the call, then schedule that call.
This means you need EXHAUSTIVE detail — not just field names, but specifics:
• Legal matter: the exact type of matter (residency, real estate, corporate, immigration, tax, family)
• Jurisdiction: which country the matter concerns (Costa Rica, Panama, or Mexico)
• Practice area: which area of law this falls under
• Urgency: how soon the client needs help
• Notes: any additional context the client wants to share

WHAT YOU ALREADY KNOW:
${knownFields || "  (nothing yet)"}

WHAT YOU STILL NEED:
${stillNeeded}

SKIPPED: ${skippedFields.length > 0 ? skippedFields.join(", ") : "none"}
${schedulingCtx}
${FIELD_OPTIONS_BLOCK}${serviceFieldOptionsBlock ? `\nSERVICE FIELD CODES (valid values — use these exact codes):\n${serviceFieldOptionsBlock}` : ""}${serviceFieldContextBlock ? `\nSERVICE FIELD CONTEXT (which service each question belongs to — name it when asking):\n${serviceFieldContextBlock}` : ""}
SCHEDULING POLICY (always apply these when discussing timing):
${SCHEDULING_POLICIES.map(p => `  • ${p}`).join("\n")}

RULES:
1. LANGUAGE: Stay in the user's preferred language or the language the conversation started in. When in doubt, default to English.
2. BREVITY: 1-2 sentences + ONE question. Never lecture or summarize the whole matter.
3. ONE QUESTION AT A TIME. Do NOT ask about 2+ different topics in one message. Focus on one thing.
4. ACKNOWLEDGE first what they said, then ask your ONE question.
5. SUB-FIELD FOLLOW-UP: If user gives partial info, ask for the details.
6. SMART TRANSLATION: Help the user with vague answers.
   - "DIMEX" / "residency renewal" → "Sounds like a residency matter. Sound right?"
   - "buying property" → "So a real estate matter. Got it."
   - "SRL" / "corporation" → "A corporate structuring matter then."
7. NEVER repeat info you already have.
8. REFERRAL: If user says they found us via a referral but hasn't specified, ask once naturally, then accept whatever they give and move on. NEVER ask twice.
9. If user says they already told you → trust them, apologize, move on.
10. When AVAILABLE TIME SLOTS are shown → present them and ask user to pick one. This is the main goal!
11. When CALL IS SCHEDULED → The scheduling context block above will explicitly say "🗓️ CALL JUST SCHEDULED SUCCESSFULLY!". ONLY THEN should you output the exact placeholders <<<--MEET-LINK-->>> and <<<--CALENDAR-LINK-->>> in your reply. If that block is NOT present above, you MUST NOT emit those placeholders under any circumstances — even if the user picked a slot number.
12. Do NOT include annotations like [saved: ...] or [system] or [PRE-FILLED...] in your response.
13. NEVER output bracketed placeholders like [AVAILABLE TIME SLOTS], [link], [lien], [meeting link], etc. If you have data, write it out. If you don't have data, say so honestly. Brackets with ALL-CAPS or placeholder text = FORBIDDEN. The ONLY exception to this rule: <<<--MEET-LINK-->>> and <<<--CALENDAR-LINK-->>> are ONLY allowed when rule 11's condition is explicitly met.
14b. IF the user picked a slot number but you do NOT see "🗓️ CALL JUST SCHEDULED SUCCESSFULLY!" above, do NOT claim the call is booked. Instead say something like "Let me confirm that slot for you — one moment!" and DO NOT include any link placeholders.
14. STRICT QUESTION ORDER: You MUST ask the FIRST field listed under PRIORITY in "WHAT YOU STILL NEED". Do NOT skip ahead to later fields. Follow the exact order.
15. CROSS-FIELD ANSWERS: If the user's answer clearly belongs to a DIFFERENT field than what you asked, acknowledge the info they gave, then re-ask the original question.
16. LEGAL & ADVISORY DELEGATION: Any question touching immigration law, visa requirements, tax obligations, financial obligations, or any form of legal assessment → DO NOT make a judgment, give a likelihood, or state what is or isn't legally possible. Instead, acknowledge warmly and defer: "That's exactly the kind of question our attorneys cover in detail on the call — they'll give you accurate, current guidance for your specific situation." Then move on to the next intake field. ILP's human attorneys are the sole authority on anything legally or financially binding.

Format your response EXACTLY like this (wrapped in triple dashes):
---
{
  "responseText": "your natural language reply here"
}
---`;

  // ── Conversation for the LLM (clean, no internal annotations) ──
  const conversationForLLM = recentMessages.map((m: ChatMessage) => {
    const role = m.role === "system" ? "system" : m.role || "unknown";
    const content = m.content || "";
    return `[${role}]: ${content}`;
  }).join("\n");

      const llmRes = await callLLMWithFallback({
        prompt: `${summary ? `EARLIER IN THE CONVERSATION:\n${summary}\n\n` : ""}RECENT MESSAGES:\n${conversationForLLM}\n\nGenerate your next reply:`,
        systemInstruction: systemPrompt,
        temperature: 0.7,
        sessionId
      });

  // ── Centralized post-processor: catch ALL bracketed placeholders ──
  const cleanResponse = (text: string) => {
    let cleaned = text
      // Remove internal annotations
      .replace(/\s*\[saved:[^\]]*\]/gi, "")
      .replace(/\s*\[system[^\]]*\]/gi, "")
      .replace(/\s*\[PRE-FILLED[^\]]*\]/gi, "")
      .replace(/\s*\[extracted:[^\]]*\]/gi, "");

    // Replace known placeholders with actual data if available
    if (availability?.formattedAvailableSlots?.length) {
      const slotText = availability.formattedAvailableSlots.slice(0, 5)
        .map((s: string, i: number) => `${i + 1}. ${s}`).join("\n");
      // Catch any variation: [AVAILABLE TIME SLOTS], [available slots], [horarios disponibles], etc.
      cleaned = cleaned.replace(/\[(?:AVAILABLE\s*)?(?:TIME\s*)?SLOTS?\]|\[(?:horarios?\s*)?disponibles?\]/gi, slotText);
    }
    // If the scheduler did NOT succeed but the LLM emitted link placeholders,
    // remove them here as a defense layer (the router has a safety net too).
    const schedulingSucceeded = scheduler?.schedulerResult === "success" && !!scheduler?.createdEvent;
    if (!schedulingSucceeded) {
      cleaned = cleaned.replace(/<<<--MEET-LINK-->>>/gi, "").replace(/<<<--CALENDAR-LINK-->>>/gi, "");
    }
    // If scheduling DID succeed the router will replace them; leave them intact here.

    // Nuclear option: remove any remaining [placeholder] patterns (any case)
    cleaned = cleaned.replace(/\[[A-Za-z][A-Za-z\s_]{2,}\]/g, "").trim();
    // Also catch simple [link] [lien] [url] etc.
    cleaned = cleaned.replace(/\[(?:link|lien|url|enlace)\]/gi, "").trim();

    return cleaned;
  };

  try {
    const extracted = extractJSONFromLLMResponse(llmRes.content);
    let parsed: { responseText?: string; extractedFields?: Record<string, unknown> };
    try {
      parsed = JSON.parse(extracted);
    } catch (parseError) {
      log("[CONVERSATIONAL-AGENT] JSON parse failed due to formatting. Attempting regex fallback.");
      // Fallback for unescaped newlines or other JSON syntax errors
      const match = extracted.match(/"responseText"\s*:\s*"([\s\S]*?)"\s*}/);
      if (match && match[1]) {
        parsed = { responseText: match[1] };
      } else {
        throw parseError; // Re-throw if regex fails
      }
    }

    return {
      responseText: cleanResponse(parsed.responseText || ""),
      responseHTML: "",
      extractedFields: parsed.extractedFields || {}
    };
  } catch {
    log("[CONVERSATIONAL-AGENT] Both JSON parse and fallback failed, using raw LLM response.");
    let raw = llmRes.content
      .replace(/```(?:json)?\s*/g, "")
      .replace(/```/g, "")
      .replace(/---\s*/g, "")
      .trim();

    // Strip {"responseText": " ... "} if it's there
    raw = raw.replace(/^{\s*"responseText"\s*:\s*"/, "").replace(/"\s*}$/, "");

    return {
      responseText: cleanResponse(raw || llmRes.content),
      responseHTML: "",
      extractedFields: {}
    };
  }
}