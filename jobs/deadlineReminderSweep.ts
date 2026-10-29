/**
 * jobs/deadlineReminderSweep.ts — client-record dates into obligations (COMMS-P4).
 * ──────────────────────────────────────────────────────────────────────────
 * Until COMMS-P4 this sweep emailed (`filing_deadline_reminder`) and pushed
 * reminders for the customer-facing `clients.deadlines` map, next to the
 * obligations reminders (30 and 7 days), so one date could produce two
 * emails. Now there is one reminder system: this sweep bridges every date on
 * the client record into the obligations collection
 * (API/members/legacyDeadlines.ts, non-destructive: the map is never changed)
 * and the daily retention sweep sends the reminders, email and push, once
 * per date and stage (API/retention/retentionMessages.ts).
 *
 * What stays here: an overdue date still opens a staff pending action
 * ("Deadline is OVERDUE"), once per date.
 *
 * Runs daily (registry "0 8 * * *", 02:00 Costa Rica), before the retention
 * sweep (08:00 Costa Rica). Index-free: lists clients and filters in memory.
 * `daysUntil` and `currentBucket` are kept (pure, tested) for older callers.
 */

import getAll from "../db/getAll.ts";
import log from "../helper/log.ts";
import { priorityById, countryCodeFromName } from "../API/countries/countryCatalog.ts";
import { addPendingAction } from "../API/dashboard/pendingActions.ts";
import { bridgeClientDeadlines } from "../API/members/legacyDeadlines.ts"; // COMMS-P4

const CLIENTS_COLLECTION = "clients";
const DAY_MS = 86_400_000;

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

export async function deadlineReminderSweep(now: Date = new Date()): Promise<{ bridged: number; updated: number; overdue: number }> {
  const clients = await getAll(CLIENTS_COLLECTION).catch(() => []);
  let bridged = 0;
  let updated = 0;
  let overdue = 0;

  for (const doc of clients) {
    const id = String(doc.id ?? "");
    if (!id) continue;
    // COMMS-P4: mirror the record's dates into obligations (they send the reminders).
    const r = await bridgeClientDeadlines({ ...(doc as Record<string, unknown>), id }, now);
    bridged += r.created;
    updated += r.updated;

    const deadlines = (doc.deadlines ?? {}) as Record<string, DeadlineEntry>;
    const countryCode = countryCodeFromName((doc as Record<string, unknown>).jurisdiction);
    for (const entry of Object.values(deadlines)) {
      if (!entry || typeof entry.date !== "string") continue;
      const priority = priorityById(entry.priorityId);
      if (!priority) continue;
      // Only priorities for the client's own jurisdiction are actionable.
      if (countryCode && priority.country !== countryCode) continue;
      const days = daysUntil(entry.date, now);
      if (Number.isNaN(days) || days >= 0) continue;
      // Overdue → staff escalation (no member email: the obligation reminders came before the date).
      await addOverdueAction(
        id,
        doc as Record<string, unknown>,
        `Deadline is OVERDUE: ${priority.title} (${entry.date})`,
        {
          deadline: entry.date,
          priorityId: entry.priorityId,
          sweepKey: `deadline_overdue_${entry.priorityId}_${entry.date}`,
        },
      );
      overdue++;
    }
  }

  log(
    `[deadlineReminder] sweep complete: ${bridged} date(s) bridged into obligations, ${updated} updated, ${overdue} overdue`,
    "deadlineReminder",
  );
  return { bridged, updated, overdue };
}
