import { describe, expect, it } from 'vitest';

import { createManualClock } from '../clock.js';
import { COMPETITIONS } from '../competitions.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../http.js';
import { EspnProvider } from './espn-provider.js';

const LA_LIGA = COMPETITIONS.LA_LIGA;

function scoreboardBody(eventId: string) {
  return {
    leagues: [{ slug: 'esp.1', season: { year: 2026 } }],
    events: [
      {
        id: eventId,
        date: '2026-09-16T17:00Z',
        season: { year: 2026, slug: null },
        status: { clock: 0, displayClock: '', period: 0, type: { name: 'STATUS_SCHEDULED', state: 'pre' } },
        competitions: [
          {
            id: eventId,
            date: '2026-09-16T17:00Z',
            status: { clock: 0, displayClock: '', period: 0, type: { name: 'STATUS_SCHEDULED', state: 'pre' } },
            venue: { fullName: 'Test Stadium' },
            competitors: [
              { id: 'h', homeAway: 'home', score: '0', team: { id: '1', displayName: 'Home FC' } },
              { id: 'a', homeAway: 'away', score: '0', team: { id: '2', displayName: 'Away FC' } },
            ],
          },
        ],
      },
    ],
  };
}

/** Serves a fixed queue of responses (or throws) per call, recording every request made. */
function scriptedHttp(responses: readonly (HttpResponse | Error)[]): { http: HttpClient; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  let index = 0;
  return {
    requests,
    http: {
      request: (request: HttpRequest): Promise<HttpResponse> => {
        requests.push(request);
        const next = responses[Math.min(index, responses.length - 1)];
        index += 1;
        if (next instanceof Error) return Promise.reject(next);
        if (next === undefined) return Promise.reject(new Error('no scripted response'));
        return Promise.resolve(next);
      },
    },
  };
}

const okResponse = (body: unknown): HttpResponse => ({ status: 200, body, headers: {} });

describe('EspnProvider — sends a descriptive User-Agent', () => {
  it('includes the configured User-Agent header on every request', async () => {
    const clock = createManualClock();
    const { http, requests } = scriptedHttp([okResponse(scoreboardBody('1'))]);
    const provider = new EspnProvider({ userAgent: 'TestAgent/1.0 (+https://example.test)', http, clock });
    await provider.getFixturesByCompetition(LA_LIGA.id);
    expect(requests[0]?.headers['user-agent']).toBe('TestAgent/1.0 (+https://example.test)');
  });
});

describe('EspnProvider — caching and coalescing (through the shared upstream pipeline)', () => {
  it('caches a scoreboard response and does not re-fetch within the TTL', async () => {
    const clock = createManualClock();
    const { http, requests } = scriptedHttp([okResponse(scoreboardBody('1'))]);
    const provider = new EspnProvider({ http, clock });

    const first = await provider.getFixturesByCompetition(LA_LIGA.id);
    const second = await provider.getFixturesByCompetition(LA_LIGA.id);
    expect(first.ok && second.ok).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it('coalesces concurrent identical requests into a single upstream call', async () => {
    const clock = createManualClock();
    let calls = 0;
    const http: HttpClient = {
      request: async (): Promise<HttpResponse> => {
        calls += 1;
        await Promise.resolve();
        return okResponse(scoreboardBody('1'));
      },
    };
    const provider = new EspnProvider({ http, clock });
    const results = await Promise.all([
      provider.getFixturesByCompetition(LA_LIGA.id),
      provider.getFixturesByCompetition(LA_LIGA.id),
      provider.getFixturesByCompetition(LA_LIGA.id),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(calls).toBe(1);
  });

  it('re-fetches once the TTL has expired', async () => {
    const clock = createManualClock();
    const { http, requests } = scriptedHttp([okResponse(scoreboardBody('1')), okResponse(scoreboardBody('1'))]);
    const provider = new EspnProvider({ http, clock, cacheTtl: { fixtures: 1_000 } });
    await provider.getFixturesByCompetition(LA_LIGA.id);
    await clock.advance(1_001);
    await provider.getFixturesByCompetition(LA_LIGA.id);
    expect(requests).toHaveLength(2);
  });
});

describe('EspnProvider — retry/backoff on 429, through the injected clock', () => {
  it('retries a 429 and succeeds, waiting through the clock rather than a real timer', async () => {
    const clock = createManualClock();
    const { http, requests } = scriptedHttp([
      { status: 429, body: {}, headers: {} },
      okResponse(scoreboardBody('1')),
    ]);
    const provider = new EspnProvider({ http, clock, retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 2_000, jitter: false } });

    const pending = provider.getFixturesByCompetition(LA_LIGA.id);
    await clock.advance(500);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it('a 403 (ESPN edge blocking the User-Agent) surfaces a message explaining why', async () => {
    const clock = createManualClock();
    const { http } = scriptedHttp([{ status: 403, body: 'Access Denied', headers: {} }]);
    const provider = new EspnProvider({ http, clock });
    const result = await provider.getFixturesByCompetition(LA_LIGA.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('User-Agent');
  });
});

describe('EspnProvider — malformed upstream payloads degrade to a typed failure', () => {
  it('a body that does not match the scoreboard schema at all becomes INVALID_RESPONSE, not a crash', async () => {
    const clock = createManualClock();
    const { http } = scriptedHttp([okResponse({ this: 'is not a scoreboard' })]);
    const provider = new EspnProvider({ http, clock });
    const result = await provider.getFixturesByCompetition(LA_LIGA.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('INVALID_RESPONSE');
    expect(result.error.retryable).toBe(false);
  });

  it('a non-JSON body (HTML error page) also degrades to INVALID_RESPONSE', async () => {
    const clock = createManualClock();
    const { http } = scriptedHttp([{ status: 200, body: '<html>not json</html>', headers: {} }]);
    const provider = new EspnProvider({ http, clock });
    const result = await provider.getFixturesByCompetition(LA_LIGA.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('INVALID_RESPONSE');
  });
});

describe('EspnProvider — unsupported competition', () => {
  it('fails fast on an unknown competition id rather than making a request', async () => {
    const clock = createManualClock();
    const { http, requests } = scriptedHttp([okResponse(scoreboardBody('1'))]);
    const provider = new EspnProvider({ http, clock });
    const result = await provider.getFixturesByCompetition('not-a-real-competition' as never);
    expect(result.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });
});
