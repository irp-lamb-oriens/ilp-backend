/**
 * helper/cache.ts — small in-memory TTL cache for public, read-only lists
 * (legal updates, templates, the vetted-lawyer list). Every marketing page
 * view used to read whole collections; with the cache each list is read at
 * most once per TTL per server, which keeps the database quota for members.
 * A failed load serves the last good value (stale) when there is one.
 * A newly published item shows within the TTL; `invalidate(prefix)` clears it sooner.
 */
interface Entry {
  at: number;
  value: unknown;
  pending?: Promise<unknown>;
}

/** How long public lists are served from memory. */
export const PUBLIC_LIST_TTL_MS = 60_000;

const store = new Map<string, Entry>();

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>, now = Date.now()): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.value !== undefined && now - hit.at < ttlMs) return hit.value as T;
  if (hit?.pending) return await hit.pending as T; // one load at a time per key
  const pending = load()
    .then((value) => {
      store.set(key, { at: Date.now(), value });
      return value;
    })
    .catch((err) => {
      const last = store.get(key);
      if (last && last.value !== undefined) {
        store.set(key, { at: last.at, value: last.value }); // drop `pending`, keep serving stale
        return last.value as T;
      }
      store.delete(key);
      throw err;
    });
  store.set(key, { at: hit?.at ?? 0, value: hit?.value, pending });
  return await pending;
}

export function invalidate(prefix: string): void {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}

/** Tests only. */
export function clearCache(): void {
  store.clear();
}
