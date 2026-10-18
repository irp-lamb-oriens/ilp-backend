/**
 * API/dashboard/actions/registry.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Stage-scoped action registry for the ILP dashboard CRM. Each entry is a
 * declarative descriptor; entries with a `handler` run real logic, others are
 * placeholders that just log an `action_executed` activity entry.
 */

import type { ClientAction } from "./types.ts";
import { reviewTranscriptAction } from "./reviewTranscriptAction.ts";
import { assessSalesAction } from "./assessSalesAction.ts";
import { requestQuoteFromProvidersAction } from "./requestQuoteFromProvidersAction.ts";
import { confirmFilingDeadlineAction } from "./confirmFilingDeadlineAction.ts";
import { startDeadlineFollowupLoopAction } from "./startDeadlineFollowupLoopAction.ts";
import { confirmDocumentChecklistAction } from "./confirmDocumentChecklistAction.ts";
import { cancelDeadlineFollowupAction } from "./cancelDeadlineFollowupAction.ts";

export const stageActionsRegistry: ClientAction[] = [
  {
    actionKey: "send_quote",
    label: "Send quote",
    description: "Mark a quote as sent to the client.",
    stages: ["legal_review", "quote_sent"],
  },
  {
    actionKey: "request_documents",
    label: "Request documents",
    description: "Ask the client to upload required documents.",
    stages: ["scoping", "legal_review"],
  },
  {
    actionKey: "schedule_call",
    label: "Schedule call",
    description: "Book a follow-up consultation.",
  },
  {
    actionKey: "mark_filed",
    label: "Mark as filed",
    description: "Record that the matter has been filed.",
    stages: ["quote_accepted", "filing"],
  },
  {
    actionKey: "close_matter",
    label: "Close matter",
    description: "Close the matter as complete.",
    stages: ["filing", "closed"],
  },

  // ── R2 real implementations ────────────────────────────────────────────────
  {
    actionKey: "review_transcript",
    label: "Review transcript",
    description: "Extract structured legal-intake fields from the transcript / meeting notes.",
    stages: ["scoping", "legal_review"],
    confirm: true,
    handler: reviewTranscriptAction,
  },
  {
    actionKey: "intake_assessment",
    label: "Intake assessment",
    description: "Score intake completeness and flag missing fields.",
    stages: ["intake", "scoping"],
    confirm: true,
    handler: assessSalesAction,
  },
  {
    actionKey: "request_quote_from_providers",
    label: "Request quotes from providers",
    description: "Create RFQ quote-requests against providers matching the client's legal area / jurisdiction.",
    stages: ["legal_review", "quote_sent"],
    confirm: true,
    handler: requestQuoteFromProvidersAction,
  },
  {
    actionKey: "confirm_filing_deadline",
    label: "Confirm filing deadline",
    description: "Confirm or update the client's filing deadline.",
    stages: ["quote_accepted", "filing"],
    confirm: true,
    handler: confirmFilingDeadlineAction,
  },
  {
    actionKey: "start_deadline_followup_loop",
    label: "Start deadline follow-up loop",
    description: "Register a recurring follow-up loop until the filing deadline is confirmed.",
    stages: ["filing"],
    confirm: true,
    handler: startDeadlineFollowupLoopAction,
  },
  {
    actionKey: "confirm_document_checklist",
    label: "Confirm document checklist",
    description: "Mark document checklist items confirmed and flag missing documents.",
    stages: ["scoping", "legal_review", "filing"],
    confirm: true,
    handler: confirmDocumentChecklistAction,
  },
  {
    actionKey: "cancel_deadline_followup",
    label: "Cancel deadline follow-up",
    description: "Stop the recurring filing-deadline follow-up loop.",
    stages: ["filing"],
    confirm: true,
    handler: cancelDeadlineFollowupAction,
  },
];

export function getActionsForStage(stage: string): ClientAction[] {
  return stageActionsRegistry.filter(
    (a) => !a.stages || a.stages.length === 0 || a.stages.includes(stage),
  );
}

export function getActionByKey(actionKey: string): ClientAction | undefined {
  return stageActionsRegistry.find((a) => a.actionKey === actionKey);
}
