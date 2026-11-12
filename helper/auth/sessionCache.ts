/**
 * helper/auth/sessionCache.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Every signed-in request looks its session up. Without this, that is one
 * database read per request; with it, one read per session per minute.
 *
 * Rules:
 *   - only the session collections (`*_sessions`); single-use tickets and
 *     sign-in codes are always read fresh;
 *   - only sessions that exist are remembered (a wrong token is never cached);
 *   - any change to a session on this server (sign-in stamp, sliding expiry,
 *     sign-out, sign-out everywhere) forgets it at once;
 *   - the expiry is still checked on every request by the caller, on the copy;
 *   - off until main.ts arms it, so tests and scripts always read the store;
 *   - SESSION_CACHE_MS sets the window (default 60000, 0 turns it off). With
 *     more than one server instance, a sign-out on one instance can take up
 *     to that long to reach the others.
 */

type Doc = Record<string, unknown>;

const MAX_ENTRIES = 10_000;
const entries = new Map<string, { at: number; doc: Doc }>();
let armed = false;
let hits = 0;
let misses = 0;

function ttlMs(): number {
  const n = Number(Deno.env.get("SESSION_CACHE_MS") ?? "60000");
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 10 * 60_000) : 60_000;
}

export function armSessionCache(): void {
  armed = true;
}

export function isSessionCollection(collection: string): boolean {
  return /_sessions$/.test(collection);
}

export function forgetSession(collection: string, id: string): void {
  entries.delete(`${collection}/${id}`);
}

export function clearSessionCache(): void {
  entries.clear();
  hits = 0;
  misses = 0;
}

export function sessionCacheStats(): { entries: number; hits: number; misses: number } {
  return { entries: entries.size, hits, misses };
}

export async function cachedSession<T extends Doc | null>(
  collection: string,
  id: string,
  load: () => Promise<T>,
  opts: { enabled?: boolean; ttlMs?: number; now?: number } = {},
): Promise<T> {
  const ttl = opts.ttlMs ?? ttlMs();
  const enabled = (opts.enabled ?? armed) && ttl > 0 && isSessionCollection(collection);
  if (!enabled) return await load();
  const key = `${collection}/${id}`;
  const now = opts.now ?? Date.now();
  const hit = entries.get(key);
  if (hit && now - hit.at < ttl) {
    hits++;
    return structuredClone(hit.doc) as T;
  }
  misses++;
  entries.delete(key);
  const doc = await load();
  if (doc) {
    if (entries.size >= MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    entries.set(key, { at: now, doc: structuredClone(doc) as Doc });
  }
  return doc;
}
