import { Cron } from "croner";
import { jobs } from "./registry.ts";
import log from "../helper/log.ts";
import put from "../db/put.ts";

/**
 * Schedules every job in the registry using croner. Each handler is wrapped
 * so a rejection is logged, never fatal, keeping the server alive.
 * Mirrors IRP-funnel's centralized cron path (CRON_RUNNER_ENABLED).
 *
 * Each run also persists a heartbeat to `cronState/{jobName}` so operators
 * can verify the scheduler is alive and see the last run timestamp.
 */
export function startCronRunner(): void {
  for (const job of jobs) {
    new Cron(job.cron, async () => {
      try {
        await job.handler();
        await recordHeartbeat(job.name, "ok");
      } catch (err) {
        log(
          `[cron] ${job.name} failed: ${
            err instanceof Error ? err.message : err
          }`,
          "cronRunner",
        );
        await recordHeartbeat(job.name, "error");
      }
    });
    log(`[cron] scheduled "${job.name}" (${job.cron})`, "cronRunner");
  }
}

async function recordHeartbeat(name: string, status: "ok" | "error"): Promise<void> {
  try {
    await put("cronState", name, {
      lastRanAt: new Date().toISOString(),
      status,
    });
  } catch (_err) {
    // Non-fatal: a heartbeat failure must never break the scheduler.
  }
}
