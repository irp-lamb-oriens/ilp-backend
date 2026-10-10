import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, Response, NextFunction } from "express";

/**
 * In-memory per-document sequential lock queue.
 *
 * Prevents race conditions during read-modify-write operations on a single
 * Firestore document. Re-entrant within the same async context chain via
 * AsyncLocalStorage, so nested syncGet/syncMutate calls on the same document
 * do not deadlock.
 *
 * This is a socket-free port of the IRP `db/redisInterface.ts` semantics.
 * ILP has no socket.io layer, so the `db_update` broadcast is omitted.
 */

const lockStorage = new AsyncLocalStorage<Set<string>>();

class DocumentMutex {
  private queue: Promise<unknown> = Promise.resolve();
  public pendingCount = 0;

  run<T>(task: () => Promise<T>): Promise<T> {
    this.pendingCount++;
    const result = this.queue.then(task).catch(task);

    this.queue = result
      .catch(() => {})
      .finally(() => {
        this.pendingCount--;
      });

    return result as Promise<T>;
  }
}

const locks = new Map<string, DocumentMutex>();

function getLock(collection: string, document: string): DocumentMutex {
  const key = `${collection}/${document}`;
  let lock = locks.get(key);
  if (!lock) {
    lock = new DocumentMutex();
    locks.set(key, lock);
  }
  return lock;
}

function cleanupLock(collection: string, document: string): void {
  const key = `${collection}/${document}`;
  const lock = locks.get(key);
  if (lock && lock.pendingCount === 0) {
    locks.delete(key);
  }
}

/**
 * Acquire a re-entrant lock for a specific document and run `task` under it.
 */
async function withLock<T>(
  collection: string,
  document: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = `${collection}/${document}`;
  const activeLocks = lockStorage.getStore() || new Set<string>();

  if (activeLocks.has(key)) {
    // Already hold the lock in this async context chain.
    return await task();
  }

  const lock = getLock(collection, document);
  try {
    return await lock.run(async () => {
      const newLocks = new Set(activeLocks);
      newLocks.add(key);
      return await lockStorage.run(newLocks, task);
    });
  } finally {
    cleanupLock(collection, document);
  }
}

/**
 * Wrap an entire transaction (read -> modify -> write) in a single lock to
 * prevent race conditions during complex operations.
 */
export async function syncTransaction<T>(
  collection: string,
  document: string,
  task: () => Promise<T>,
): Promise<T> {
  return await withLock(collection, document, task);
}

/**
 * Express middleware that locks a specific document for the duration of the
 * HTTP request. The document id is read from `req.params.id`.
 */
export function documentLockMiddleware(collection: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const id = req.params.id;
    if (!id) return next();

    syncTransaction(collection, id, () => {
      return new Promise<void>((resolve) => {
        res.on("finish", resolve);
        res.on("close", resolve);
        next();
      });
    }).catch(next);
  };
}

/**
 * Execute a GET operation within the document's sequential lock queue.
 */
export async function syncGet<T>(
  collection: string,
  document: string,
  getFn: () => Promise<T>,
): Promise<T> {
  return await withLock(collection, document, getFn);
}

/**
 * Execute a mutation (post, put, patch, delete) sequentially.
 *
 * The IRP original also broadcast a `db_update` event to a socket.io room;
 * ILP has no socket layer, so that broadcast is intentionally omitted.
 */
export async function syncMutate<T>(
  _action: "post" | "put" | "patch" | "delete",
  collection: string,
  document: string,
  mutateFn: () => Promise<T>,
  _actorEmail?: string,
): Promise<T> {
  return await withLock(collection, document, mutateFn);
}