/**
 * API/dashboard/actions/cancelDeadlineFollowupAction.ts
 * ──────────────────────────────────────────────────────────────────────────
 * REAL handler for the `cancel_deadline_followup` action (Segment 1.4).
 *
 * Stops an active deadline follow-up loop by persisting
 * `deadlineFollowup.status = "cancelled"` (no cancel endpoint exists elsewhere,
 * so this is the only cancellation path). The sweep skips non-active statuses.
 */

import get from "../../../db/get.ts";
import put from "../../../db/put.ts";
import type { ActionContext, ActionResult } from "./types.ts";

const CLIENTS_COLLECTION = "clients";

export async function cancelDeadlineFollowupAction(
  ctx: ActionContext,
): Promise<ActionResult> {
  const { clientId, actor } = ctx;
  const doc = await get(CLIENTS_COLLECTION, clientId);

  if (!doc) {
    return {
      success: false,
      message: "Client not found.",
      data: { reason: "not_found" },
    };
  }

  const followup = doc.deadlineFollowup as
    | { status?: string; [key: string]: unknown }
    | undefined;

  if (!followup || followup.status !== "active") {
    return {
      success: false,
      message: "No active deadline follow-up loop to cancel.",
      data: { reason: "not_active" },
    };
  }

  const nowIso = new Date().toISOString();
  await put(CLIENTS_COLLECTION, clientId, {
    deadlineFollowup: {
      ...followup,
      status: "cancelled",
      cancelledAt: nowIso,
      cancelledBy: actor,
      nextDueAt: null,
    },
    updatedAt: nowIso,
    activityLog: [
      ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
      { type: "deadline_followup_cancelled", actor, timestamp: nowIso },
    ],
  });

  return {
    success: true,
    message: "Deadline follow-up loop cancelled.",
    data: { status: "cancelled", cancelledAt: nowIso },
  };
}