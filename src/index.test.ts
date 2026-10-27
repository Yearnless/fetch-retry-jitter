import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchRetry } from './index';

const URL_UNDER_TEST = 'https://api.example.com/';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchRetry', () => {
  it('resolves immediately on HTTP 200 without retrying', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const res = await fetchRetry(URL_UNDER_TEST);
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on transient HTTP 500 and succeeds on the second attempt', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
      .mockResolvedValueOnce(new Response('Recovered', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const promise = fetchRetry(URL_UNDER_TEST, {}, { baseDelayMs: 1, maxDelayMs: 5 });
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns non-retryable statuses without retrying', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('Not Found', { status: 404 }));
    vi.stubGlobal('fetch', mockFetch);

    const res = await fetchRetry(URL_UNDER_TEST);
    expect(res.status).toBe(404);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries custom status codes when statusCodes is provided', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response('OK', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const promise = fetchRetry(URL_UNDER_TEST, {}, { statusCodes: [403], retries: 1, baseDelayMs: 1, maxDelayMs: 5 });
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('uses Retry-After delay-seconds as the exact backoff delay', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('Rate Limited', { status: 429, headers: { 'retry-after': '0.05' } }))
      .mockResolvedValueOnce(new Response('Success', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);
    const observed: Array<{ message: string; attempt: number; delay: number }> = [];

    const promise = fetchRetry(URL_UNDER_TEST, {}, {
      retries: 1,
      onRetry: (error, attempt, delay) => observed.push({ message: (error as Error).message, attempt, delay }),
    });
    await vi.advanceTimersByTimeAsync(50);
    await promise;

    expect(observed).toEqual([{ message: 'HTTP 429', attempt: 1, delay: 50 }]);
  });

  it('parses Retry-After HTTP-dates', async () => {
    const retryAt = new Date(Date.now() + 2000).toUTCString();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('Rate Limited', { status: 503, headers: { 'retry-after': retryAt } }))
      .mockResolvedValueOnce(new Response('OK', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);
    const delays: number[] = [];

    const promise = fetchRetry(URL_UNDER_TEST, {}, {
      retries: 1,
      onRetry: (_error, _attempt, delay) => {
        delays.push(delay);
      },
    });
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    // toUTCString() truncates to whole seconds, so the computed delay is in (1500, 2000].
    expect(delays[0]).toBeGreaterThan(1500);
    expect(delays[0]).toBeLessThanOrEqual(2000);
  });

  it('clamps oversized Retry-After values to maxDelayMs', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('Slow down', { status: 429, headers: { 'retry-after': '3600' } }))
      .mockResolvedValueOnce(new Response('OK', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);
    const delays: number[] = [];

    const promise = fetchRetry(URL_UNDER_TEST, {}, {
      retries: 1,
      maxDelayMs: 50,
      onRetry: (_error, _attempt, delay) => {
        delays.push(delay);
      },
    });
    await vi.advanceTimersByTimeAsync(50);
    await promise;

    expect(delays).toEqual([50]);
  });

  it('throws after exceeding the retry limit on persistent network errors', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Connection Reset'));
    vi.stubGlobal('fetch', mockFetch);

    const promise = fetchRetry(URL_UNDER_TEST, {}, { retries: 2, baseDelayMs: 1, maxDelayMs: 5 });
    // Deterministic under fake timers: attempt -> backoff -> attempt -> backoff -> attempt -> throw.
    const assertion = expect(promise).rejects.toThrow('Connection Reset');
    await vi.runAllTimersAsync();
    await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry caller-initiated aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const mockFetch = vi.fn().mockRejectedValue(new DOMException('This operation was aborted', 'AbortError'));
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      fetchRetry(URL_UNDER_TEST, { signal: controller.signal }, { retries: 3 })
    ).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects during backoff when the signal aborts mid-sleep', async () => {
    const controller = new AbortController();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('Rate Limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('OK', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const promise = fetchRetry(
      URL_UNDER_TEST,
      { signal: controller.signal },
      { retries: 3, baseDelayMs: 1000, maxDelayMs: 2000 }
    );
    // Abort before the first response even settles: no timer ever fires,
    // the backoff sleep rejects with the signal's reason.
    controller.abort();
    await expect(promise).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
