/**
 * jobs/journeyAggregate.ts — JOURNEYS daily aggregates (hourly, minute 7 UTC).
 * ──────────────────────────────────────────────────────────────────────────
 * Rebuilds journey_daily for today (UTC) every hour and for yesterday during
 * the first three hours of the day (late beacons), and merges the day's
 * experiment exposures into journey_exposures. Re-running a day gives the
 * same documents (ids are deterministic; rows that disappeared are deleted),
 * so the job is safe to repeat. Staff routes read these rows for past days
 * and compute today live from raw events.
 *
 * Raw events older than JOURNEY_RAW_RETENTION_DAYS (13 months) are deleted by
 * jobs/privacyRetention.ts; the daily rows hold no personal data and stay.
 */

import log from "../helper/log.ts";
import type { Experiment, JourneyDaily, JourneyEvent, JourneyExposure } from "../schemas/contracts.ts";
import { buildDay, mergeExposures } from "../API/journeys/aggregate.ts";
import { eventsOfDay, exposuresOf, listExperiments, replaceDay, saveExposures } from "../API/journeys/store.ts";

export interface AggregateStore {
  eventsOfDay(day: string): Promise<JourneyEvent[]>;
  replaceDay(day: string, rows: JourneyDaily[]): Promise<{ written: number; removed: number }>;
  experiments(): Promise<Experiment[]>;
  exposures(key: string): Promise<JourneyExposure[]>;
  saveExposures(list: JourneyExposure[]): Promise<void>;
}

export const firestoreAggregateStore: AggregateStore = {
  eventsOfDay: (day) => eventsOfDay(day),
  replaceDay,
  experiments: listExperiments,
  exposures: exposuresOf,
  saveExposures,
};

/** Experiments whose variants count for `day`: running, paused, or ended on or after that day. */
export function activeKeys(list: Experiment[], day: string): Set<string> {
  return new Set(list.filter((e) => e.status === "running" || e.status === "paused" || (e.status === "ended" && (e.endedAt ?? "") >= day)).map((e) => e.key));
}

export async function aggregateDay(day: string, store: AggregateStore, now: Date = new Date()): Promise<{ rows: number; removed: number; exposures: number; events: number }> {
  const events = await store.eventsOfDay(day);
  const experiments = await store.experiments();
  const keys = activeKeys(experiments, day);
  const built = buildDay(events, day, now.toISOString(), keys);
  const { written, removed } = await store.replaceDay(day, built.daily);
  let exposures = 0;
  for (const key of keys) {
    const fresh = built.exposures.filter((x) => x.experiment === key);
    if (!fresh.length) continue;
    const stored = new Map((await store.exposures(key)).map((x) => [x.id, x]));
    const changed = mergeExposures(stored, fresh);
    await store.saveExposures(changed);
    exposures += changed.length;
  }
  return { rows: written, removed, exposures, events: events.length };
}

export async function journeyAggregate(now: Date = new Date(), store: AggregateStore = firestoreAggregateStore): Promise<void> {
  const today = now.toISOString().slice(0, 10);
  const days = now.getUTCHours() < 3 ? [new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10), today] : [today];
  for (const day of days) {
    try {
      const r = await aggregateDay(day, store, now);
      log(`[journeys] ${day}: ${r.events} events → ${r.rows} rows (${r.removed} removed), ${r.exposures} exposures updated`);
    } catch (err) {
      log(`[journeys] aggregation of ${day} failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }
}
