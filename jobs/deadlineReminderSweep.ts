/**
 * jobs/deadlineReminderSweep.ts — unified deadline reminders (email + push).
 * ──────────────────────────────────────────────────────────────────────────
 * The single notifier for the customer-facing `deadlines` map (written by the
 * client-status portal). Reads every client doc, resolves each priority's
 * reminder offsets, and fires BOTH an email and a browser push when a deadline
 * crosses one of its reminder thresholds.
 *
 * Threshold-based (not exact-day) so a missed cron run cannot silently skip a
 * reminder: the sweep fires the most recent threshold that has been crossed
 * (the smallest offset `o` where days-until <= o), which is always the most
 * relevant reminder. A final "due today" (offset 0) is always included.
 *
 * Idempotent via a per-deadline `remindedOffsets` array: a given
 * (priority, date, offset) fires at most once. Email dedupe is handled by the
 * queue's deterministic dedupe key. Index-free by design.
 */

import getAll from "../db/getAll.ts";
import patch from "../db/patch.ts";
import log from "../helper/log.ts";
import get from "../db/get.ts";
import remove from "../db/delete.ts";
import { resolveClientEmail } from "../API/dashboard/clientHelpers.ts";
import { priorityById, countryCodeFromName } from "../API/countries/countryCatalog.ts";
import { sendPushNotification, type PushSubscription } from "../config/push.ts";
import { emailToDocId } from "../helper/auth/otp.ts";
import { enqueueEmail } from "../helper/emailQueue.ts";
import { renderLegalEmail } from "../API/dashboard/automation/renderLegalEmail.ts";
import { addPendingAction } from "../API/dashboard/pendingActions.ts";

const CLIENTS_COLLECTION = "clients";
const SUBSCRIPTIONS_COLLECTION = "push_subscriptions";
const DAY_MS = 86_400_000;
const FRONTEND_URL = Deno.env.get("FRONTEND_URL") ?? "http://localhost:3000";
const EMAIL_TYPE = "filing_deadline_reminder";

interface DeadlineEntry {
  priorityId: string;
  date: string; // YYYY-MM-DD
  note?: string;
  updatedAt?: string;
  remindedEmailOffsets?: number[];
  remindedPushOffsets?: number[];
  [key: string]: unknown;
}

/**
 * Whole calendar days from "today" until a YYYY-MM-DD date (negative when
 * past). Uses UTC calendar dates, not exact timestamps, so a deadline due
 * tomorrow is always 1 day away regardless of the time of day the sweep runs.
 */
export function daysUntil(dateStr: string, now: Date): number {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return Number.NaN;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((d.getTime() - today) / DAY_MS);
}

/**
 * The most recent reminder threshold that has been crossed: the smallest
 * offset `o` such that `days <= o`. Returns null when the deadline is past or
 * no threshold has been reached yet. A 0 (due today) offset is always included.
 *
 * Example with offsets [180, 120, 90, 60, 30]:
 *   days=180 → 180 (just crossed the 180-day mark)
 *   days=150 → 180 (past 180, not yet 120)
 *   days=30  → 30  (past 60, now at 30)
 *   days=0   → 0   (due today)
 */
export function currentBucket(offsets: number[], days: number): number | null {
  if (days < 0) return null;
  const all = [...new Set([...offsets, 0])].sort((a, b) => a - b);
  for (const o of all) {
    if (days <= o) return o;
  }
  return null;
}

/** Add an overdue pending action, skipping when an identical open one exists. */
async function addOverdueAction(
  docId: string,
  doc: Record<string, unknown>,
  title: string,
  meta: Record<string, unknown>,
): Promise<void> {
  const existing = Array.isArray(doc.pendingActions)
    ? (doc.pendingActions as Array<Record<string, unknown>>)
    : [];
  const alreadyOpen = existing.some(
    (a) =>
      a?.status === "pending" &&
      a?.type === "deadline_overdue" &&
      ((a?.meta as Record<string, unknown> | undefined)?.sweepKey === meta.sweepKey),
  );
  if (alreadyOpen) return;

  await addPendingAction(docId, {
    type: "deadline_overdue",
    tab: "overview",
    title,
    priority: "high",
    assignedTo: [],
    triggeredBy: "deadline_reminder_sweep",
    meta,
  });
}

export async function deadlineReminderSweep(): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const clients = await getAll(CLIENTS_COLLECTION).catch(() => []);

  let sent = 0;
  let removed = 0;

  for (const doc of clients) {
    const deadlines = (doc.deadlines ?? {}) as Record<string, DeadlineEntry>;
    const entries = Object.entries(deadlines);
    if (entries.length === 0) continue;

    const email = resolveClientEmail(doc as Record<string, unknown>, String(doc.id));
    if (!email) continue;

    const subDoc = await get(SUBSCRIPTIONS_COLLECTION, emailToDocId(email)).catch(() => null);
    const subscription = subDoc?.subscription as PushSubscription | undefined;

    const jurisdiction = (doc as Record<string, unknown>).jurisdiction;
    const countryCode = countryCodeFromName(jurisdiction);

    const updatedDeadlines: Record<string, DeadlineEntry> = { ...deadlines };
    let changed = false;

    for (const [key, entry] of entries) {
      if (!entry || typeof entry.date !== "string") continue;

      const priority = priorityById(entry.priorityId);
      if (!priority) continue;

      // Only priorities for the client's own jurisdiction are actionable.
      if (countryCode && priority.country !== countryCode) continue;

      const days = daysUntil(entry.date, now);
      if (Number.isNaN(days)) continue;

      // ── Overdue → staff escalation, then stop reminding ────────────────────
      if (days < 0) {
        await addOverdueAction(
          String(doc.id),
          doc as Record<string, unknown>,
          `Deadline is OVERDUE: ${priority.title} (${entry.date})`,
          {
            deadline: entry.date,
            priorityId: entry.priorityId,
            sweepKey: `deadline_overdue_${entry.priorityId}_${entry.date}`,
          },
        );
        continue;
      }

      const offsets = priority.reminderOffsetsDays ?? [];
      const bucket = currentBucket(offsets, days);
      if (bucket === null) continue;

      const remindedEmail = Array.isArray(entry.remindedEmailOffsets)
        ? entry.remindedEmailOffsets
        : [];
      const remindedPush = Array.isArray(entry.remindedPushOffsets)
        ? entry.remindedPushOffsets
        : [];

      const body =
        days === 0
          ? `${priority.title} is due today.`
          : `${priority.title} is due in ${days} day${days === 1 ? "" : "s"}.`;

      // ── Email reminder ─────────────────────────────────────────────────────
      let emailProgressed = false;
      if (!remindedEmail.includes(bucket)) {
        try {
          const emailData: Record<string, unknown> = {
            ...(doc as Record<string, unknown>),
            name: (doc as Record<string, unknown>).name ?? email ?? "Client",
            filingDeadline: entry.date,
            statusPageUrl: `${FRONTEND_URL}/status`,
          };
          const { subject, bodyHtml } = renderLegalEmail(EMAIL_TYPE, emailData);
          await enqueueEmail(
            { to: email, subject, html: bodyHtml },
            `deadline_${String(doc.id)}_${entry.priorityId}_${entry.date}_${bucket}`,
          );
          remindedEmail.push(bucket);
          emailProgressed = true;
        } catch (err) {
          log(
            `[deadlineReminder] email enqueue failed for ${email}: ${err instanceof Error ? err.message : err}`,
            "deadlineReminder",
          );
        }
      }

      // ── Push reminder ──────────────────────────────────────────────────────
      let pushProgressed = false;
      if (subscription && !remindedPush.includes(bucket)) {
        const result = await sendPushNotification(subscription, {
          title: "Deadline reminder",
          body,
          url: `${FRONTEND_URL}/status`,
        }).catch((err) => {
          log(
            `[deadlineReminder] push error for ${email}: ${err instanceof Error ? err.message : err}`,
            "deadlineReminder",
          );
          return { ok: false, gone: false };
        });

        if (result.gone) {
          await remove(SUBSCRIPTIONS_COLLECTION, emailToDocId(email)).catch(() => {});
          removed++;
        }
        if (result.ok) {
          remindedPush.push(bucket);
          pushProgressed = true;
        }
      }

      // Persist each channel's progress independently so a partial failure
      // never re-sends the channel that already succeeded.
      if (emailProgressed || pushProgressed) {
        updatedDeadlines[key] = {
          ...entry,
          remindedEmailOffsets: remindedEmail,
          remindedPushOffsets: remindedPush,
        };
        changed = true;
        sent++;
      }
    }

    if (changed) {
      await patch(CLIENTS_COLLECTION, String(doc.id), {
        deadlines: updatedDeadlines,
        updatedAt: nowIso,
      }).catch(() => {});
    }
  }

  log(
    `[deadlineReminder] sweep complete — ${sent} reminder(s) sent, ${removed} stale subscription(s) removed`,
    "deadlineReminder",
  );
}