export interface RetryOptions {
  /**
   * Additional attempts after the initial request. Default: 3
   * (a value of 2 means up to 3 total fetch calls).
   */
  retries?: number;
  /**
   * First backoff window in milliseconds. The delay for each attempt is
   * drawn uniformly from [0, min(maxDelayMs, baseDelayMs * 2^attempt)).
   * Default: 300
   */
  baseDelayMs?: number;
  /** Upper bound for every backoff window (including Retry-After). Default: 5000 */
  maxDelayMs?: number;
  /**
   * Total timeout per request attempt in milliseconds (including redirects).
   * Applies to each attempt independently; aborts that attempt if exceeded.
   */
  timeoutMs?: number;
  /** HTTP status codes that trigger a retry. Replaces the default set. */
  statusCodes?: number[];
  /**
   * Invoked before each backoff sleep. For HTTP-triggered retries the error is
   * a {@link RetryError} carrying the status code, so consumers can branch
   * without parsing the message. Network failures pass the original error.
   */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Error passed to `onRetry` when a retry was triggered by an HTTP status.
 * `status` allows branching on the status code without parsing messages.
 */
export interface RetryError extends Error {
  /** HTTP status code that triggered the retry. */
  status: number;
}

const DEFAULT_RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Full jitter — the "full jitter" variant from the AWS Exponential Backoff and Jitter guidance. */
function calculateJitterDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

/** Parses Retry-After as delay-seconds (integer or fractional) or as an HTTP-date. */
function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const dateParsed = Date.parse(headerValue);
  if (!Number.isNaN(dateParsed)) return Math.max(0, dateParsed - Date.now());
  return null;
}

/** Abort-aware sleep. Rejects immediately if `signal` fires (or has already fired). */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  function onAbort(): void {
    clearTimeout(timer);
    reject(signal?.reason ?? new DOMException('This operation was aborted', 'AbortError'));
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  return promise;
}

export async function fetchRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: RetryOptions = {}
): Promise<Response> {
  const { retries = 3, baseDelayMs = 300, maxDelayMs = 5000, statusCodes, onRetry, timeoutMs } = options;
  const retryableSet = statusCodes ? new Set(statusCodes) : DEFAULT_RETRYABLE_STATUSES;
  const signal = init?.signal ?? undefined;
  const canReplayBody = !(typeof ReadableStream !== 'undefined' && init?.body instanceof ReadableStream);
  let attempt = 0;

  for (;;) {
    let response: Response;
    try {
      // Create combined abort signal if timeoutMs is specified
      const controller = new AbortController();
      const signals = [signal].filter(Boolean) as AbortSignal[];
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      if (timeoutMs !== undefined) {
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
        signals.push(timeoutController.signal);
        // Clean up timeout if the combined signal aborts for another reason
        signal?.addEventListener('abort', () => clearTimeout(timeoutId), { once: true });
      }

      for (const s of signals) {
        s.addEventListener('abort', () => controller.abort(), { once: true });
      }

      response = await fetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      // Don't retry if aborted by our own timeout or caller signal
      const abortedByUs = error instanceof DOMException && error.name === 'AbortError' &&
        (timeoutMs !== undefined || signal?.aborted);
      if (attempt >= retries || signal?.aborted || !canReplayBody || abortedByUs) throw error;
      const delay = calculateJitterDelay(attempt, baseDelayMs, maxDelayMs);
      onRetry?.(error, attempt + 1, delay);
      await sleep(delay, signal);
      attempt++;
      continue;
    }

    if (attempt < retries && retryableSet.has(response.status)) {
      if (!canReplayBody) return response;
      // Release the connection before sleeping.
      try {
        await response.body?.cancel();
      } catch {
        // Body already consumed or locked; safe to ignore.
      }
      const headerDelay = parseRetryAfter(response.headers.get('retry-after'));
      // A hostile or broken server must not be able to stall the caller.
      const delay =
        headerDelay === null
          ? calculateJitterDelay(attempt, baseDelayMs, maxDelayMs)
          : Math.min(headerDelay, maxDelayMs);
      const retryErr: RetryError = Object.assign(new Error(`HTTP ${response.status}`), {
        status: response.status,
      });
      onRetry?.(retryErr, attempt + 1, delay);
      await sleep(delay, signal);
      attempt++;
      continue;
    }

    return response;
  }
}

export default fetchRetry;