/**
 * librarian-agent.ts — answers service/stage/jurisdiction questions from the
 * curated ILP legal knowledge base (context-information.txt / context-sales.txt).
 * Pure keyword + LLM-grounded retrieval; no external DB writes.
 */

import log from "../../../helper/log.ts";
import { callLLMWithFallback } from "../intelligence/llm.ts";
import type { LibrarianAgentResponse } from "./types.ts";

// Knowledge files are plain-text; read once and cache.
let _infoCache: string | null = null;
let _salesCache: string | null = null;

function readKnowledgeFile(filename: string): string {
  try {
    return Deno.readTextFileSync(new URL(`./${filename}`, import.meta.url));
  } catch {
    return "";
  }
}

function infoKnowledge(): string {
  if (_infoCache === null) _infoCache = readKnowledgeFile("context-information.txt");
  return _infoCache;
}
function salesKnowledge(): string {
  if (_salesCache === null) _salesCache = readKnowledgeFile("context-sales.txt");
  return _salesCache;
}

const INFO_KEYWORDS = [
  "immigration", "visa", "residency", "citizenship", "costa rica", "panama",
  "mexico", "corporate", "real estate", "notary", "family", "estate",
  "stage", "process", "timeline", "jurisdiction", "service", "how long", "what is",
];

export async function runLibrarianAgent(
  userMessage: string,
  conversationContext: string,
  sessionId?: string,
): Promise<LibrarianAgentResponse> {
  const msgLower = userMessage.toLowerCase();

  const isSalesIntent =
    /quote|price|pricing|cost|fee|offer|consultation|book|schedule|objection/.test(msgLower);

  const knowledge = isSalesIntent ? salesKnowledge() : infoKnowledge();

  // Keyword-gated: if nothing in the message hints at a service/stage question,
  // return a non-answer instead of forcing an LLM call.
  const matched = INFO_KEYWORDS.filter((k) => msgLower.includes(k));
  if (matched.length === 0 && !isSalesIntent) {
    return { answered: false, answer: "", source: "none", matchedKeywords: [] };
  }

  try {
    const res = await callLLMWithFallback({
      systemInstruction: `You answer questions about International Legal Partner (ILP) using ONLY the curated knowledge below. If the answer is not present, say you do not have that detail and the legal team can confirm. Be concise (1-3 sentences). Answer in the language the user wrote in.`,
      prompt: `KNOWLEDGE BASE:\n${knowledge}\n\nCONVERSATION:\n${conversationContext}\n\nUSER QUESTION: "${userMessage}"\n\nAnswer:`,
      temperature: 0.2,
      sessionId,
    });

    const answer = (res.content ?? "").trim();
    if (!answer) {
      return { answered: false, answer: "", source: "none", matchedKeywords: matched };
    }
    return {
      answered: true,
      answer,
      source: isSalesIntent ? "context_sales" : "context_information",
      matchedKeywords: matched,
    };
  } catch (err) {
    log(`[LIBRARIAN-AGENT] error: ${err instanceof Error ? err.message : err}`);
    return { answered: false, answer: "", source: "none", matchedKeywords: matched };
  }
}
