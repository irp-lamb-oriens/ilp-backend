/**
 * API/dashboard/pendingActions.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Pending-action badges for the ILP dashboard CRM. Stored on the client doc
 * (flat `clients` collection), matching ILP's data model.
 */

import type { Request, Response } from "express";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import log from "../../helper/log.ts";

const CLIENTS_COLLECTION = "clients";

export interface PendingAction {
  actionId: string;
  type: string;
  tab: string;
  title: string;
  priority: "high" | "normal" | "low";
  assignedTo: string[];
  triggeredBy: string;
  triggeredAt: string;
  status: "pending" | "done" | "dismissed";
  resolvedAt?: string;
  resolvedBy?: string;
  meta?: Record<string, unknown>;
}

function newActionId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 16; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

export async function addPendingAction(
  docId: string,
  input: Omit<PendingAction, "actionId" | "triggeredAt" | "status">,
): Promise<PendingAction> {
  const doc = await get(CLIENTS_COLLECTION, docId);
  const existing: PendingAction[] = Array.isArray(doc?.pendingActions)
    ? (doc.pendingActions as PendingAction[])
    : [];

  const action: PendingAction = {
    ...input,
    actionId: newActionId(),
    triggeredAt: new Date().toISOString(),
    status: "pending",
  };

  await put(CLIENTS_COLLECTION, docId, {
    pendingActions: [...existing, action],
  });

  return action;
}

export async function resolvePendingAction(
  docId: string,
  actionId: string,
  resolution: "done" | "dismissed",
  resolvedBy: string,
): Promise<void> {
  const doc = await get(CLIENTS_COLLECTION, docId);
  const existing: PendingAction[] = Array.isArray(doc?.pendingActions)
    ? (doc.pendingActions as PendingAction[])
    : [];

  const updated = existing.map((a) =>
    a.actionId === actionId
      ? {
          ...a,
          status: resolution,
          resolvedAt: new Date().toISOString(),
          resolvedBy,
        }
      : a,
  );

  await put(CLIENTS_COLLECTION, docId, { pendingActions: updated });
}

export async function handleAddPendingAction(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = req.params;
  const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "system";
  const { type, tab, title, priority, assignedTo, meta } = req.body ?? {};

  if (!type || !title) {
    res.status(400).json({ error: "type and title are required." });
    return;
  }

  const doc = await get(CLIENTS_COLLECTION, id);
  if (!doc) {
    res.status(404).json({ error: "Client not found." });
    return;
  }

  const cleanAssigned: string[] = Array.isArray(assignedTo)
    ? [...new Set(assignedTo.filter((e: unknown) => typeof e === "string" && e.includes("@")))]
    : [];

  const action = await addPendingAction(id, {
    type: String(type),
    tab: typeof tab === "string" ? tab : "overview",
    title: String(title),
    priority: priority === "high" || priority === "low" ? priority : "normal",
    assignedTo: cleanAssigned,
    triggeredBy: actor,
    meta: meta && typeof meta === "object" ? (meta as Record<string, unknown>) : undefined,
  });

  log(`[dashboard] Pending action added to ${id} by ${actor}`);
  res.json({ success: true, action });
}

export async function handleResolvePendingAction(
  req: Request,
  res: Response,
): Promise<void> {
  const { id, actionId } = req.params;
  const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "system";
  const { resolution } = req.body ?? {};

  if (resolution !== "done" && resolution !== "dismissed") {
    res.status(400).json({ error: "resolution must be 'done' or 'dismissed'." });
    return;
  }

  const doc = await get(CLIENTS_COLLECTION, id);
  if (!doc) {
    res.status(404).json({ error: "Client not found." });
    return;
  }

  await resolvePendingAction(id, actionId, resolution, actor);
  log(`[dashboard] Pending action ${actionId} resolved (${resolution}) by ${actor}`);
  res.json({ success: true });
}