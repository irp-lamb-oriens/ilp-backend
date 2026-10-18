/**
 * API/dashboard/actions/confirmDocumentChecklistAction.ts
 * ──────────────────────────────────────────────────────────────────────────
 * REAL handler for the `confirm_document_checklist` action (IRP
 * `confirm_pickup_details` analog, retargeted to a legal document checklist).
 *
 * Marks checklist items confirmed on the client doc and raises a pending
 * action listing any still-missing items.
 */

import get from "../../../db/get.ts";
import put from "../../../db/put.ts";
import { addPendingAction } from "../pendingActions.ts";
import type { ActionContext, ActionResult } from "./types.ts";

const CLIENTS_COLLECTION = "clients";

export async function confirmDocumentChecklistAction(
  ctx: ActionContext,
): Promise<ActionResult> {
  const { clientId, actor, args } = ctx;
  const doc = (await get(CLIENTS_COLLECTION, clientId)) ?? ctx.clientDoc ?? {};

  const confirmedItems: string[] = Array.isArray(args?.confirmedItems)
    ? args.confirmedItems.filter((i: unknown): i is string => typeof i === "string" && !!i.trim())
    : [];
  const allItems: string[] = Array.isArray(args?.allItems)
    ? args.allItems.filter((i: unknown): i is string => typeof i === "string" && !!i.trim())
    : [];

  if (allItems.length === 0) {
    return {
      success: false,
      message: "Provide at least one checklist item (allItems) to confirm against.",
      data: { reason: "no_items" },
    };
  }

  const nowIso = new Date().toISOString();
  const confirmedSet = new Set(confirmedItems.map((i) => i.trim().toLowerCase()));
  const checklist = allItems.map((label) => ({
    label,
    confirmed: confirmedSet.has(label.trim().toLowerCase()),
    confirmedAt: confirmedSet.has(label.trim().toLowerCase()) ? nowIso : null,
    confirmedBy: confirmedSet.has(label.trim().toLowerCase()) ? actor : null,
  }));

  const missing = checklist.filter((c) => !c.confirmed).map((c) => c.label);

  await put(CLIENTS_COLLECTION, clientId, {
    documentChecklist: checklist,
    updatedAt: nowIso,
    activityLog: [
      ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
      { type: "document_checklist_confirmed", actor, timestamp: nowIso, confirmed: confirmedItems.length, total: allItems.length },
    ],
  });

  if (missing.length > 0) {
    await addPendingAction(clientId, {
      type: "documents_missing",
      tab: "documents",
      title: `Missing documents: ${missing.join(", ")}`,
      priority: "normal",
      assignedTo: [],
      triggeredBy: actor,
      meta: { missing },
    });
  }

  return {
    success: true,
    message:
      missing.length === 0
        ? "All checklist items confirmed."
        : `${confirmedItems.length}/${allItems.length} items confirmed; ${missing.length} remaining.`,
    data: { checklist, missing },
  };
}
