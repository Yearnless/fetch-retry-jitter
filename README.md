# fetch-retry-jitter

Zero-dependency `fetch` wrapper that adds resilient retry behavior — exponential backoff with **full jitter** and **`Retry-After`** compliance — for Node 22+, Bun, Deno, Cloudflare Workers, and browsers.

**No dependencies. No polyfills. Tree-shakeable. Under 1 kB minified + gzipped.**

## Why

Native `fetch` has no retry behavior. Existing solutions pull dependency trees (`p-retry`, `axios-retry`) or assume Node-only APIs. Everyone else hand-rolls a backoff loop — usually without jitter, which is exactly what turns a rate-limited upstream into a thundering herd.

```bash
npm install fetch-retry-jitter
```

## Usage

```ts
import { fetchRetry } from 'fetch-retry-jitter';

// Drop-in: same signature as fetch, plus an optional third argument.
const res = await fetchRetry('https://api.example.com/v1/data');
```

```ts
import fetchRetry from 'fetch-retry-jitter'; // default export also available

const res = await fetchRetry(
  'https://api.example.com/v1/data',
  { headers: { authorization: `Bearer ${token}` } },
  {
    retries: 5,
    baseDelayMs: 300,
    maxDelayMs: 10_000,
    statusCodes: [408, 429, 500, 502, 503, 504],
    onRetry: (error, attempt, delayMs) =>
      console.warn(`retry #${attempt} in ${delayMs}ms:`, error),
  }
);
```

## Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `retries` | `number` | `3` | Additional attempts after the initial request. |
| `baseDelayMs` | `number` | `300` | First backoff window, in milliseconds. |
| `maxDelayMs` | `number` | `5000` | Hard cap on every backoff window — **including** `Retry-After`. |
| `statusCodes` | `number[]` | `[408, 429, 500, 502, 503, 504]` | Statuses that trigger a retry (replaces the default set). |
| `onRetry` | `(error, attempt, delayMs) => void` | — | Invoked before each backoff sleep. |

## Retry semantics

- **Full jitter** — each backoff delay is drawn uniformly from `[0, min(maxDelayMs, baseDelayMs · 2^attempt))`, the "full jitter" variant recommended in AWS's *Exponential Backoff and Jitter* guidance. Full (rather than "equal") jitter spreads retries across the whole window, which is what prevents synchronized retry storms.
- **`Retry-After` wins** — when a retryable response carries `Retry-After` (delay-seconds or HTTP-date), that exact value is used, clamped by `maxDelayMs` so a hostile server can't stall your worker.
- **Network errors retry too** — connection resets and DNS failures are retried like transient 5xx responses.
- **Sockets are released** — a retryable response's body is cancelled before sleeping, so the connection returns to the pool instead of hanging open for the whole backoff.
- **`AbortSignal` is respected** — aborting during a backoff rejects immediately with the signal's reason, and caller-initiated aborts are never retried.

## Compatibility

Requires `Promise.withResolvers` (ES2024): Node 22+, Bun, Deno, Cloudflare Workers, and browsers Chrome 119+ / Safari 17.4+ / Firefox 121+. Dual ESM/CJS builds; `types` included.

## Comparison

| | `fetch-retry-jitter` | `p-retry` | `axios-retry` |
| :--- | :--- | :--- | :--- |
| Dependencies | 0 | dependency tree | requires axios |
| `Retry-After` support | yes | no | partial |
| Runtime | any `fetch` | Node-centric | axios only |
| Minified+gzip | < 1 kB | larger | larger |

## License

MIT
