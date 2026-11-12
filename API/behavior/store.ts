/**
 * API/behavior/store.ts — BEHAVIOR: buffer in memory, store totals.
 *
 * Summaries are added to in-memory buckets and folded into Firestore every
 * BEHAVIOR_FLUSH_MS (default 5 minutes): one read and one write per page and
 * device that had traffic, plus one for the day row. A million page views a
 * day cost the same few thousand database operations as a thousand.
 * A restart loses at most one flush interval of measurements.
 */
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import query, { type QueryFilter } from "../../db/query.ts";
import log from "../../helper/log.ts";
import { addSummary, addToRow, type Bucket, bucketId, type Device, emptyBucket, emptyRow, mergeBucket, mergeRow, type PageRow, pathKeyOf, type Summary } from "./model.ts";

export const BEHAVIOR_PAGES = "behavior_pages";
export const BEHAVIOR_DAYS = "behavior_days";
const MAX_BUFFERED = 600;

type Doc = Record<string, unknown>;

export interface BehaviorIo {
  get: (collection: string, id: string) => Promise<Doc | null>;
  put: (collection: string, id: string, data: Doc) => Promise<unknown>;
  query: (collection: string, filters: QueryFilter[]) => Promise<Doc[]>;
}

const firestoreIo: BehaviorIo = {
  get: (c, id) => get(c, id).catch(() => null) as Promise<Doc | null>,
  put,
  query: (c, f) => query(c, f) as Promise<Doc[]>,
};

export const flushMs = () => Math.max(10_000, Number(Deno.env.get("BEHAVIOR_FLUSH_MS") ?? 300_000) || 300_000);

export class BehaviorStore {
  private buffer = new Map<string, Bucket>();
  private lastFlush = 0;
  private flushing: Promise<number> | null = null;
  constructor(private io: BehaviorIo = firestoreIo, private now: () => Date = () => new Date()) {}

  /** Add one page view. Returns false when the buffer is full of other pages (flood guard). */
  ingest(s: Summary): boolean {
    const day = this.now().toISOString().slice(0, 10);
    const id = bucketId(day, s.path, s.device);
    let b = this.buffer.get(id);
    if (!b) {
      if (this.buffer.size >= MAX_BUFFERED) return false;
      b = emptyBucket(day, s.path, s.device);
      this.buffer.set(id, b);
    }
    addSummary(b, s);
    if (!this.lastFlush) this.lastFlush = this.now().getTime();
    if (this.now().getTime() - this.lastFlush >= flushMs()) void this.flush();
    return true;
  }

  buffered(): number {
    return this.buffer.size;
  }

  /** Fold the buffer into the stored totals. One flush at a time. Never throws. */
  flush(): Promise<number> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<number> {
    const pending = [...this.buffer.values()];
    this.buffer = new Map();
    this.lastFlush = this.now().getTime();
    if (!pending.length) return 0;
    const stamp = this.now().toISOString();
    const dayRows = new Map<string, Map<string, PageRow>>();
    let written = 0;
    for (const delta of pending) {
      try {
        const stored = await this.io.get(BEHAVIOR_PAGES, delta.id) as Partial<Bucket> | null;
        const merged = mergeBucket(emptyBucket(delta.day, delta.path, delta.device), stored ?? {});
        mergeBucket(merged, delta);
        await this.io.put(BEHAVIOR_PAGES, delta.id, { ...merged, updatedAt: stamp } as unknown as Doc);
        written++;
        const rows = dayRows.get(delta.day) ?? new Map<string, PageRow>();
        rows.set(delta.pathKey, addToRow(rows.get(delta.pathKey) ?? emptyRow(delta.path), delta));
        dayRows.set(delta.day, rows);
      } catch (err) {
        // Keep the measurements for the next flush.
        const back = this.buffer.get(delta.id);
        this.buffer.set(delta.id, back ? mergeBucket(back, delta) : delta);
        log(`[behavior] flush of ${delta.id} failed: ${err instanceof Error ? err.message : err}`, "error");
      }
    }
    for (const [day, rows] of dayRows) {
      try {
        const stored = await this.io.get(BEHAVIOR_DAYS, day) as { pages?: Record<string, Partial<PageRow>> } | null;
        const pages: Record<string, PageRow> = {};
        for (const [k, r] of Object.entries(stored?.pages ?? {})) pages[k] = mergeRow(emptyRow(String(r.path ?? "/")), r);
        for (const [k, r] of rows) pages[k] = mergeRow(pages[k] ?? emptyRow(r.path), r);
        await this.io.put(BEHAVIOR_DAYS, day, { id: day, day, pages, updatedAt: stamp });
      } catch (err) {
        log(`[behavior] day row ${day} not updated: ${err instanceof Error ? err.message : err}`, "error");
      }
    }
    return written;
  }

  /** One row per page for the range, optionally one device's views only in the counts by device. */
  async pages(from: string, to: string): Promise<PageRow[]> {
    await this.flush();
    const docs = await this.io.query(BEHAVIOR_DAYS, [
      { field: "day", op: "GREATER_THAN_OR_EQUAL", value: from } as QueryFilter,
      { field: "day", op: "LESS_THAN_OR_EQUAL", value: to } as QueryFilter,
    ]);
    const out = new Map<string, PageRow>();
    for (const d of docs) {
      for (const [k, r] of Object.entries((d.pages ?? {}) as Record<string, Partial<PageRow>>)) {
        out.set(k, mergeRow(out.get(k) ?? emptyRow(String(r.path ?? "/")), r));
      }
    }
    return [...out.values()].sort((a, b) => b.views - a.views);
  }

  /** The merged bucket of one page over a range (one device, or all). */
  async page(path: string, from: string, to: string, device?: Device): Promise<Bucket> {
    await this.flush();
    const docs = await this.io.query(BEHAVIOR_PAGES, [{ field: "pathKey", op: "EQUAL", value: pathKeyOf(path) } as QueryFilter]);
    const out = emptyBucket(`${from}..${to}`, path, device ?? "desktop");
    for (const d of docs as unknown as Bucket[]) {
      if (d.day < from || d.day > to) continue;
      if (device && d.device !== device) continue;
      mergeBucket(out, d);
    }
    return out;
  }
}

export const behaviorStore = new BehaviorStore();
