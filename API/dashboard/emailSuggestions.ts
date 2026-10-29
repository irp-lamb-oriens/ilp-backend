/**
 * API/dashboard/emailSuggestions.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Stage-triggered email suggestions for the ILP dashboard CRM. These are
 * SUGGESTIONS only — no email is sent automatically; the operator previews
 * and confirms in the Emails tab.
 */

import type { Request, Response } from "express";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import log from "../../helper/log.ts";
import { isQuoteAwaitingClient, quoteKey } from "../../schemas/quoteStatus.ts";

const CLIENTS_COLLECTION = "clients";

/** Legal-pipeline stage → suggested email types. */
export const STAGE_EMAIL_TRIGGERS: Record<string, string[]> = {
  scoping: ["scoping_intro"],
  legal_review: ["legal_review_update"],
  quote_sent: ["quote_ready"],
  quote_accepted: ["quote_accepted_confirmation"],
  filing: ["filing_started"],
  closed: ["matter_closed"],
};

export interface EmailSuggestion {
  suggestionId: string;
  emailType: string;
  triggeredByStage: string;
  suggestedAt: string;
  movedByActor: string;
  status: "pending" | "dismissed" | "sent";
}

function newSuggestionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createSuggestions(
  stage: string,
  actor: string,
  nowIso: string,
): EmailSuggestion[] {
  const types = STAGE_EMAIL_TRIGGERS[stage] ?? [];
  return types.map((emailType) => ({
    suggestionId: newSuggestionId(),
    emailType,
    triggeredByStage: stage,
    suggestedAt: nowIso,
    movedByActor: actor,
    status: "pending",
  }));
}

// ─── COMMS-P4: no second quote email ───────────────────────────────────────

/**
 * The quote "Send to client" already emailed and that is still waiting for
 * the member's answer (newest first), or null. Pure.
 */
export function emailedQuote(doc: Record<string, unknown>): { quoteId: string; sentAt: string } | null {
  const quotes = Array.isArray(doc.quotes) ? (doc.quotes as Array<Record<string, unknown>>) : [];
  const sent = quotes
    .filter((q) => isQuoteAwaitingClient(q) && typeof q.sentToClientAt === "string" && q.sentToClientAt)
    .sort((a, b) => String(b.sentToClientAt).localeCompare(String(a.sentToClientAt)))[0];
  return sent ? { quoteId: quoteKey(sent), sentAt: String(sent.sentToClientAt) } : null;
}

/**
 * Moving a matter to "quote sent" suggests the quote_ready email. When "Send
 * to client" already emailed the quote, that suggestion is left out (staff
 * would send the same quote twice). Pure: returns what to keep and what was
 * skipped (for the activity log).
 */
export function dropAlreadySent(
  suggestions: EmailSuggestion[],
  doc: Record<string, unknown>,
): { keep: EmailSuggestion[]; skipped: Array<EmailSuggestion & { quoteId: string; sentAt: string }> } {
  const q = emailedQuote(doc);
  if (!q) return { keep: suggestions, skipped: [] };
  const keep: EmailSuggestion[] = [];
  const skipped: Array<EmailSuggestion & { quoteId: string; sentAt: string }> = [];
  for (const s of suggestions) {
    if (s.emailType === "quote_ready") skipped.push({ ...s, status: "sent", ...q });
    else keep.push(s);
  }
  return { keep, skipped };
}

/** "Send to client" emailed the quote: pending quote_ready suggestions are done. Pure. */
export function withoutPendingQuoteReady<T extends Record<string, unknown>>(list: T[]): T[] {
  return list.filter((s) => !(s?.status === "pending" && s.emailType === "quote_ready"));
}

export function buildSuggestionActivityEntries(
  suggestions: EmailSuggestion[],
  nowIso: string,
): Array<Record<string, unknown>> {
  return suggestions.map((s) => ({
    type: "email_suggested",
    emailType: s.emailType,
    suggestionId: s.suggestionId,
    triggeredByStage: s.triggeredByStage,
    movedByActor: s.movedByActor,
    actor: "system",
    timestamp: nowIso,
  }));
}

/** Dismiss a single email suggestion (operator action). */
export async function handleDismissEmailSuggestion(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = req.params;
  const { suggestionId } = req.body ?? {};
  const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "system";

  if (!suggestionId) {
    res.status(400).json({ error: "suggestionId is required." });
    return;
  }

  const doc = await get(CLIENTS_COLLECTION, id);
  if (!doc) {
    res.status(404).json({ error: "Client not found." });
    return;
  }

  const existing: EmailSuggestion[] = Array.isArray(doc.pendingEmailSuggestions)
    ? (doc.pendingEmailSuggestions as EmailSuggestion[])
    : [];

  const updated = existing.map((s) =>
    s.suggestionId === suggestionId
      ? { ...s, status: "dismissed" as const, dismissedBy: actor, dismissedAt: new Date().toISOString() }
      : s,
  );

  await put(CLIENTS_COLLECTION, id, { pendingEmailSuggestions: updated });
  log(`[dashboard] Email suggestion ${suggestionId} dismissed by ${actor}`);
  res.json({ success: true });
}