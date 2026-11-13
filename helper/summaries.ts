/**
 * helper/summaries.ts — staff dashboard figures computed once, then read back.
 * ──────────────────────────────────────────────────────────────────────────
 * The staff dashboard shows company-wide figures (KPIs, funnels, PMF, finance
 * reports). Computing one means reading whole collections, so doing it on
 * every page view cost thousands of reads per click. Instead each figure set
 * is a snapshot:
 *
 *   - computed at most once per SUMMARY_TTL_MIN (default 10 minutes) per key,
 *     across every staff member and every server instance;
 *   - stored in `dashboard_summaries/<key>` (one document, the answer as JSON);
 *   - read back for 1 document read while fresh; held in memory too, so a
 *     busy instance does not even pay that.
 *
 * Nobody looking = no reads at all (there is no job). `?refresh=1` from staff
 * recomputes now. With `deps`, a write this server makes to one of those
 * collections makes the snapshot stale at once (closing a task updates
 * Today's KPIs on the next load); other instances catch up within the TTL. Responses carry `asOf` so the page can say how fresh the
 * numbers are. Keys must include everything the answer depends on (viewer,
 * filters, "exclude placeholder data").
 */

import get from "../db/get.ts";
import put from "../db/put.ts";
import log from "./log.ts";
import { onCollectionWrite } from "./firestore/readCache.ts";
import { placeholderExcluded } from "./placeholderScope.ts";

export const SUMMARIES_COLLECTION = "dashboard_summaries";
/** Firestore documents cap at 1 MiB; larger answers are kept in memory only. */
const MAX_STORED_BYTES = 900_000;

export function summaryTtlMs(): number {
  const n = Number(Deno.env.get("SUMMARY_TTL_MIN") ?? 10);
  return (Number.isFinite(n) && n >= 0 ? n : 10) * 60_000;
}

interface Snap<T> {
  data: T;
  asOf: string;
}

const memory = new Map<string, Snap<unknown>>();
/** Last write this process made to each collection (ms), for `deps`. */
const lastWrite = new Map<string, number>();
onCollectionWrite((collection) => lastWrite.set(collection, Date.now()));
const changedSince = (deps: readonly string[] | undefined, asOf: string) =>
  !!deps?.some((c) => (lastWrite.get(c) ?? 0) >= Date.parse(asOf));
const running = new Map<string, Promise<Snap<unknown>>>();

/** A Firestore-safe document id for a key (no slashes, bounded length). */
export function summaryDocId(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9_.:=-]+/g, "_");
  if (safe.length <= 300) return safe;
  let h = 0;
  for (const ch of key) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return `${safe.slice(0, 280)}_${(h >>> 0).toString(36)}`;
}

const fresh = (asOf: string, now: number, ttl: number) => now - Date.parse(asOf) < ttl;

/**
 * The answer for `key`: from memory or `dashboard_summaries` while younger
 * than the TTL, otherwise `compute()` (once, even with concurrent callers),
 * stored for everyone else.
 */
export async function summary<T>(
  key: string,
  compute: () => Promise<T>,
  opts: { refresh?: boolean; ttlMs?: number; now?: number; deps?: readonly string[] } = {},
): Promise<Snap<T>> {
  const ttl = opts.ttlMs ?? summaryTtlMs();
  const now = opts.now ?? Date.now();
  if (!opts.refresh && ttl > 0) {
    const m = memory.get(key);
    if (m && fresh(m.asOf, now, ttl) && !changedSince(opts.deps, m.asOf)) return m as Snap<T>;
    const inflight = running.get(key);
    if (inflight) return (await inflight) as Snap<T>;
  }
  const job = (async (): Promise<Snap<unknown>> => {
    if (!opts.refresh && ttl > 0) {
      const doc = (await get(SUMMARIES_COLLECTION, summaryDocId(key)).catch(() => null)) as Record<string, unknown> | null;
      if (doc && typeof doc.json === "string" && typeof doc.asOf === "string" && fresh(doc.asOf, now, ttl) && !changedSince(opts.deps, doc.asOf)) {
        try {
          const snap = { data: JSON.parse(doc.json), asOf: doc.asOf };
          memory.set(key, snap);
          return snap;
        } catch { /* unreadable: recompute */ }
      }
    }
    const data = await compute();
    const snap = { data, asOf: new Date(opts.now ?? Date.now()).toISOString() };
    memory.set(key, snap);
    const json = JSON.stringify(data);
    if (json.length <= MAX_STORED_BYTES) {
      // Snapshots can name members (Needs attention): `expiresAt` lets a Firestore TTL policy
      // delete them a day later, so an erased member does not linger here.
      const expiresAt = new Date(Date.parse(snap.asOf) + 86_400_000).toISOString();
      await put(SUMMARIES_COLLECTION, summaryDocId(key), { key, asOf: snap.asOf, expiresAt, json }).catch((err) =>
        log(`[summaries] could not store ${key}: ${err instanceof Error ? err.message : err}`, "error")
      );
    }
    return snap;
  })();
  running.set(key, job);
  try {
    return (await job) as Snap<T>;
  } finally {
    running.delete(key);
  }
}

/** Tests. */
export function _resetSummaries(): void {
  memory.clear();
  running.clear();
}

/**
 * Express middleware: serve a heavy GET route (a plain `res.json` answer)
 * through summary(). Place it after the auth middleware. The key holds the
 * route name, the query string (minus `refresh`), "exclude placeholder data",
 * and the viewer when `perViewer`. Only 2xx answers are kept; errors pass
 * through untouched. Not for streamed (NDJSON) list answers.
 */
export function snapshotRoute(name: string, opts: { perViewer?: boolean; deps?: readonly string[] } = {}) {
  // deno-lint-ignore no-explicit-any
  return (req: any, res: any, next: (err?: unknown) => void) => {
    if (req.method !== "GET") return next();
    const q = Object.entries(req.query ?? {})
      .filter(([k]) => k !== "refresh")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`)
      .join("&");
    const viewer = opts.perViewer ? String(req.dashboardUser ?? "") : "";
    const key = `${name}:${viewer}:${placeholderExcluded() ? "real" : "all"}:${q}`;
    let sentByHandler = false;
    summary(key, () =>
      new Promise((resolve, reject) => {
        const json = res.json.bind(res);
        res.json = (body: unknown) => {
          res.json = json;
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
            return res;
          }
          sentByHandler = true;
          reject(new Error(`${name}: answer ${res.statusCode} not kept`));
          return json(body);
        };
        // The handler failed through the error handler (it never called res.json).
        res.on("close", () => reject(new Error(`${name}: closed before an answer`)));
        next();
      }), { refresh: req.query?.refresh === "1", deps: opts.deps })
      .then((snap) => {
        if (res.headersSent) return;
        const body = snap.data && typeof snap.data === "object" && !Array.isArray(snap.data) ? { ...(snap.data as object), asOf: snap.asOf } : snap.data;
        res.json(body);
      })
      .catch((err) => {
        if (!sentByHandler && !res.headersSent) next(err);
      });
  };
}
