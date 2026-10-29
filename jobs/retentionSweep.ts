/**
 * jobs/retentionSweep.ts — daily member messages (P2).
 * ──────────────────────────────────────────────────────────────────────────
 * Runs once a day at 08:00 Costa Rica time (registry cron "0 14 * * *": the
 * server runs in UTC and Costa Rica is UTC-6 all year, no daylight saving).
 * Every message is idempotent per member per message (see API/retention/mailer.ts),
 * so a re-run or a missed day never double-sends.
 *
 *   1. Dunning: payment failed day 3 / 6, access paused day 7 (transactional).
 *      Renewal notice 7 days before each renewal (transactional, COMMS-P1).
 *   2. Retention (API/retention/retentionMessages.ts, respects emailOptOut):
 *      obligations at 30 / 7 days, monthly check-in + 0-10 question,
 *      5-day booking nudge, next-step changed, COMMS-P4 missing document (3 days).
 *   3. COMMS-P4: quote unanswered 5 days (closingLoops.ts), every client with a waiting quote.
 */

import log from "../helper/log.ts";
import { dunningSweep, installLifecycleEmailHooks, renewalNoticeSweep } from "../API/retention/lifecycleEmails.ts";
import { retentionMessagesSweep } from "../API/retention/retentionMessages.ts";
import { quoteReminderSweep } from "../API/retention/closingLoops.ts"; // COMMS-P4

export async function retentionSweep(now: Date = new Date()): Promise<Record<string, number>> {
  installLifecycleEmailHooks();
  const out: Record<string, number> = {};
  const step = async (name: string, fn: () => Promise<number>) => {
    try {
      out[name] = await fn();
    } catch (err) {
      out[name] = -1;
      log(`[retentionSweep] ${name} failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  };
  await step("dunning", () => dunningSweep(now));
  await step("renewalNotices", () => renewalNoticeSweep(now));
  try {
    Object.assign(out, await retentionMessagesSweep(now));
  } catch (err) {
    out.retention = -1;
    log(`[retentionSweep] retention failed: ${err instanceof Error ? err.message : err}`, "error");
  }
  // COMMS-P4: quotes waiting 5 days get one reminder each (service email).
  await step("quoteReminders", () => quoteReminderSweep(now));
  log(`[retentionSweep] ${JSON.stringify(out)}`, "retention");
  return out;
}
