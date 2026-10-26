/**
 * jobs/deadlinePushSweep.ts — browser push notifications for saved deadlines.
 * ──────────────────────────────────────────────────────────────────────────
 * Reads every client doc with a `deadlines` map (written by the client-status
 * portal), resolves each priority's reminder offsets, and sends a Web Push
 * notification when a deadline lands on one of its reminder offsets.
 *
 * Idempotent via a per-deadline `lastPushAt` stamp stored on the deadline
 * entry: a given (priority, date) fires at most once per offset day. The
 * sweep is index-free (lists all clients and filters in memory), matching the
 * dashboard metrics path.
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

const CLIENTS_COLLECTION = "clients";
const SUBSCRIPTIONS_COLLECTION = "push_subscriptions";
const DAY_MS = 86_400_000;
const FRONTEND_URL = Deno.env.get("FRONTEND_URL") ?? "http://localhost:3000";

interface DeadlineEntry {
  priorityId: string;
  date: string; // YYYY-MM-DD
  note?: string;
  updatedAt?: string;
  lastPushAt?: string;
  [key: string]: unknown;
}

/** Days from now until a YYYY-MM-DD date (negative when past). */
function daysUntil(dateStr: string, now: Date): number {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return Number.NaN;
  return Math.round((d.getTime() - now.getTime()) / DAY_MS);
}

/** The date key for a given offset day, used to dedupe pushes. */
function offsetKey(dateStr: string, offset: number): string {
  return `${dateStr}__${offset}`;
}

export async function deadlinePushSweep(): Promise<void> {
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
    if (!subscription) continue;

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
      if (Number.isNaN(days) || days < 0) continue;

      const offsets = priority.reminderOffsetsDays ?? [];
      const matchingOffset = offsets.find((o) => o === days);
      if (matchingOffset === undefined) continue;

      const dedupeKey = offsetKey(entry.date, matchingOffset);
      if (entry.lastPushAt === dedupeKey) continue;

      const title = priority.title;
      const body =
        days === 0
          ? `${priority.title} is due today.`
          : `${priority.title} is due in ${days} day${days === 1 ? "" : "s"}.`;

      const result = await sendPushNotification(subscription, {
        title: "Deadline reminder",
        body,
        url: `${FRONTEND_URL}/status`,
      }).catch((err) => {
        log(`[deadlinePush] send error for ${email}: ${err instanceof Error ? err.message : err}`, "deadlinePush");
        return { ok: false, gone: false };
      });

      if (result.gone) {
        await remove(SUBSCRIPTIONS_COLLECTION, emailToDocId(email)).catch(() => {});
        removed++;
        break; // subscription is dead; stop processing this client
      }

      if (result.ok) {
        updatedDeadlines[key] = { ...entry, lastPushAt: dedupeKey };
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
    `[deadlinePush] sweep complete — ${sent} push(es) sent, ${removed} stale subscription(s) removed`,
    "deadlinePush",
  );
}