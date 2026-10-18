/**
 * jobs/deadlineFollowup.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Deadline follow-up cron sweep (Segment 1.2 + 1.3).
 *
 * Reads every client doc with an ACTIVE `deadlineFollowup` loop (written by
 * the `start_deadline_followup_loop` action), figures out whether a reminder is
 * due (cadence-aware, idempotent via `lastRemindedAt`/`nextDueAt` stamps), then
 * applies the escalation ladder:
 *
 *   • overdue        → team email (owner + recipient rules) + high pending action
 *   • ≤ 7 days out   → urgent pending action
 *   • otherwise      → client `filing_deadline_reminder` email on cadence
 *
 * Index-free by design: it lists all clients and filters in memory (matching
 * the dashboard metrics path), so no composite Firestore index is required for
 * the nested `deadlineFollowup.status` field.
 */

import getAll from "../db/getAll.ts";
import patch from "../db/patch.ts";
import log from "../helper/log.ts";
import { enqueueEmail } from "../helper/emailQueue.ts";
import { renderLegalEmail } from "../API/dashboard/automation/renderLegalEmail.ts";
import {
  resolveEmailCc,
  resolveEmailBcc,
} from "../API/dashboard/automation/recipientRules.ts";
import { addPendingAction } from "../API/dashboard/pendingActions.ts";
import { TEAM_CC } from "../helper/team.ts";

const CLIENTS_COLLECTION = "clients";
const DAY_MS = 86_400_000;
const EMAIL_TYPE = "filing_deadline_reminder";

interface DeadlineFollowupState {
  status: string;
  startedAt?: string;
  startedBy?: string;
  deadline?: string;
  ownerEmail?: string | null;
  cadenceDays?: number;
  lastRemindedAt?: string | null;
  nextDueAt?: string | null;
  [key: string]: unknown;
}

/** Resolve the client-facing email, mirroring the dashboard build-email-data precedence. */
function resolveClientEmail(doc: Record<string, unknown>): string {
  const consultations = Array.isArray(doc.consultations)
    ? (doc.consultations as Record<string, unknown>[])
    : [];
  const latest = consultations[consultations.length - 1] as Record<string, unknown> | undefined;
  const candidate = (latest?.email ?? doc.dripEmail ?? doc.email) as string | undefined;
  return typeof candidate === "string" && candidate.includes("@") ? candidate : "";
}

/** Add an urgent/overdue pending action, skipping when an identical open one exists. */
async function addEscalationAction(
  docId: string,
  doc: Record<string, unknown>,
  type: "deadline_urgent" | "deadline_overdue",
  title: string,
  ownerEmail: string | null,
  meta: Record<string, unknown>,
): Promise<void> {
  const existing = Array.isArray(doc.pendingActions)
    ? (doc.pendingActions as Array<Record<string, unknown>>)
    : [];
  const alreadyOpen = existing.some(
    (a) =>
      a?.status === "pending" &&
      a?.type === type &&
      ((a?.meta as Record<string, unknown> | undefined)?.sweepKey === meta.sweepKey),
  );
  if (alreadyOpen) return;

  await addPendingAction(docId, {
    type,
    tab: "overview",
    title,
    priority: "high",
    assignedTo: ownerEmail ? [ownerEmail] : [],
    triggeredBy: "deadline_followup_sweep",
    meta,
  });
}

export async function deadlineFollowupSweep(): Promise<void> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const clients = await getAll(CLIENTS_COLLECTION).catch(() => []);

  let processed = 0;
  for (const doc of clients) {
    const followup = doc.deadlineFollowup as DeadlineFollowupState | undefined;
    if (!followup || followup.status !== "active") continue;

    const deadlineStr =
      typeof followup.deadline === "string" && followup.deadline
        ? followup.deadline
        : typeof doc.filingDeadline === "string"
          ? doc.filingDeadline
          : null;
    if (!deadlineStr) continue;

    const deadlineMs = new Date(deadlineStr).getTime();
    if (Number.isNaN(deadlineMs)) continue;

    const cadenceDays = Number.isFinite(Number(followup.cadenceDays))
      ? Number(followup.cadenceDays)
      : 1;
    const cadenceMs = Math.max(cadenceDays, 1) * DAY_MS;

    // Due-check: use the persisted nextDueAt when present; otherwise derive from
    // the last reminder (or the loop start) + cadence.
    const dueMs = followup.nextDueAt
      ? new Date(followup.nextDueAt).getTime()
      : followup.lastRemindedAt
        ? new Date(followup.lastRemindedAt).getTime() + cadenceMs
        : (followup.startedAt ? new Date(followup.startedAt).getTime() : nowMs) + cadenceMs;

    if (Number.isNaN(dueMs) || nowMs < dueMs) continue;

    const daysOut = Math.round((deadlineMs - nowMs) / DAY_MS);
    const ownerEmail =
      typeof followup.ownerEmail === "string" && followup.ownerEmail.includes("@")
        ? followup.ownerEmail
        : null;
    const clientEmail = resolveClientEmail(doc);
    const emailData: Record<string, unknown> = {
      ...doc,
      name: doc.name ?? clientEmail ?? "Client",
      filingDeadline: deadlineStr,
    };

    // ── Overdue → team escalation, then stop the loop ────────────────────────
    if (deadlineMs <= nowMs) {
      await addEscalationAction(
        doc.id,
        doc,
        "deadline_overdue",
        `Filing deadline is OVERDUE: ${deadlineStr}`,
        ownerEmail,
        { deadline: deadlineStr, sweepKey: "deadline_overdue" },
      );

      const { subject, bodyHtml } = renderLegalEmail(EMAIL_TYPE, emailData);
      const teamTo = ownerEmail ?? TEAM_CC;
      if (teamTo) {
        await enqueueEmail(
          {
            to: teamTo,
            subject: `[Overdue filing] ${subject}`,
            html: bodyHtml,
            cc: resolveEmailCc(EMAIL_TYPE),
            bcc: resolveEmailBcc(EMAIL_TYPE),
          },
          `deadline_overdue_${doc.id}`,
        );
      }

      await patch(CLIENTS_COLLECTION, doc.id, {
        deadlineFollowup: {
          ...followup,
          status: "overdue",
          overdueAt: nowIso,
          lastRemindedAt: nowIso,
          nextDueAt: null,
        },
        updatedAt: nowIso,
      });
      processed++;
      log(
        `[deadlineFollowup] flagged overdue ${doc.id} (deadline ${deadlineStr})`,
        "deadlineFollowup",
      );
      continue;
    }

    // ── ≤ 7 days out → urgent pending action ────────────────────────────────
    if (daysOut <= 7) {
      await addEscalationAction(
        doc.id,
        doc,
        "deadline_urgent",
        `Filing deadline in ${Math.max(daysOut, 0)} day(s): ${deadlineStr}`,
        ownerEmail,
        { deadline: deadlineStr, daysOut, sweepKey: "deadline_urgent" },
      );
    }

    // ── Client-facing reminder on cadence ────────────────────────────────────
    if (clientEmail) {
      const { subject, bodyHtml } = renderLegalEmail(EMAIL_TYPE, emailData);
      await enqueueEmail(
        {
          to: clientEmail,
          subject,
          html: bodyHtml,
          cc: resolveEmailCc(EMAIL_TYPE),
          bcc: resolveEmailBcc(EMAIL_TYPE),
        },
        `deadline_followup_${doc.id}_${nowMs}`,
      );
    }

    await patch(CLIENTS_COLLECTION, doc.id, {
      deadlineFollowup: {
        ...followup,
        lastRemindedAt: nowIso,
        nextDueAt: new Date(nowMs + cadenceMs).toISOString(),
      },
      updatedAt: nowIso,
    });
    processed++;
  }

  log(`[deadlineFollowup] sweep complete — ${processed} reminder(s)`, "deadlineFollowup");
}