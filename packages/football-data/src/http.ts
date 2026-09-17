/**
 * The HTTP port plus the retry/backoff policy that sits on top of it.
 *
 * `HttpClient` is an interface so tests drive the API-Football adapter from recorded payloads with no network and
 * no API key. The default implementation is a thin wrapper over global `fetch`.
 *
 * Retry rules: 429 and 5xx are retried with exponential backoff (honouring `Retry-After` when present); network
 * errors and timeouts are retried; 4xx other than 429 are not, because repeating them only burns quota.
 */

import type { DataClock } from './clock.js';
import type { DataResult } from './result.js';
import { describeThrown, fail, ok } from './result.js';

export interface HttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface HttpResponse {
  readonly status: number;
  /** Parsed JSON body, or the raw text when the body was not JSON. */
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export interface RetryConfig {
  /** Total attempts including the first. 1 disables retrying. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Multiply the delay by a random factor in [0.5, 1.5) to avoid thundering herds. */
  readonly jitter: boolean;
  /** Injected randomness, so jitter is reproducible in tests. */
  readonly random?: (() => number) | undefined;
}

export const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  jitter: true,
};

export const DEFAULT_TIMEOUT_MS = 10_000;

/** `fetch`-backed client. The only place in this package that performs real I/O. */
export function createFetchHttpClient(): HttpClient {
  return {
    async request(request: HttpRequest): Promise<HttpResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, request.timeoutMs);
      try {
        const response = await fetch(request.url, {
          method: 'GET',
          headers: { ...request.headers },
          signal: controller.signal,
        });
        const text = await response.text();
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
        return { status: response.status, body: parseMaybeJson(text), headers };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function parseMaybeJson(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export interface RequestWithRetryOptions {
  readonly http: HttpClient;
  readonly clock: DataClock;
  readonly retry: RetryConfig;
  readonly request: HttpRequest;
}

export interface RetryTelemetry {
  readonly attempts: number;
  readonly delaysMs: readonly number[];
}

export interface HttpOutcome {
  readonly response: HttpResponse;
  readonly telemetry: RetryTelemetry;
}

/**
 * Perform the request, retrying retryable failures with exponential backoff.
 * Returns a `DataResult` — it never throws, whatever the transport does.
 */
export async function requestWithRetry(options: RequestWithRetryOptions): Promise<DataResult<HttpOutcome>> {
  const { http, clock, retry, request } = options;
  const maxAttempts = Math.max(1, retry.maxAttempts);
  const delaysMs: number[] = [];
  let attempt = 0;
  let lastMessage = 'request failed';
  let lastStatus: number | null = null;
  let lastKind: 'NETWORK' | 'RATE_LIMITED' | 'UPSTREAM' | 'TIMEOUT' = 'NETWORK';

  for (;;) {
    attempt += 1;
    let response: HttpResponse | null = null;
    try {
      response = await http.request(request);
    } catch (thrown) {
      const message = describeThrown(thrown);
      const aborted = thrown instanceof Error && (thrown.name === 'AbortError' || thrown.name === 'TimeoutError');
      lastKind = aborted ? 'TIMEOUT' : 'NETWORK';
      lastMessage = aborted ? `request timed out after ${String(request.timeoutMs)}ms` : message;
      lastStatus = null;
    }

    if (response !== null) {
      if (response.status < 400) {
        return ok({ response, telemetry: { attempts: attempt, delaysMs } });
      }
      lastStatus = response.status;
      if (response.status === 429) {
        lastKind = 'RATE_LIMITED';
        lastMessage = 'upstream rate limit reached (HTTP 429)';
      } else if (response.status >= 500) {
        lastKind = 'UPSTREAM';
        lastMessage = `upstream error (HTTP ${String(response.status)})`;
      } else {
        const kind = response.status === 401 || response.status === 403 ? 'NOT_CONFIGURED' : 'BAD_REQUEST';
        const message =
          kind === 'NOT_CONFIGURED'
            ? `upstream rejected the credentials (HTTP ${String(response.status)})`
            : `upstream rejected the request (HTTP ${String(response.status)})`;
        return fail(kind, message, { status: response.status, retryable: false, attempts: attempt });
      }
    }

    if (attempt >= maxAttempts) {
      return fail(lastKind, lastMessage, { status: lastStatus, retryable: true, attempts: attempt });
    }

    const delay = backoffDelayMs(attempt, retry, response === null ? null : retryAfterMs(response.headers));
    delaysMs.push(delay);
    await clock.sleep(delay);
  }
}

/** Exponential backoff for `attempt` (1-based), capped, optionally jittered, overridden by `Retry-After`. */
export function backoffDelayMs(attempt: number, retry: RetryConfig, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, retry.maxDelayMs);
  const exponential = retry.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, retry.maxDelayMs);
  if (!retry.jitter) return capped;
  const random = retry.random ?? Math.random;
  return Math.round(capped * (0.5 + random()));
}

function retryAfterMs(headers: Readonly<Record<string, string>>): number | null {
  const raw = headers['retry-after'];
  if (raw === undefined) return null;
  const seconds = Number.parseFloat(raw);
  if (Number.isNaN(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}
