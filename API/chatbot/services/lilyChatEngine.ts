/**
 * services/lilyChatEngine.ts — the shared project-scoped Lily engine.
 *
 * One engine, two scopes:
 *   • "status" — the client portal (client chats about their own project)
 *   • "crm"    — the staff dashboard (staff chats as the assistant with a
 *                client's full context)
 *
 * Unlike the homepage intake flow (which runs the thinking → availability →
 * scheduler → conversational + field-extraction stack to collect form fields),
 * this engine answers questions ABOUT an existing project. It is grounded in
 * the actual client document so it cannot invent a stage, a charge, or a
 * jurisdiction that is not there.
 *
 * Persistence:
 *   • status scope → `statusChatThread` array on the client doc (shared with
 *     the client-status router, so both read/write the same thread).
 *   • crm scope    → `crmLilyThread` array on the client doc (staff-only).
 */

import get from "../../../db/get.ts";
import put from "../../../db/put.ts";
import log from "../../../helper/log.ts";
import { callLLMWithFallback } from "../intelligence/llm.ts";

const CLIENTS_COLLECTION = "clients";

export type LilyScope = "status" | "crm";

export interface LilyThreadMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  /** Who sent it (client email, or staff email for crm scope). */
  author?: string;
}

export interface LilyChatResult {
  reply: string;
  threadSnapshot: {
    scope: LilyScope;
    messages: LilyThreadMessage[];
    rawTail: LilyThreadMessage[];
  };
}

/** Optional lawyer profile injected into the CRM prompt as context. */
export interface LawyerProfile {
  name?: string | null;
  legalAreas?: string[];
  jurisdictions?: string[];
}

/** The field on the client doc that holds the thread for a given scope. */
function threadField(scope: LilyScope): "statusChatThread" | "crmLilyThread" {
  return scope === "crm" ? "crmLilyThread" : "statusChatThread";
}

/** Read the latest consultation entry (where consultation-scoped values live). */
function latestConsultation(doc: Record<string, unknown>): Record<string, unknown> {
  const cons = Array.isArray(doc.consultations) ? doc.consultations : [];
  return (cons[cons.length - 1] ?? {}) as Record<string, unknown>;
}

/** Pick a value from the latest consultation, falling back to the root doc. */
function pick(doc: Record<string, unknown>, key: string): unknown {
  const latest = latestConsultation(doc);
  return latest[key] !== undefined ? latest[key] : doc[key];
}

/**
 * Build a compact, factual project brief for the prompt. Only real values are
 * included, so the model has nothing to hallucinate from.
 */
function buildProjectBrief(doc: Record<string, unknown>): string {
  const lines: string[] = [];

  const name = [pick(doc, "name"), pick(doc, "surname")].filter(Boolean).join(" ");
  if (name) lines.push(`Client: ${name}`);
  const email = pick(doc, "email") ?? doc.dripEmail;
  if (typeof email === "string" && email) lines.push(`Email: ${email}`);

  const stage = typeof doc.stage === "string" ? doc.stage : "";
  if (stage) lines.push(`Current stage: ${stage}`);

  const legalArea = pick(doc, "legalArea");
  if (legalArea) lines.push(`Legal area: ${legalArea}`);
  const legalMatter = pick(doc, "legalMatter");
  if (legalMatter) lines.push(`Legal matter: ${legalMatter}`);
  const jurisdiction = pick(doc, "jurisdiction");
  if (jurisdiction) lines.push(`Jurisdiction: ${jurisdiction}`);

  const quotes = Array.isArray(doc.quotes) ? doc.quotes : [];
  if (quotes.length > 0) {
    const latestQuote = quotes[quotes.length - 1] as Record<string, unknown>;
    const qStatus = latestQuote.status ?? "draft";
    const qTotal = latestQuote.total ?? null;
    lines.push(
      `Latest quote: ${qStatus}${qTotal != null ? ` (${qTotal} ${latestQuote.currency ?? "USD"})` : ""}`,
    );
  }

  const charges = Array.isArray(doc.charges) ? doc.charges : [];
  if (charges.length > 0) {
    lines.push(`Charges on file: ${charges.length}`);
  }

  const activity = Array.isArray(doc.activityLog) ? doc.activityLog : [];
  if (activity.length > 0) {
    const recent = activity.slice(-3).map((a) => {
      const e = a as Record<string, unknown>;
      return `${e.type ?? "event"} (${e.timestamp ?? ""})`;
    });
    lines.push(`Recent activity: ${recent.join("; ")}`);
  }

  const notes = Array.isArray(doc.notes) ? doc.notes : [];
  if (notes.length > 0) {
    const recentNotes = notes.slice(-5).map((n) => {
      const e = n as Record<string, unknown>;
      return `- ${e.author ?? "note"}: ${e.text ?? ""}`;
    });
    lines.push(`Notes:\n${recentNotes.join("\n")}`);
  }

  const insights = doc.transcriptInsights as Record<string, unknown> | undefined;
  if (insights && Object.keys(insights).length > 0) {
    lines.push(`Extracted insights: ${JSON.stringify(insights)}`);
  }

  return lines.length > 0 ? lines.join("\n") : "(no project details on file yet)";
}

/** The system prompt, scoped to the actor's role. */
function buildSystemPrompt(
  scope: LilyScope,
  brief: string,
  lawyerProfile?: LawyerProfile,
): string {
  const roleLine =
    scope === "crm"
      ? "You are Lily, the ILP legal assistant, helping a staff member review a client's project. You have full access to the project context below."
      : "You are Lily, the ILP legal assistant, helping a client understand the status of their own legal project.";

  const lawyerContext = lawyerProfile
    ? `\n\nLAWYER CONTEXT (the staff member you are assisting):\nName: ${lawyerProfile.name ?? "—"}\nLegal areas: ${(lawyerProfile.legalAreas ?? []).join(", ") || "—"}\nJurisdictions: ${(lawyerProfile.jurisdictions ?? []).join(", ") || "—"}`
    : "";

  return `${roleLine}

PROJECT CONTEXT (ground truth — do not contradict or invent beyond this):
${brief}${lawyerContext}

RULES:
1. Answer ONLY from the project context above. If the answer is not in the context, say you do not have that detail yet and that the legal team can confirm it.
2. NEVER invent a stage, date, amount, charge, quote, or jurisdiction that is not listed above.
3. LEGAL & ADVISORY DELEGATION: any question touching immigration law, visa requirements, tax obligations, or any legal assessment → do NOT give a judgment or likelihood. Defer: "That is exactly the kind of question our attorneys cover in detail — they will give you accurate guidance for your specific situation."
4. Be concise: 1-3 sentences. No lectures.
5. Stay in the language the user wrote in.
6. Do not output bracketed placeholders, markdown tables, or emoji.`;
}

/**
 * Run one Lily turn for a project. Loads the client doc, appends the user
 * message, generates a grounded reply, and persists both to the scope's thread.
 */
export async function chatWithLily(
  projectId: string,
  scope: LilyScope,
  message: string,
  actorEmail: string,
  actorRole: "client" | "staff",
  lawyerProfile?: LawyerProfile,
): Promise<LilyChatResult> {
  const doc = await get(CLIENTS_COLLECTION, projectId);
  if (!doc) throw new Error("Project not found.");

  const field = threadField(scope);
  const thread: LilyThreadMessage[] = Array.isArray(doc[field])
    ? (doc[field] as LilyThreadMessage[])
    : [];

  const userMsg: LilyThreadMessage = {
    role: "user",
    content: message.trim(),
    createdAt: new Date().toISOString(),
    author: actorEmail,
  };

  const brief = buildProjectBrief(doc);
  const systemPrompt = buildSystemPrompt(scope, brief, lawyerProfile);

  // Rolling window of the last 12 turns for context.
  const recent = thread.slice(-12).map((m) => `${m.role}: ${m.content}`).join("\n");

  const llmRes = await callLLMWithFallback({
    prompt: `${recent ? `PREVIOUS CONVERSATION:\n${recent}\n\n` : ""}USER (${actorRole}): ${message.trim()}\n\nReply:`,
    systemInstruction: systemPrompt,
    temperature: 0.4,
  });

  const replyText = (llmRes.content ?? "").trim() || "I do not have that detail yet. The legal team can confirm it for you.";

  const replyMsg: LilyThreadMessage = {
    role: "assistant",
    content: replyText,
    createdAt: new Date().toISOString(),
    author: "lily",
  };

  const nextThread = [...thread, userMsg, replyMsg];
  await put(CLIENTS_COLLECTION, projectId, { [field]: nextThread });

  log(`[lilyChatEngine] ${scope} turn on ${projectId} by ${actorEmail} (${actorRole})`);

  return {
    reply: replyText,
    threadSnapshot: {
      scope,
      messages: nextThread,
      rawTail: nextThread.slice(-4),
    },
  };
}

/** Load the thread for a project + scope (empty when none). */
export async function getChatThread(
  projectId: string,
  scope: LilyScope,
): Promise<{ thread: LilyThreadMessage[] }> {
  const doc = await get(CLIENTS_COLLECTION, projectId);
  if (!doc) return { thread: [] };
  const field = threadField(scope);
  const thread = Array.isArray(doc[field]) ? (doc[field] as LilyThreadMessage[]) : [];
  return { thread };
}