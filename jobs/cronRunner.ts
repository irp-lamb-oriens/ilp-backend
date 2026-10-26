import { Cron } from "croner";
import { jobs } from "./registry.ts";
import log from "../helper/log.ts";
import put from "../db/put.ts";
import { RateLimiter, createRateLimitedRunner } from "../helper/rateLimit.ts";
import { reportError } from "../helper/errorReporter.ts";

/**
 * Schedules every job in the registry using croner. Each handler is wrapped
 * so a rejection is logged, never fatal, keeping the server alive.
 * Mirrors IRP-funnel's centralized cron path (CRON_RUNNER_ENABLED).
 *
 * Each run also persists a heartbeat to `cronState/{jobName}` so operators
 * can verify the scheduler is alive and see the last run timestamp. Failures
 * also go to reportError (error_log + Sentry when SENTRY_DSN is set).
 */
export function startCronRunner(): void {
  // Shared limiter throttles the aggregate burst of outbound requests across
  // all cron jobs, and the runner retries transient upstream failures (429 /
  // 5xx) with capped exponential backoff.
  const limiter = new RateLimiter({
    windowMs: 10_000,
    maxPerWindow: 5,
  });
  const runGuarded = createRateLimitedRunner(limiter, {
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    multiplier: 2,
    maxRetries: 5,
  });

  for (const job of jobs) {
    new Cron(job.cron, () => runCronJob(job, runGuarded));
    log(`[cron] scheduled "${job.name}" (${job.cron})`, "cronRunner");
  }
}

type JobLike = { name: string; handler: () => Promise<unknown> };

/**
 * One scheduled run: never throws. On failure: log, report the error
 * (kind "job", route "job <name>") and record an error heartbeat.
 * Dependencies are injectable for tests.
 */
export async function runCronJob(
  job: JobLike,
  run: (fn: JobLike["handler"]) => Promise<unknown>,
  deps: {
    report?: typeof reportError;
    heartbeat?: (name: string, status: "ok" | "error") => Promise<void>;
  } = {},
): Promise<"ok" | "error"> {
  const report = deps.report ?? reportError;
  const heartbeat = deps.heartbeat ?? recordHeartbeat;
  try {
    await run(job.handler);
    await heartbeat(job.name, "ok");
    return "ok";
  } catch (err) {
    log(`[cron] ${job.name} failed: ${err instanceof Error ? err.message : err}`, "cronRunner");
    try {
      await report(err, { kind: "job", route: `job ${job.name}` });
    } catch {
      // reportError never throws; belt and braces so the scheduler survives.
    }
    await heartbeat(job.name, "error");
    return "error";
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
