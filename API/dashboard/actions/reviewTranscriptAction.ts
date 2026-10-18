/**
 * API/dashboard/actions/reviewTranscriptAction.ts
 * ──────────────────────────────────────────────────────────────────────────
 * REAL handler for the `review_transcript` action.
 *
 * 1. Resolves the best available source text (manualText → doc.transcript → the
 *    last calendar-event notes text).
 * 2. Runs `extractClientFieldsServer` (legal-intake taxonomy) against it.
 * 3. Persists `transcriptInsights` (+ a pending action + activity entry) on the
 *    client doc.
 * 4. Returns the fields inline.
 */

import get from "../../../db/get.ts";
import put from "../../../db/put.ts";
import log from "../../../helper/log.ts";
import { extractClientFieldsServer } from "../extractClientFieldsServer.ts";
import { addPendingAction } from "../pendingActions.ts";
import type { ActionContext, ActionResult } from "./types.ts";

const CLIENTS_COLLECTION = "clients";

export async function reviewTranscriptAction(
  ctx: ActionContext,
): Promise<ActionResult> {
  const { clientId, args, actor } = ctx;

  const fresh = await get(CLIENTS_COLLECTION, clientId);
  const doc = (fresh ?? ctx.clientDoc ?? {}) as Record<string, unknown>;

  const manualText =
    typeof args?.manualText === "string" ? args.manualText.trim() : "";

  const calNotes = (doc.lastCalendarEvent as Record<string, unknown> | undefined)
    ?.notes as Record<string, unknown> | undefined;
  const sourceText =
    manualText ||
    (typeof doc.transcript === "string" ? doc.transcript : "") ||
    (typeof calNotes?.text === "string" ? calNotes.text : "");

  if (!sourceText.trim()) {
    return {
      success: false,
      message:
        "No transcript or meeting notes found. Paste the transcript in manualText, or sync meet notes first.",
      data: { reason: "no_source_text" },
    };
  }

  try {
    const insights = await extractClientFieldsServer(sourceText);
    const nowIso = new Date().toISOString();

    await put(CLIENTS_COLLECTION, clientId, {
      transcriptInsights: insights,
      updatedAt: nowIso,
      activityLog: [
        ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
        { type: "transcript_reviewed", actor, timestamp: nowIso },
      ],
    });

    if (!insights.legalArea && !insights.legalMatter) {
      await addPendingAction(clientId, {
        type: "intake_incomplete",
        tab: "overview",
        title: "Transcript reviewed but intake fields incomplete",
        priority: "normal",
        assignedTo: [],
        triggeredBy: actor,
        meta: { reason: "no_legal_fields" },
      });
    }

    return {
      success: true,
      message:
        `Extracted fields: ${insights.legalArea ?? "—"} / ${insights.legalMatter ?? "—"} / ${insights.jurisdiction ?? "—"}`,
      data: { insights },
    };
  } catch (err) {
    log(`[review_transcript] ${clientId} failed: ${err instanceof Error ? err.message : err}`);
    return {
      success: false,
      message: "The AI provider failed to respond. Try again shortly.",
      data: { reason: "llm_error" },
    };
  }
}