import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-document sequential mutex for Firestore read-modify-write safety.
 * Ported from IRP `db/redisInterface.ts`, decoupled from socket.io:
 * the broadcast hook is injected by the caller instead of importing a socket.
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

async function withLock<T>(
  collection: string,
  document: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = `${collection}/${document}`;
  const activeLocks = lockStorage.getStore() || new Set<string>();

  if (activeLocks.has(key)) {
    // Re-entrant: already hold the lock in this async context chain.
    return await task();
  }

  const lock = getLock(collection, document);
  try {
    return await lock.run(async () => {
      const next = new Set(activeLocks);
      next.add(key);
      return await lockStorage.run(next, task);
    });
  } finally {
    cleanupLock(collection, document);
  }
}

/** Wrap a read-modify-write transaction in a single per-document lock. */
export async function syncTransaction<T>(
  collection: string,
  document: string,
  task: () => Promise<T>,
): Promise<T> {
  return await withLock(collection, document, task);
}

/** Express middleware locking a document for the duration of the request. */
export function documentLockMiddleware(collection: string) {
  return (req: { params: { id?: string } }, res: { on: (e: string, cb: () => void) => void }, next: (err?: unknown) => void) => {
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

/** Execute a GET within the document's sequential lock queue. */
export async function syncGet<T>(
  collection: string,
  document: string,
  getFn: () => Promise<T>,
): Promise<T> {
  return await withLock(collection, document, getFn);
}

/** Execute a mutation sequentially, then invoke an optional post-mutation hook. */
export async function syncMutate<T>(
  action: "post" | "put" | "patch" | "delete",
  collection: string,
  document: string,
  mutateFn: () => Promise<T>,
  onMutate?: (event: {
    action: "post" | "put" | "patch" | "delete";
    collection: string;
    document: string;
  }) => void | Promise<void>,
): Promise<T> {
  const result = await withLock(collection, document, mutateFn);

  if (onMutate) {
    await onMutate({ action, collection, document });
  }

  return result;
}