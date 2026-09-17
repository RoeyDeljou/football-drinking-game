import { describe, expect, it } from 'vitest';

import { createManualClock } from './clock.js';
import type { HttpClient, HttpRequest, HttpResponse, RetryConfig } from './http.js';
import { backoffDelayMs, requestWithRetry } from './http.js';

const NO_JITTER: RetryConfig = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 8_000, jitter: false };

const request: HttpRequest = { url: 'https://example.test/v3/fixtures', headers: {}, timeoutMs: 1_000 };

function scriptedClient(responses: readonly (HttpResponse | Error)[]): {
  client: HttpClient;
  calls: () => number;
} {
  let index = 0;
  return {
    calls: () => index,
    client: {
      request: (): Promise<HttpResponse> => {
        const next = responses[Math.min(index, responses.length - 1)];
        index += 1;
        if (next instanceof Error) return Promise.reject(next);
        if (next === undefined) return Promise.reject(new Error('no scripted response'));
        return Promise.resolve(next);
      },
    },
  };
}

const response = (status: number, body: unknown = {}, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  body,
  headers,
});

describe('backoffDelayMs', () => {
  it('grows exponentially and caps at maxDelayMs', () => {
    expect(backoffDelayMs(1, NO_JITTER, null)).toBe(500);
    expect(backoffDelayMs(2, NO_JITTER, null)).toBe(1_000);
    expect(backoffDelayMs(3, NO_JITTER, null)).toBe(2_000);
    expect(backoffDelayMs(9, NO_JITTER, null)).toBe(8_000);
  });

  it('applies jitter through the injected random source', () => {
    const jittered: RetryConfig = { ...NO_JITTER, jitter: true, random: () => 0.25 };
    expect(backoffDelayMs(2, jittered, null)).toBe(750);
  });

  it('prefers Retry-After over the exponential schedule, still capped', () => {
    expect(backoffDelayMs(1, NO_JITTER, 3_000)).toBe(3_000);
    expect(backoffDelayMs(1, NO_JITTER, 99_000)).toBe(8_000);
  });
});

describe('requestWithRetry', () => {
  it('returns immediately on success', async () => {
    const clock = createManualClock();
    const { client, calls } = scriptedClient([response(200, { response: [] })]);
    const result = await requestWithRetry({ http: client, clock, retry: NO_JITTER, request });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.telemetry.attempts).toBe(1);
    expect(calls()).toBe(1);
    expect(clock.now()).toBe(0);
  });

  it('backs off on 429 and succeeds on a later attempt', async () => {
    const clock = createManualClock();
    const { client, calls } = scriptedClient([
      response(429, {}, {}),
      response(429, {}, {}),
      response(200, { response: [1] }),
    ]);

    const pending = requestWithRetry({ http: client, clock, retry: NO_JITTER, request });
    // Two retries at 500ms then 1000ms.
    await clock.advance(500);
    await clock.advance(1_000);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.telemetry.attempts).toBe(3);
    expect(result.ok && result.value.telemetry.delaysMs).toEqual([500, 1_000]);
    expect(calls()).toBe(3);
    expect(clock.now()).toBe(1_500);
  });

  it('honours Retry-After on a 429', async () => {
    const clock = createManualClock();
    const { client } = scriptedClient([response(429, {}, { 'retry-after': '2' }), response(200, {})]);

    const pending = requestWithRetry({ http: client, clock, retry: NO_JITTER, request });
    await clock.advance(2_000);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.telemetry.delaysMs).toEqual([2_000]);
  });

  it('gives up after maxAttempts and reports RATE_LIMITED with the attempt count', async () => {
    const clock = createManualClock();
    const retry: RetryConfig = { ...NO_JITTER, maxAttempts: 3 };
    const { client, calls } = scriptedClient([response(429), response(429), response(429)]);

    const pending = requestWithRetry({ http: client, clock, retry, request });
    await clock.advance(500);
    await clock.advance(1_000);
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('RATE_LIMITED');
    expect(result.error.status).toBe(429);
    expect(result.error.attempts).toBe(3);
    expect(result.error.retryable).toBe(true);
    expect(calls()).toBe(3);
  });

  it('retries 5xx', async () => {
    const clock = createManualClock();
    const { client } = scriptedClient([response(503), response(200, { ok: true })]);
    const pending = requestWithRetry({ http: client, clock, retry: NO_JITTER, request });
    await clock.advance(500);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.telemetry.attempts).toBe(2);
  });

  it('does not retry a 4xx other than 429, so quota is not wasted', async () => {
    const clock = createManualClock();
    const { client, calls } = scriptedClient([response(404)]);
    const result = await requestWithRetry({ http: client, clock, retry: NO_JITTER, request });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('BAD_REQUEST');
    expect(result.error.retryable).toBe(false);
    expect(calls()).toBe(1);
  });

  it('maps 401/403 to NOT_CONFIGURED without retrying', async () => {
    const clock = createManualClock();
    const { client, calls } = scriptedClient([response(403)]);
    const result = await requestWithRetry({ http: client, clock, retry: NO_JITTER, request });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('NOT_CONFIGURED');
    expect(calls()).toBe(1);
  });

  it('retries network errors and surfaces NETWORK when they persist', async () => {
    const clock = createManualClock();
    const retry: RetryConfig = { ...NO_JITTER, maxAttempts: 2 };
    const { client, calls } = scriptedClient([new Error('ECONNRESET'), new Error('ECONNRESET')]);

    const pending = requestWithRetry({ http: client, clock, retry, request });
    await clock.advance(500);
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('NETWORK');
    expect(result.error.message).toContain('ECONNRESET');
    expect(calls()).toBe(2);
  });

  it('reports an aborted request as TIMEOUT without leaking the transport error object', async () => {
    const clock = createManualClock();
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    const { client } = scriptedClient([abort]);
    const result = await requestWithRetry({ http: client, clock, retry: { ...NO_JITTER, maxAttempts: 1 }, request });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('TIMEOUT');
    expect(result.error.message).toBe('request timed out after 1000ms');
  });
});
