/**
 * API/dashboard/clientHelpers.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Client summary + stage computation for the ILP dashboard CRM.
 *
 * Ported from IRP-funnel's `clientHelpers.ts`, retargeted to ILP's legal
 * taxonomy and flat `clients` collection (doc id === email-normalized id).
 * The stage field is `stage` (not IRP's `pipelineStage`), matching the
 * client-status portal.
 */

import getAll, { type FirestoreDocument } from "../../db/getAll.ts";
import { getStageConfigSync, isValidStage } from "./automation/stageConfig.ts";

const CLIENTS_COLLECTION = "clients";

/** Resolve the current stage for a client doc, falling back to `intake`. */
export function computeStage(doc: Record<string, unknown>): string {
  if (typeof doc.stage === "string" && isValidStage(doc.stage)) {
    return doc.stage;
  }
  return "intake";
}

/** Reconstruct the principal email from an email-normalized doc id. */
export function resolveClientEmail(
  doc: Record<string, unknown>,
  docId: string,
): string {
  const drip = doc.dripEmail;
  if (typeof drip === "string" && drip.includes("@")) return drip.toLowerCase().trim();
  const cons = Array.isArray(doc.consultations) ? doc.consultations : [];
  const latest = (cons[cons.length - 1] ?? {}) as Record<string, unknown>;
  if (typeof latest.email === "string" && latest.email.includes("@")) {
    return latest.email.toLowerCase().trim();
  }
  const dotted = docId.replace(/_/g, ".");
  const parts = dotted.split(".");
  if (parts.length >= 2) {
    const tld = parts.pop();
    const dom = parts.pop();
    const user = parts.join(".");
    return `${user}@${dom}.${tld}`.toLowerCase().trim();
  }
  return dotted.toLowerCase().trim();
}

/** Build the CRM-facing summary of a client doc. */
export function buildClientSummary(
  docId: string,
  doc: Record<string, unknown>,
  viewerIsAdmin = false,
): Record<string, unknown> {
  const cons = Array.isArray(doc.consultations) ? doc.consultations : [];
  const latest = (cons[cons.length - 1] ?? {}) as Record<string, unknown>;
  const pick = (key: string) => {
    const v = latest[key] !== undefined ? latest[key] : doc[key];
    return v ?? null;
  };

  const notes = (Array.isArray(doc.notes) ? doc.notes : []).filter(
    (n) => viewerIsAdmin || !(n as Record<string, unknown>).deletedAt,
  );

  const pendingActions = Array.isArray(doc.pendingActions)
    ? doc.pendingActions
    : [];

  return {
    id: docId,
    email: resolveClientEmail(doc, docId),
    name: pick("name"),
    surname: pick("surname"),
    phone: pick("phone"),
    legalArea: pick("legalArea"),
    legalMatter: pick("legalMatter"),
    jurisdiction: pick("jurisdiction"),
    documents: pick("documents"),
    stage: computeStage(doc),
    stageEnteredAt: doc.stageEnteredAt ?? null,
    notes,
    activityLog: Array.isArray(doc.activityLog) ? doc.activityLog : [],
    pendingActions,
    pendingCount: pendingActions.filter(
      (a) => (a as Record<string, unknown>).status === "pending",
    ).length,
    quotes: Array.isArray(doc.quotes) ? doc.quotes : [],
    charges: Array.isArray(doc.charges) ? doc.charges : [],
    transcript: typeof doc.transcript === "string" ? doc.transcript : null,
    transcriptInsights: (doc.transcriptInsights ?? null) as Record<string, unknown> | null,
    stageRatings: (doc.stageRatings ?? {}) as Record<string, unknown>,
    quoteAcceptance: doc.quoteAcceptance ?? null,
    statusChatThread: Array.isArray(doc.statusChatThread)
      ? doc.statusChatThread
      : [],
    customFields: (doc.customFields ?? {}) as Record<string, unknown>,
    source: doc.source ?? null,
    createdAt: doc.createdAt ?? null,
    lastUpdated: doc.updatedAt ?? doc.createdAt ?? null,
  };
}

/** Fetch every client doc with its id. */
export async function fetchAllClientsWithIds(): Promise<
  Array<{ docId: string; data: Record<string, unknown> }>
> {
  const docs: FirestoreDocument[] = await getAll(CLIENTS_COLLECTION).catch(
    () => [],
  );
  return docs
    .filter((d) => d && d.id)
    .map((d) => ({ docId: String(d.id), data: d as Record<string, unknown> }));
}

/** Ordered stage ids (for the kanban columns). */
export function getStageIds(): string[] {
  return getStageConfigSync()
    .filter((s) => s.active !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((s) => s.id);
}

/** Ordered `{ id, label }` pairs for the kanban columns. */
export function getStageLabels(): Array<{ id: string; label: string }> {
  return getStageConfigSync()
    .filter((s) => s.active !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((s) => ({ id: s.id, label: s.label }));
}