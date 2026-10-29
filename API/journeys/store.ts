/**
 * API/journeys/store.ts — Firestore reads and writes for the journeys module.
 * Ranges use single-field filters on `at` / `day` / `sentAt` (automatic
 * indexes); equality lookups use `experiment`, `visitorId` and
 * `journeyTrack.furthestStep`. Composite indexes for later server-side
 * ordering are declared in firestore.indexes.json.
 */

import get from "../../db/get.ts";
import put from "../../db/put.ts";
import query from "../../db/query.ts";
import remove from "../../db/delete.ts";
import replace from "../../db/replace.ts";
import { commitDocuments, runStructuredQuery } from "../../helper/firestore/firestoreService.ts";
import { toFirestoreValue } from "../../helper/firestore/toFirestoreValue.ts";
import { clean } from "../../db/records.ts";
import {
  COLLECTIONS,
  type Experiment,
  type JourneyDaily,
  type JourneyEvent,
  type JourneyExposure,
  type Outreach,
} from "../../schemas/contracts.ts";

type Doc = Record<string, unknown>;

/** Most raw events a live (today) read scans. */
export const LIVE_EVENT_LIMIT = 20000;

const asList = <T>(rows: unknown[]): T[] => rows as T[];

export async function eventsBetween(fromIso: string, toIso: string, limit = LIVE_EVENT_LIMIT): Promise<JourneyEvent[]> {
  const rows = await runStructuredQuery(COLLECTIONS.journeyEvents, {
    from: [{ collectionId: COLLECTIONS.journeyEvents }],
    where: {
      compositeFilter: {
        op: "AND",
        filters: [
          { fieldFilter: { field: { fieldPath: "at" }, op: "GREATER_THAN_OR_EQUAL", value: toFirestoreValue(fromIso) } },
          { fieldFilter: { field: { fieldPath: "at" }, op: "LESS_THAN", value: toFirestoreValue(toIso) } },
        ],
      },
    },
    orderBy: [{ field: { fieldPath: "at" }, direction: "ASCENDING" }],
    limit,
  });
  return asList<JourneyEvent>(rows);
}

/** Every event of one UTC day, read in pages (aggregation job). */
export async function eventsOfDay(day: string, pageSize = 5000, maxEvents = 200_000): Promise<JourneyEvent[]> {
  const end = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString();
  const seen = new Map<string, JourneyEvent>();
  let from = `${day}T00:00:00.000Z`;
  for (;;) {
    const page = await eventsBetween(from, end, pageSize);
    let fresh = 0;
    for (const e of page) if (!seen.has(e.id)) (seen.set(e.id, e), fresh++);
    if (page.length < pageSize || !fresh || seen.size >= maxEvents) break;
    from = page[page.length - 1].at;
  }
  return [...seen.values()];
}

export async function eventsOfVisitor(visitorId: string): Promise<JourneyEvent[]> {
  return asList<JourneyEvent>(await query(COLLECTIONS.journeyEvents, [{ field: "visitorId", op: "EQUAL", value: visitorId }]));
}

export async function saveEvents(events: JourneyEvent[]): Promise<void> {
  if (!events.length) return;
  await commitDocuments(COLLECTIONS.journeyEvents, events.map((e) => ({ id: e.id, data: clean(e) as unknown as Doc })));
}

export async function dailyBetween(fromDay: string, toDay: string): Promise<JourneyDaily[]> {
  return asList<JourneyDaily>(await query(COLLECTIONS.journeyDaily, [
    { field: "day", op: "GREATER_THAN_OR_EQUAL", value: fromDay },
    { field: "day", op: "LESS_THAN_OR_EQUAL", value: toDay },
  ]));
}

/** Replace one day's aggregate rows: write the new ones, delete the day's rows that are gone. */
export async function replaceDay(day: string, rows: JourneyDaily[]): Promise<{ written: number; removed: number }> {
  const keep = new Set(rows.map((r) => r.id));
  const old = await dailyBetween(day, day).catch(() => [] as JourneyDaily[]);
  await commitDocuments(COLLECTIONS.journeyDaily, rows.map((r) => ({ id: r.id, data: clean(r) as unknown as Doc })));
  let removed = 0;
  for (const o of old) {
    if (keep.has(o.id)) continue;
    await remove(COLLECTIONS.journeyDaily, o.id).catch(() => false);
    removed++;
  }
  return { written: rows.length, removed };
}

export async function exposuresOf(experimentKey: string): Promise<JourneyExposure[]> {
  return asList<JourneyExposure>(await query(COLLECTIONS.journeyExposures, [{ field: "experiment", op: "EQUAL", value: experimentKey }]));
}

export async function saveExposures(list: JourneyExposure[]): Promise<void> {
  if (!list.length) return;
  await commitDocuments(COLLECTIONS.journeyExposures, list.map((x) => ({ id: x.id, data: clean(x) as unknown as Doc })));
}

// ─── Experiments ──────────────────────────────────────────────────────────

let runningCache: { at: number; list: Experiment[] } | null = null;
export const clearExperimentCache = () => (runningCache = null);

export async function listExperiments(): Promise<Experiment[]> {
  const rows = await query(COLLECTIONS.experiments, []);
  return asList<Experiment>(rows).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Running experiments, cached for 60 s (public assign route). */
export async function runningExperiments(now = Date.now()): Promise<Experiment[]> {
  if (runningCache && now - runningCache.at < 60_000) return runningCache.list;
  const list = asList<Experiment>(await query(COLLECTIONS.experiments, [{ field: "status", op: "EQUAL", value: "running" }]));
  runningCache = { at: now, list };
  return list;
}

export async function getExperiment(id: string): Promise<Experiment | null> {
  const d = await get(COLLECTIONS.experiments, id);
  return d ? ({ ...(d as Doc), id } as unknown as Experiment) : null;
}

export async function saveExperiment(e: Experiment): Promise<void> {
  await replace(COLLECTIONS.experiments, e.id, clean(e) as unknown as Doc);
  clearExperimentCache();
}

export async function deleteExperiment(id: string): Promise<void> {
  await remove(COLLECTIONS.experiments, id);
  clearExperimentCache();
}

// ─── Outreach ─────────────────────────────────────────────────────────────

const outreachCache = new Map<string, { at: number; o: Outreach | null }>();

export async function getOutreach(id: string, cached = false): Promise<Outreach | null> {
  const hit = outreachCache.get(id);
  if (cached && hit && Date.now() - hit.at < 600_000) return hit.o;
  const d = await get(COLLECTIONS.outreach, id).catch(() => null);
  const o = d ? ({ ...(d as Doc), id } as unknown as Outreach) : null;
  if (outreachCache.size > 5000) outreachCache.clear();
  outreachCache.set(id, { at: Date.now(), o });
  return o;
}

export async function saveOutreach(o: Outreach): Promise<void> {
  await put(COLLECTIONS.outreach, o.id, clean(o) as unknown as Doc);
  outreachCache.delete(o.id);
}

export async function patchOutreach(id: string, fields: Partial<Outreach>): Promise<void> {
  await put(COLLECTIONS.outreach, id, clean(fields) as unknown as Doc);
  outreachCache.delete(id);
}

export async function outreachBetween(fromIso: string, toIso: string): Promise<Outreach[]> {
  return asList<Outreach>(await query(COLLECTIONS.outreach, [
    { field: "sentAt", op: "GREATER_THAN_OR_EQUAL", value: fromIso },
    { field: "sentAt", op: "LESS_THAN", value: toIso },
  ]));
}
