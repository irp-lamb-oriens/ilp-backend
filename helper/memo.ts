/**
 * helper/memo.ts — keep a computed answer until something it read changes.
 * ──────────────────────────────────────────────────────────────────────────
 * readCache.ts keeps single queries for 2 minutes. Some pages build one
 * answer from many queries (a CSM's whole book: memberships, tasks,
 * obligations, feedback, contacts, members), and every CSM page needs that
 * same answer. `memo(key, deps, compute)` keeps it in memory until either
 *  (a) the service writes to any collection in `deps` (the CSM closes a task,
 *      a member uploads, a lawyer confirms a call: the next page is fresh), or
 *  (b) it is MEMO_TTL_MIN old (default 5), which bounds what another server
 *      instance or the Firebase console could have changed meanwhile.
 *
 * Same switch as readCache (on in the API server, off in tests and scripts).
 * Callers get their own copy (structuredClone), Maps included.
 */

import { cacheEnabled, onCollectionWrite } from "./firestore/readCache.ts";

interface Entry {
  at: number;
  value: unknown;
  deps: string[];
}

const entries = new Map<string, Entry>();
const pending = new Map<string, { promise: Promise<unknown>; deps: string[]; stale: boolean }>();
const MAX_ENTRIES = 200;

export function memoTtlMs(): number {
  const n = Number(Deno.env.get("MEMO_TTL_MIN") ?? 5);
  return (Number.isFinite(n) && n >= 0 ? n : 5) * 60_000;
}

onCollectionWrite((collection) => {
  for (const [k, e] of entries) if (e.deps.includes(collection)) entries.delete(k);
  // A read already running may have seen the old data: do not keep its answer.
  for (const p of pending.values()) if (p.deps.includes(collection)) p.stale = true;
});

export async function memo<T>(
  key: string,
  deps: string[],
  compute: () => Promise<T>,
  opts: { enabled?: boolean; ttlMs?: number; now?: number } = {},
): Promise<T> {
  if (!(opts.enabled ?? cacheEnabled())) return await compute();
  const now = opts.now ?? Date.now();
  const hit = entries.get(key);
  if (hit && now - hit.at < (opts.ttlMs ?? memoTtlMs())) return structuredClone(hit.value) as T;
  const running = pending.get(key);
  if (running) return structuredClone(await running.promise) as T;
  const slot = { promise: compute() as Promise<unknown>, deps, stale: false };
  pending.set(key, slot);
  try {
    const value = await slot.promise;
    if (!slot.stale) {
      entries.delete(key);
      entries.set(key, { at: Date.now(), value, deps });
      while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
    }
    return structuredClone(value) as T;
  } finally {
    pending.delete(key);
  }
}

/** Tests. */
export function _clearMemo(): void {
  entries.clear();
  pending.clear();
}
