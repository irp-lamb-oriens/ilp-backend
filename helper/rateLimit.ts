/**
 * Centralized rate limiting with exponential backoff for outbound requests
 * made by cron jobs (Firestore REST, SMTP, etc.). Guards against hammering
 * upstream services and retries transient 429/5xx responses with a capped
 * exponential delay.
 *
 * Two primitives:
 *   - RateLimiter: a sliding-window limiter that throttles request bursts.
 *   - withExponentialBackoff: retries a task on retryable failures, doubling
 *     the delay each attempt up to a cap.
 */

const DEFAULT_WINDOW_MS = 10_000;
const DEFAULT_MAX_PER_WINDOW = 5;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_MULTIPLIER = 2;
const DEFAULT_MAX_RETRIES = 5;

interface RateLimiterOptions {
  windowMs?: number;
  maxPerWindow?: number;
}

interface BackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
  maxRetries?: number;
  /** Predicate deciding whether an error is retryable. Defaults to 429 + 5xx. */
  isRetryable?: (err: unknown) => boolean;
}

/**
 * Sliding-window rate limiter. Tracks timestamps of recent requests and
 * delays the next request when the window is saturated. State is bounded by
 * the window size, so no unbounded growth.
 */
export class RateLimiter {
  private timestamps: number[] = [];
  private readonly windowMs: number;
  private readonly maxPerWindow: number;

  constructor(options: RateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxPerWindow = options.maxPerWindow ?? DEFAULT_MAX_PER_WINDOW;
  }

  /** Wait until a slot is available, then record the request. */
  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxPerWindow) {
      const oldest = this.timestamps[0];
      const waitMs = Math.max(0, this.windowMs - (now - oldest));
      await sleep(waitMs);
      return this.acquire();
    }

    this.timestamps.push(now);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Retry a task on retryable failures with exponential backoff. The first
 * attempt runs immediately; each retry waits `baseDelayMs * multiplier^n`,
 * capped at `maxDelayMs`. Returns the task result or rethrows the last error
 * after `maxRetries` retries.
 */
export async function withExponentialBackoff<T>(
  task: () => Promise<T>,
  options: BackoffOptions = {},
): Promise<T> {
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const multiplier = options.multiplier ?? DEFAULT_MULTIPLIER;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const isRetryable = options.isRetryable ?? defaultIsRetryable;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await task();
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries || !isRetryable(err)) {
        throw err;
      }
      const delay = Math.min(baseDelayMs * multiplier ** attempt, maxDelayMs);
      await sleep(delay);
    }
  }
  throw lastError;
}

function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    // Firestore errors embed the status in the message: "Firestore ... (429): ..."
    const match = /\((\d{3})\)/.exec(err.message);
    if (match) return isRetryableStatus(Number(match[1]));
  }
  return false;
}

/**
 * A rate-limited task runner. Combines the sliding-window limiter with
 * exponential backoff so a burst of cron requests is throttled and transient
 * upstream failures are retried without overwhelming the service.
 */
export function createRateLimitedRunner(
  limiter: RateLimiter,
  backoff: BackoffOptions = {},
) {
  return async <T>(task: () => Promise<T>): Promise<T> => {
    await limiter.acquire();
    return withExponentialBackoff(task, backoff);
  };
}