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