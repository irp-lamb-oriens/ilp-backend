/**
 * API/dashboard/actions/startDeadlineFollowupLoopAction.ts
 * ──────────────────────────────────────────────────────────────────────────
 * REAL handler for the `start_deadline_followup_loop` action (IRP
 * `start_eta_loop` analog, retargeted to the legal filing deadline).
 *
 * Registers a deadline follow-up loop on the client doc. The doc records the
 * follow-up cadence and the owner email; the actual periodic sweep is handled
 * by a cron job (jobs/deadlineFollowup.ts) that reads `deadlineFollowup`.
 */

import get from "../../../db/get.ts";
import put from "../../../db/put.ts";
import type { ActionContext, ActionResult } from "./types.ts";

const CLIENTS_COLLECTION = "clients";

export async function startDeadlineFollowupLoopAction(
  ctx: ActionContext,
): Promise<ActionResult> {
  const { clientId, args, actor } = ctx;
  const doc = (await get(CLIENTS_COLLECTION, clientId)) ?? ctx.clientDoc ?? {};

  const ownerEmail =
    typeof args?.ownerEmail === "string" && args.ownerEmail.includes("@")
      ? args.ownerEmail.trim().toLowerCase()
      : null;
  const deadline =
    typeof args?.filingDeadline === "string" && args.filingDeadline.trim()
      ? args.filingDeadline.trim()
      : (typeof doc.filingDeadline === "string" ? doc.filingDeadline : null);

  const cadenceDays =
    Number.isFinite(Number(args?.cadenceDays)) ? Number(args?.cadenceDays) : 1;

  if (!deadline) {
    return {
      success: false,
      message: "A filingDeadline is required to start a follow-up loop.",
      data: { reason: "missing_deadline" },
    };
  }

  const nowIso = new Date().toISOString();
  await put(CLIENTS_COLLECTION, clientId, {
    filingDeadline: deadline,
    filingDeadlineOwnerEmail: ownerEmail ?? doc.filingDeadlineOwnerEmail ?? null,
    deadlineFollowup: {
      status: "active",
      startedAt: nowIso,
      startedBy: actor,
      deadline,
      ownerEmail,
      cadenceDays,
      lastRemindedAt: null,
    },
    updatedAt: nowIso,
    activityLog: [
      ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
      { type: "deadline_followup_started", actor, timestamp: nowIso, deadline, cadenceDays },
    ],
  });

  return {
    success: true,
    message: `Deadline follow-up loop started (every ${cadenceDays} day(s), owner ${ownerEmail ?? "unassigned"}).`,
    data: { deadline, cadenceDays, ownerEmail },
  };
}
