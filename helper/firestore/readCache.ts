/**
 * helper/firestore/readCache.ts — one answer per question.
 *
 * Every list and query the server makes goes through firestoreService.ts.
 * This cache sits there, so each distinct read (a whole collection, or one
 * query) hits the database once and is then answered from memory until
 * either (a) anything in that collection is written through the service, or
 * (b) the entry is DB_CACHE_TTL_MS old (default 2 minutes).
 *
 * Why it is safe: all writes go through the same service (rules.md §4), and
 * the API runs as one process, so a write always clears what it could have
 * changed before the next read. Changes made outside the server (the
 * Firebase console, a script) show after the TTL at the latest.
 *
 * What it never holds: sign-in codes, sessions, tickets, slot claims and the
 * high-volume event and log collections (NEVER below). Results over
 * MAX_DOCS documents are passed through uncached to bound memory.
 * Callers get their own copy of the data, so nobody can change the cache.
 *
 * On whenever the API server runs (main.ts arms it); DB_CACHE=off turns it
 * off. Tests and scripts do not arm it, so they read straight from the database.
 */

const NEVER = /(^|_)(otps|sessions|tickets)$|^(join_sessions|download_tickets|call_slots|slot_claims|deadline_claims|journey_events|funnel_events|audit_log|error_log|email_queue|behavior_pages|behavior_days)$/;
const MAX_DOCS = 5000;
const MAX_ENTRIES = 500;

interface Entry {
  at: number;
  docs: unknown[];
}

const entries = new Map<string, Entry>();
const pending = new Map<string, Promise<unknown[]>>();
const versions = new Map<string, number>();
const counters = { hits: 0, misses: 0, shared: 0, invalidations: 0, skipped: 0 };

let armed = false;

/** Called once by main.ts when the API server starts. Tests and scripts never call it. */
export function armReadCache(): void {
  armed = true;
}

export function cacheEnabled(): boolean {
  const flag = (Deno.env.get("DB_CACHE") ?? "").toLowerCase();
  if (flag === "off" || flag === "false" || flag === "0") return false;
  if (flag === "on" || flag === "true" || flag === "1") return true;
  return armed;
}

export function cacheTtlMs(): number {
  const n = Number(Deno.env.get("DB_CACHE_TTL_MS") ?? 120_000);
  return Number.isFinite(n) && n >= 0 ? n : 120_000;
}

export function cacheable(collection: string): boolean {
  return !NEVER.test(collection);
}

const keyOf = (collection: string, question: string) => `${collection}\u0000${question}`;

/**
 * Answer `question` about `collection` from memory, or load it once.
 * Concurrent identical reads share one database call.
 */
export async function cachedRead<T>(collection: string, question: string, load: () => Promise<T[]>, opts: { now?: number; enabled?: boolean; ttlMs?: number } = {}): Promise<T[]> {
  const enabled = opts.enabled ?? cacheEnabled();
  if (!enabled || !cacheable(collection)) {
    counters.skipped++;
    return await load();
  }
  const key = keyOf(collection, question);
  const now = opts.now ?? Date.now();
  const hit = entries.get(key);
  if (hit && now - hit.at < (opts.ttlMs ?? cacheTtlMs())) {
    counters.hits++;
    return structuredClone(hit.docs) as T[];
  }
  const running = pending.get(key);
  if (running) {
    counters.shared++;
    return structuredClone(await running) as T[];
  }
  counters.misses++;
  const version = versions.get(collection) ?? 0;
  const p = load().then((docs) => {
    // Keep it only if nothing was written to the collection while we were reading.
    if (docs.length <= MAX_DOCS && (versions.get(collection) ?? 0) === version) {
      entries.delete(key);
      entries.set(key, { at: Date.now(), docs });
      while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
    }
    return docs as unknown[];
  }).finally(() => pending.delete(key));
  pending.set(key, p);
  return structuredClone(await p) as T[];
}

/** A write happened in `collection`: forget every answer about it. */
export function invalidateCollection(collection: string): void {
  versions.set(collection, (versions.get(collection) ?? 0) + 1);
  const prefix = `${collection}\u0000`;
  let dropped = false;
  for (const k of entries.keys()) {
    if (k.startsWith(prefix)) {
      entries.delete(k);
      dropped = true;
    }
  }
  if (dropped) counters.invalidations++;
}

export function clearReadCache(): void {
  entries.clear();
  pending.clear();
  versions.clear();
  for (const k of Object.keys(counters) as Array<keyof typeof counters>) counters[k] = 0;
}

/** For /health/deep and logs: how much the cache is saving. */
export function readCacheStats() {
  let docs = 0;
  for (const e of entries.values()) docs += e.docs.length;
  const asked = counters.hits + counters.shared + counters.misses;
  return { enabled: cacheEnabled(), ttlMs: cacheTtlMs(), entries: entries.size, docsHeld: docs, ...counters, savedShare: asked ? Math.round(((counters.hits + counters.shared) / asked) * 100) / 100 : 0 };
}
