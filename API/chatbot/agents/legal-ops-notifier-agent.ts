/**
 * legal-ops-notifier-agent.ts — escalates blockers to staff as a pending action
 * (+ optional email) instead of IRP's engineering Jira notifier.
 * Decision #2 adaptation: engineering-notifier → pending-action + email.
 */

import log from "../../../helper/log.ts";
import put from "../../../db/put.ts";
import { enqueueEmail } from "../../../helper/emailQueue.ts";
import type { LegalOpsNotifierAgentResponse } from "./types.ts";

const CLIENTS_COLLECTION = "clients";

export interface LegalOpsEscalation {
  clientId: string;
  title: string;
  body: string;
  urgency?: "high" | "normal" | "low";
  staffEmail?: string;
}

function newActionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function runLegalOpsNotifierAgent(
  escalation: LegalOpsEscalation,
): Promise<LegalOpsNotifierAgentResponse> {
  const nowIso = new Date().toISOString();
  const actionId = newActionId();

  try {
    const doc = await import("../../../db/get.ts").then((m) => m.default(CLIENTS_COLLECTION, escalation.clientId).catch(() => null));
    const existing = Array.isArray(doc?.pendingActions)
      ? (doc.pendingActions as Array<Record<string, unknown>>)
      : [];

    await put(CLIENTS_COLLECTION, escalation.clientId, {
      pendingActions: [
        ...existing,
        {
          actionId,
          type: "legal_ops_blocker",
          tab: "overview",
          title: escalation.title,
          priority: escalation.urgency ?? "normal",
          assignedTo: escalation.staffEmail ? [escalation.staffEmail] : [],
          triggeredBy: "system",
          triggeredAt: nowIso,
          status: "pending",
          meta: { body: escalation.body },
        },
      ],
    });
  } catch (err) {
    log(`[legal-ops-notifier] pending-action write failed: ${err instanceof Error ? err.message : err}`);
    return { escalated: false, pendingActionId: null, emailQueued: false };
  }

  let emailQueued = false;
  if (escalation.staffEmail) {
    try {
      await enqueueEmail({
        to: escalation.staffEmail,
        subject: `[ILP ops] ${escalation.title}`,
        html: `<p>${escalation.body}</p>`,
      });
      emailQueued = true;
    } catch (err) {
      log(`[legal-ops-notifier] email queue failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { escalated: true, pendingActionId: actionId, emailQueued };
}
