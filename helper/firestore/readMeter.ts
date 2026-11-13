/**
 * helper/firestore/readMeter.ts — how many documents each request and job reads.
 * ──────────────────────────────────────────────────────────────────────────
 * Firestore bills one read per document returned (a query that returns
 * nothing still costs one). The service (firestoreService.ts) reports every
 * database round trip here; answers served from readCache.ts are not reads
 * and are not counted.
 *
 * Three views of the same numbers:
 *  - per request / per job: `metered(label, fn)` runs `fn` in a scope; when it
 *    ends, a line is logged if it read READ_LOG_MIN documents or more
 *    (default 200): `[reads] GET /api/x → 1234 docs (clients 1000, providers 234)`.
 *  - running totals by collection since start, logged every hour
 *    (`[reads] last hour: 5321 docs — clients 3000, …`), so a runaway reader
 *    shows up in the logs long before the quota does.
 *  - `readStats()` for tests and /health/deep.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import log from "../log.ts";

interface Scope {
  total: number;
  byCollection: Map<string, number>;
}

const als = new AsyncLocalStorage<Scope>();
const totals = new Map<string, number>();
let hourly = new Map<string, number>();

/** "clients/abc/pricing_requests" → "clients/*\/pricing_requests"; "clients" stays. */
export function collectionKey(path: string): string {
  const parts = path.split("/");
  return parts.map((p, i) => (i % 2 === 1 ? "*" : p)).join("/");
}

const bump = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);

/** Called by firestoreService for every read round trip. `docs` = documents returned. */
export function meterRead(collection: string, docs: number): void {
  const n = Math.max(1, docs);
  const key = collectionKey(collection);
  bump(totals, key, n);
  bump(hourly, key, n);
  const scope = als.getStore();
  if (scope) {
    scope.total += n;
    bump(scope.byCollection, key, n);
  }
}

export function logMin(): number {
  const n = Number(Deno.env.get("READ_LOG_MIN") ?? 200);
  return Number.isFinite(n) && n >= 0 ? n : 200;
}

const top = (m: Map<string, number>, k = 5) =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([c, n]) => `${c} ${n}`).join(", ");

/**
 * Run `fn` in its own read scope. Logs `[reads] <label> → N docs (…)` when N ≥ READ_LOG_MIN.
 * Returns fn's result; `onDone` gets the scope (tests).
 */
export async function metered<T>(label: string, fn: () => Promise<T>, onDone?: (s: { total: number; byCollection: Map<string, number> }) => void): Promise<T> {
  const scope: Scope = { total: 0, byCollection: new Map() };
  try {
    return await als.run(scope, fn);
  } finally {
    onDone?.(scope);
    if (scope.total >= logMin() && scope.total > 0) log(`[reads] ${label} → ${scope.total} docs (${top(scope.byCollection)})`);
  }
}

/**
 * Express middleware: one read scope per request, logged when the response
 * finishes. Uses enterWith so everything the request awaits stays in scope.
 */
export function readMeterMiddleware() {
  // deno-lint-ignore no-explicit-any
  return (req: any, res: any, next: () => void) => {
    const scope: Scope = { total: 0, byCollection: new Map() };
    als.run(scope, () => {
      res.on("finish", () => {
        if (scope.total >= logMin() && scope.total > 0) {
          const path = String(req.originalUrl ?? req.url ?? "").split("?")[0];
          log(`[reads] ${req.method} ${path} ${res.statusCode} → ${scope.total} docs (${top(scope.byCollection)})`);
        }
      });
      next();
    });
  };
}

/** Totals since start, and for the current hour. */
export function readStats(): { total: number; byCollection: Record<string, number>; lastHour: Record<string, number> } {
  return {
    total: [...totals.values()].reduce((a, b) => a + b, 0),
    byCollection: Object.fromEntries(totals),
    lastHour: Object.fromEntries(hourly),
  };
}

let timer: number | undefined;
/** Hourly summary line (main.ts starts it with the server). */
export function startHourlyReadLog(): void {
  if (timer !== undefined) return;
  timer = setInterval(() => {
    const sum = [...hourly.values()].reduce((a, b) => a + b, 0);
    log(`[reads] last hour: ${sum} docs${sum ? ` (${top(hourly, 8)})` : ""}`);
    hourly = new Map();
  }, 3_600_000);
  Deno.unrefTimer(timer);
}

/** Tests. */
export function _resetReadStats(): void {
  totals.clear();
  hourly = new Map();
}
