/**
 * API/dashboard/actions/confirmFilingDeadlineAction.ts
 * ──────────────────────────────────────────────────────────────────────────
 * REAL handler for the `confirm_filing_deadline` action (IRP `confirm_eta`
 * analog, retargeted to the legal filing deadline).
 *
 * Confirms/updates a filing deadline on the client doc and, when a follow-up
 * loop is active, marks it resolved. Raises a pending action when the deadline
 * is in the past or too soon.
 */

import get from "../../../db/get.ts";
import put from "../../../db/put.ts";
import { addPendingAction } from "../pendingActions.ts";
import type { ActionContext, ActionResult } from "./types.ts";

const CLIENTS_COLLECTION = "clients";

export async function confirmFilingDeadlineAction(
  ctx: ActionContext,
): Promise<ActionResult> {
  const { clientId, args, actor } = ctx;
  const doc = (await get(CLIENTS_COLLECTION, clientId)) ?? ctx.clientDoc ?? {};

  const filingDeadline =
    typeof args?.filingDeadline === "string" && args.filingDeadline.trim()
      ? args.filingDeadline.trim()
      : null;

  if (!filingDeadline) {
    return {
      success: false,
      message: "A filing deadline (ISO date) is required.",
      data: { reason: "missing_deadline" },
    };
  }

  const nowIso = new Date().toISOString();
  const deadlineMs = new Date(filingDeadline).getTime();
  if (Number.isNaN(deadlineMs)) {
    return {
      success: false,
      message: "filingDeadline must be a valid ISO date.",
      data: { reason: "invalid_date" },
    };
  }

  const payload: Record<string, unknown> = {
    filingDeadline,
    filingDeadlineConfirmedAt: nowIso,
    filingDeadlineConfirmedBy: actor,
    // Stop any active deadline follow-up loop.
    deadlineFollowup: {
      status: "confirmed",
      confirmedAt: nowIso,
      confirmedBy: actor,
      deadline: filingDeadline,
    },
    updatedAt: nowIso,
    activityLog: [
      ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
      { type: "filing_deadline_confirmed", actor, timestamp: nowIso, deadline: filingDeadline },
    ],
  };

  await put(CLIENTS_COLLECTION, clientId, payload);

  const daysOut = Math.round((deadlineMs - Date.now()) / 86_400_000);
  if (daysOut <= 7) {
    await addPendingAction(clientId, {
      type: "deadline_urgent",
      tab: "overview",
      title: `Filing deadline confirmed but only ${Math.max(daysOut, 0)} day(s) out`,
      priority: "high",
      assignedTo: [],
      triggeredBy: actor,
      meta: { deadline: filingDeadline, daysOut },
    });
  }

  return {
    success: true,
    message: `Filing deadline confirmed: ${filingDeadline}.`,
    data: { filingDeadline, daysOut },
  };
}