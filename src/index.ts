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
  /**
   * Optional predicate to decide whether a failure is retryable.
   * Receives the error, attempt number, and response (if available).
   * Return true to retry, false to fail immediately.
   */
  retryIf?: (error: unknown, attempt: number, response?: Response) => boolean;
  /**
   * Enable request deduplication: identical in-flight requests are coalesced.
   * Key is derived from input + init (method, headers, body) by default.
   * Provide a custom `deduplicateKey` function for custom keys.
   */
  deduplicate?: boolean;
  /**
   * Custom deduplication key function.
   * Receives the input and init; return a string key.
   */
  deduplicateKey?: (input: RequestInfo | URL, init?: RequestInit) => string;
  /**
   * Circuit breaker configuration.
   * Opens after `failureThreshold` consecutive failures, enters half-open
   * after `resetTimeoutMs`, allows `halfOpenRequests` test requests.
   */
  circuitBreaker?: {
    failureThreshold: number;
    resetTimeoutMs: number;
    halfOpenRequests?: number;
  };
}

const DEFAULT_RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Full jitter -- the "full jitter" variant from the AWS Exponential Backoff and Jitter guidance. */
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

/**
 * Simple in-memory circuit breaker.
 * Not distributed -- suitable for single-process / worker environments.
 */
class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failures = 0;
  private successInHalfOpen = 0;
  private lastFailureTime = 0;

  constructor(
    private readonly failureThreshold: number,
    private readonly resetTimeoutMs: number,
    private readonly halfOpenRequests = 1
  ) {}

  canExecute(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = 'half-open';
        this.successInHalfOpen = 0;
        return true;
      }
      return false;
    }
    // half-open: allow limited requests
    return this.successInHalfOpen < 1; // allow 1 request at a time in half-open
  }

  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.successInHalfOpen++;
      if (this.successInHalfOpen >= 1) { // single success closes
        this.state = 'closed';
        this.failures = 0;
      }
    } else if (this.state === 'closed') {
      this.failures = 0;
    }
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.state === 'half-open') {
      this.state = 'open';
    } else if (this.failures >= this.failureThreshold) {
      this.state = 'open';
    }
  }

  getState(): 'closed' | 'open' | 'half-open' {
    return this.state;
  }
}

/**
 * In-flight request deduplication cache.
 * Maps deduplication key -> Promise<Response>
 */
const inflightCache = new Map<string, Promise<Response>>();

/** Simple hash for deduplication key (not cryptographic, just for dedup) */
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/** Generate deduplication key from input and init */
function generateDedupKey(input: RequestInfo | URL, init?: RequestInit, customKey?: (input: RequestInfo | URL, init?: RequestInit) => string): string {
  if (customKey) return customKey(input, init);
  const url = input instanceof URL ? input.toString() : String(input);
  const method = (init?.method || 'GET').toUpperCase();
  const headers = init?.headers
    ? (() => {
        const h: Record<string, string> = {};
        const headersObj = init?.headers as Headers | undefined;
        if (headersObj) {
          headersObj.forEach((value: string, key: string) => { h[key] = value; });
        }
        return JSON.stringify(Object.entries(h).sort());
      })()
    : '{}';
  const body = init?.body ? (typeof init.body === 'string' ? init.body : 'stream') : '';
  return hashString(`${method}|${url}|${headers}|${body}`);
}

export async function fetchRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: RetryOptions = {}
): Promise<Response> {
  const {
    retries = 3,
    baseDelayMs = 300,
    maxDelayMs = 5000,
    statusCodes,
    onRetry,
    timeoutMs,
    retryIf,
    deduplicate = false,
    deduplicateKey,
    circuitBreaker,
  } = options;

  const retryableSet = statusCodes ? new Set(statusCodes) : DEFAULT_RETRYABLE_STATUSES;
  const signal = init?.signal ?? undefined;
  const canReplayBody = !(typeof ReadableStream !== 'undefined' && init?.body instanceof ReadableStream);
  let attempt = 0;

  // Circuit breaker (per-function instance, not shared across calls)
  let circuitBreakerInstance: CircuitBreaker | undefined;
  if (circuitBreaker) {
    circuitBreakerInstance = new CircuitBreaker(
      circuitBreaker.failureThreshold,
      circuitBreaker.resetTimeoutMs,
      circuitBreaker.halfOpenRequests ?? 1
    );
  }

  for (;;) {
    // Check circuit breaker before attempting
    if (circuitBreakerInstance && !circuitBreakerInstance.canExecute()) {
      const error = new Error('Circuit breaker open');
      (error as Error & { circuitBreakerOpen: true }).circuitBreakerOpen = true;
      throw error;
    }

    // Request deduplication
    let cachedPromise: Promise<Response> | undefined;
    if (deduplicate) {
      const key = generateDedupKey(input, init, deduplicateKey);
      const cached = inflightCache.get(key);
      if (cached) {
        return cached;
      }
    }

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

      // Cache the in-flight promise for deduplication
      if (deduplicate && response.ok) {
        const key = generateDedupKey(input, init, deduplicateKey);
        const cachedPromise = (async () => {
          try {
            return response.clone();
          } catch {
            return response;
          }
        })();
        inflightCache.set(key, cachedPromise);
      }
    } catch (error) {
      // Remove from cache on error so retries can happen
      if (deduplicate) {
        const key = generateDedupKey(input, init, deduplicateKey);
        inflightCache.delete(key);
      }

      // Don't retry if aborted by our own timeout or caller signal
      const abortedByUs = error instanceof DOMException && error.name === 'AbortError' &&
        (timeoutMs !== undefined || signal?.aborted);
      if (attempt >= retries || signal?.aborted || !canReplayBody || (abortedByUs && !retryIf?.(error, attempt))) throw error;

      // Custom retry predicate
      if (retryIf && !retryIf(error, attempt + 1, undefined)) throw error;

      const delay = calculateJitterDelay(attempt, baseDelayMs, maxDelayMs);
      onRetry?.(error, attempt + 1, delay);
      await sleep(delay, signal);
      attempt++;
      circuitBreakerInstance?.recordFailure();
      continue;
    }

    // Remove from inflight cache on completion
    if (deduplicate) {
      const key = generateDedupKey(input, init, deduplicateKey);
      inflightCache.delete(key);
    }

    // Check circuit breaker on response
    if (circuitBreakerInstance) {
      if (response.ok) {
        circuitBreakerInstance.recordSuccess();
      } else {
        circuitBreakerInstance.recordFailure();
      }
    }

    // Retry logic for HTTP errors
    if (attempt < retries && retryableSet.has(response.status)) {
      if (!canReplayBody) return response;

      // Custom retry predicate for HTTP errors
      if (retryIf && !retryIf(new Error(`HTTP ${response.status}`), attempt + 1, response)) {
        return response;
      }

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
      circuitBreakerInstance?.recordFailure();
      continue;
    }

    // Successful response -- record circuit breaker success
    circuitBreakerInstance?.recordSuccess();

    return response;
  }
}

/**
 * Error passed to `onRetry` when a retry was triggered by an HTTP status.
 * `status` allows branching on the status code without parsing messages.
 */
export interface RetryError extends Error {
  /** HTTP status code that triggered the retry. */
  status: number;
}

export default fetchRetry;
