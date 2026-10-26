/**
 * jobs/retentionSweep.ts — daily member messages (P2).
 * ──────────────────────────────────────────────────────────────────────────
 * Runs once a day at 08:00 Costa Rica time (registry cron "0 14 * * *": the
 * server runs in UTC and Costa Rica is UTC-6 all year, no daylight saving).
 * Every message is idempotent per member per message (see API/retention/mailer.ts),
 * so a re-run or a missed day never double-sends.
 *
 *   1. Dunning: payment failed day 3 / 6, access paused day 7 (transactional).
 *   2. Retention (API/retention/retentionMessages.ts, respects emailOptOut):
 *      obligations at 30 / 7 days, monthly check-in + 0-10 question,
 *      5-day booking nudge, next-step changed.
 */

import log from "../helper/log.ts";
import { dunningSweep, installLifecycleEmailHooks } from "../API/retention/lifecycleEmails.ts";
import { retentionMessagesSweep } from "../API/retention/retentionMessages.ts";

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
  try {
    Object.assign(out, await retentionMessagesSweep(now));
  } catch (err) {
    out.retention = -1;
    log(`[retentionSweep] retention failed: ${err instanceof Error ? err.message : err}`, "error");
  }
  log(`[retentionSweep] ${JSON.stringify(out)}`, "retention");
  return out;
}
