import { Cron } from "croner";
import { jobs } from "./registry.ts";
import log from "../helper/log.ts";

/**
 * Schedules every job in the registry using croner. Each handler is wrapped
 * so a rejection is logged, never fatal, keeping the server alive.
 * Mirrors IRP-funnel's centralized cron path (CRON_RUNNER_ENABLED).
 */
export function startCronRunner(): void {
  for (const job of jobs) {
    new Cron(job.cron, async () => {
      try {
        await job.handler();
      } catch (err) {
        log(
          `[cron] ${job.name} failed: ${
            err instanceof Error ? err.message : err
          }`,
          "cronRunner",
        );
      }
    });
    log(`[cron] scheduled "${job.name}" (${job.cron})`, "cronRunner");
  }
}