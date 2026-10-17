/**
 * API/dashboard/actions/registry.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Stage-scoped action registry for the ILP dashboard CRM. Each action is a
 * declarative descriptor; execution is handled by the router (which records
 * an `action_executed` activity entry).
 */

import type { ClientAction } from "./types.ts";

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
];

export function getActionsForStage(stage: string): ClientAction[] {
  return stageActionsRegistry.filter(
    (a) => !a.stages || a.stages.length === 0 || a.stages.includes(stage),
  );
}

export function getActionByKey(actionKey: string): ClientAction | undefined {
  return stageActionsRegistry.find((a) => a.actionKey === actionKey);
}