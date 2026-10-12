import get from "../../../db/get.ts";
import put from "../../../db/put.ts";
import getAll from "../../../db/getAll.ts";
import log from "../../../helper/log.ts";

const COLLECTION_NAME = "ilp_chatbot_threads";

export type Participant = "user" | "assistant" | "system";

export interface ConversationMessage {
  role: Participant;
  content: string;
  extractedFields?: Record<string, unknown>;
  timestamp?: string;
}

export interface ConversationThread {
  sessionId: string;
  authCode?: string;
  messages: ConversationMessage[];
  skippedFields?: string[];
  formContextSnapshot?: Record<string, unknown>;
  lastAvailabilitySlots?: string[];
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Append a message to a conversation thread, creating the thread if it does
 * not exist. Returns the updated thread.
 */
export async function recordMessage(
  sessionId: string,
  message: ConversationMessage,
  authCode?: string
): Promise<ConversationThread> {
  const existing = (await get(COLLECTION_NAME, sessionId)) as
    | ConversationThread
    | null;

  const messages = [...(existing?.messages || []), message];
  const now = new Date().toISOString();

  const thread: ConversationThread = {
    sessionId,
    authCode: authCode || existing?.authCode,
    messages,
    skippedFields: existing?.skippedFields || [],
    formContextSnapshot: existing?.formContextSnapshot || {},
    lastAvailabilitySlots: existing?.lastAvailabilitySlots || [],
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };

  await put(COLLECTION_NAME, sessionId, thread as unknown as Record<string, unknown>);

  return thread;
}

/**
 * Return the full conversation context for a session: the raw message list
 * plus a deterministic bounded digest of older messages so the caller can
 * build a compact prompt without an LLM summarization dependency.
 */
export async function getConversationContext(
  sessionId: string
): Promise<{
  messages: ConversationMessage[];
  summary: string;
  recentMessages: ConversationMessage[];
}> {
  const thread = (await get(COLLECTION_NAME, sessionId)) as
    | ConversationThread
    | null;

  const messages = thread?.messages || [];
  const recentMessages = messages.slice(-20);

  return {
    messages,
    summary: summarizeMessageBatchLocal(messages),
    recentMessages
  };
}

/**
 * Deterministic bounded digest. Keeps the first and last few messages verbatim
 * and collapses the middle into a count, so the digest never grows unbounded
 * and never depends on an LLM summarization agent.
 */
function summarizeMessageBatchLocal(
  messages: ConversationMessage[]
): string {
  if (messages.length === 0) return "";

  const head = messages.slice(0, 3);
  const tail = messages.slice(-3);

  const lines: string[] = [];
  for (const m of head) {
    lines.push(`${m.role}: ${m.content.slice(0, 200)}`);
  }
  if (messages.length > 6) {
    lines.push(`... ${messages.length - 6} earlier messages omitted ...`);
  }
  for (const m of tail) {
    lines.push(`${m.role}: ${m.content.slice(0, 200)}`);
  }

  return lines.join("\n");
}

/**
 * List all conversation threads. Used by staff tooling to surface open
 * conversations. Returns an empty array when none exist.
 */
export async function listConversations(): Promise<ConversationThread[]> {
  try {
    const all = (await getAll(COLLECTION_NAME)) as unknown as ConversationThread[];
    return Array.isArray(all) ? all : [];
  } catch (err) {
    log(`[conversation-store] listConversations failed: ${err}`);
    return [];
  }
}