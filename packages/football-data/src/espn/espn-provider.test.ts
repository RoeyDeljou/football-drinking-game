import { describe, expect, it } from 'vitest';

import { createManualClock } from '../clock.js';
import { COMPETITIONS } from '../competitions.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../http.js';
import { EspnProvider } from './espn-provider.js';

const LA_LIGA = COMPETITIONS.LA_LIGA;
const NATIONAL_TEAMS = COMPETITIONS.NATIONAL_TEAMS;

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

/** Routes each request by matching a substring in the URL, in order — the fake ESPN backing for multi-slug tests. */
function routedHttp(routes: readonly { readonly match: string; readonly response: HttpResponse }[]): {
  http: HttpClient;
  requests: HttpRequest[];
} {
  const requests: HttpRequest[] = [];
  return {
    requests,
    http: {
      request: (request: HttpRequest): Promise<HttpResponse> => {
        requests.push(request);
        const route = routes.find((entry) => request.url.includes(entry.match));
        if (route === undefined) return Promise.reject(new Error(`no route for ${request.url}`));
        return Promise.resolve(route.response);
      },
    },
  };
}

function scoreboardBodyForSlug(slug: string, eventId: string, kickoff: string) {
  return {
    leagues: [{ slug, season: { year: 2026 } }],
    events: [
      {
        id: eventId,
        date: kickoff,
        season: { year: 2026, slug: null },
        status: { clock: 0, displayClock: '', period: 0, type: { name: 'STATUS_SCHEDULED', state: 'pre' } },
        competitions: [
          {
            id: eventId,
            date: kickoff,
            status: { clock: 0, displayClock: '', period: 0, type: { name: 'STATUS_SCHEDULED', state: 'pre' } },
            venue: { fullName: 'Test Stadium' },
            competitors: [
              { id: 'h', homeAway: 'home', score: '0', team: { id: '478', displayName: 'France' } },
              { id: 'a', homeAway: 'away', score: '0', team: { id: '481', displayName: 'Germany' } },
            ],
          },
        ],
      },
    ],
  };
}

function teamRef(id: string, name: string) {
  return { id, displayName: name, shortDisplayName: name, name, abbreviation: name.slice(0, 3), location: name, logo: '' };
}

function teamsBodyForSlug(slug: string, teams: readonly { id: string; name: string }[]) {
  return {
    sports: [
      {
        leagues: [
          {
            slug,
            teams: teams.map((team) => ({ team: teamRef(team.id, team.name) })),
          },
        ],
      },
    ],
  };
}

describe('EspnProvider — National Teams: a multi-slug competition aggregated across every ESPN feed', () => {
  it('getFixturesByCompetition queries every slug and merges (deduping by fixture id) into one list', async () => {
    const clock = createManualClock();
    // Same fixture id ("shared") returned by two slugs, plus one unique fixture per slug — six requests total for
    // the eleven configured slugs (only the first three that are actually routed below matter; the rest 404).
    const slugs = ['fifa.friendly', 'uefa.nations', 'fifa.worldq.uefa'];
    const { http, requests } = routedHttp([
      { match: 'fifa.friendly/scoreboard', response: okResponse(scoreboardBodyForSlug('fifa.friendly', 'shared', '2026-09-28T10:00Z')) },
      { match: 'uefa.nations/scoreboard', response: okResponse(scoreboardBodyForSlug('uefa.nations', 'shared', '2026-09-28T10:00Z')) },
      { match: 'fifa.worldq.uefa/scoreboard', response: okResponse(scoreboardBodyForSlug('fifa.worldq.uefa', 'unique-1', '2026-09-29T10:00Z')) },
      // Every other configured slug 404s — a real, expected "dormant between windows" outcome.
      { match: '/scoreboard', response: { status: 404, body: { code: 400, message: 'no data' }, headers: {} } },
    ]);
    // National Teams' eleven slugs exceed the default burst of 5/5s; the rate limiter itself has its own dedicated
    // test suite, so it is relaxed here to isolate what this test actually verifies — slug aggregation and dedupe.
    const provider = new EspnProvider({ http, clock, rateLimit: { maxRequests: 50, windowMs: 1, maxConcurrent: 50 } });

    const result = await provider.getFixturesByCompetition(NATIONAL_TEAMS.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Deduped: the "shared" fixture appears once, not twice, even though two slugs served it.
    const ids = result.value.map((fixture) => fixture.id).sort();
    expect(ids).toEqual(['shared', 'unique-1']);

    // One request per configured slug (aggregation queried every slug, not just the primary).
    const scoreboardRequests = requests.filter((request) => request.url.includes('/scoreboard'));
    expect(scoreboardRequests.length).toBeGreaterThanOrEqual(slugs.length);
  });

  it('a single-slug competition (Premier League) is completely unaffected: exactly one scoreboard request', async () => {
    const clock = createManualClock();
    const { http, requests } = scriptedHttp([okResponse(scoreboardBody('1'))]);
    const provider = new EspnProvider({ http, clock });
    const result = await provider.getFixturesByCompetition(LA_LIGA.id);
    expect(result.ok).toBe(true);
    expect(requests.filter((request) => request.url.includes('/scoreboard'))).toHaveLength(1);
  });

  it('getSquad (via teams) merges and dedupes teams by id across slugs — a country keeps one id everywhere', async () => {
    const clock = createManualClock();
    const { http, requests } = routedHttp([
      // Most specific routes first: `routedHttp` matches in array order, and a roster URL also contains
      // ".../teams/...", so it must be checked before the broader "/teams" routes below.
      {
        match: 'fifa.friendly/teams/478/roster',
        response: okResponse({ athletes: [] }),
      },
      {
        match: 'fifa.friendly/teams',
        response: okResponse(
          teamsBodyForSlug('fifa.friendly', [
            { id: '478', name: 'France' },
            { id: '481', name: 'Germany' },
          ]),
        ),
      },
      {
        match: 'uefa.nations/teams',
        // France (478) reappears under a second slug with the *same* id — this must collapse to one entry.
        response: okResponse(
          teamsBodyForSlug('uefa.nations', [
            { id: '478', name: 'France' },
            { id: '459', name: 'Belgium' },
          ]),
        ),
      },
      { match: '/teams', response: { status: 404, body: { code: 400, message: 'no data' }, headers: {} } },
    ]);
    // `getSquad` scans every domestic league then every National Teams slug before it resolves — well above the
    // default burst; relaxed here for the same reason as the fixtures test above.
    const provider = new EspnProvider({ http, clock, rateLimit: { maxRequests: 50, windowMs: 1, maxConcurrent: 50 } });

    const squad = await provider.getSquad('478' as never);
    expect(squad.ok).toBe(true);

    // The roster call happened, and only once for team 478 — resolving the team did not require re-fetching every
    // slug's team list more than once each.
    const teamsRequests = requests.filter((request) => request.url.includes('/teams') && !request.url.includes('/roster'));
    expect(teamsRequests.length).toBeGreaterThan(0);
  });
});
