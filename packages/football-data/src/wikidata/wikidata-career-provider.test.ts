import { describe, expect, it } from 'vitest';

import { createManualClock } from '../clock.js';
import { asFootballPlayerId } from '../domain.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../http.js';
import { WikidataCareerProvider } from './wikidata-career-provider.js';

function sparqlResponse(bindings: readonly Record<string, { type: string; value: string }>[]): HttpResponse {
  return {
    status: 200,
    body: { head: { vars: [] }, results: { bindings } },
    headers: {},
  };
}

function candidateBinding(entityId: string, dob: string, label: string) {
  return {
    player: { type: 'uri', value: `http://www.wikidata.org/entity/${entityId}` },
    dob: { type: 'literal', value: `${dob}T00:00:00Z` },
    label: { type: 'literal', value: label },
  };
}

/** Counts real requests and lets a test inspect each query string. */
function countingHttp(respond: (request: HttpRequest) => HttpResponse): { http: HttpClient; queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    http: {
      request: (request: HttpRequest): Promise<HttpResponse> => {
        const url = new URL(request.url);
        queries.push(url.searchParams.get('query') ?? '');
        return Promise.resolve(respond(request));
      },
    },
  };
}

describe('WikidataCareerProvider — matching, batching, caching', () => {
  it('matches a player by name + date of birth and returns their career', async () => {
    const clock = createManualClock();
    let call = 0;
    const { http } = countingHttp(() => {
      call += 1;
      if (call === 1) return sparqlResponse([candidateBinding('Q1', '2000-01-01', 'Test Player')]);
      return sparqlResponse([
        {
          player: { type: 'uri', value: 'http://www.wikidata.org/entity/Q1' },
          st: { type: 'uri', value: 'http://www.wikidata.org/entity/statement/x' },
          team: { type: 'uri', value: 'http://www.wikidata.org/entity/Q2' },
          teamLabel: { type: 'literal', value: 'Some Club' },
          start: { type: 'literal', value: '2020-01-01T00:00:00Z' },
          matches: { type: 'literal', value: '10' },
          goals: { type: 'literal', value: '2' },
          types: { type: 'literal', value: '' },
        },
      ]);
    });
    // A generous local rate limit: this test is about matching/career assembly, not the (separately tested)
    // sliding-window pacing, and the default 1-request-per-2s window would otherwise wait on the manual clock.
    const provider = new WikidataCareerProvider({
      userAgent: 'Test/1.0 (+https://example.test)',
      http,
      clock,
      rateLimit: { maxRequests: 10, windowMs: 1_000, maxConcurrent: 5 },
    });

    const result = await provider.getCareers([
      { playerId: asFootballPlayerId('p1'), name: 'Test Player', dateOfBirth: '2000-01-01' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.status).toBe('matched');
    expect(result.value[0]?.career).toHaveLength(1);
    expect(result.value[0]?.career[0]?.teamName).toBe('Some Club');
  });

  it('a player with no date of birth costs no query at all', async () => {
    const clock = createManualClock();
    const { http, queries } = countingHttp(() => sparqlResponse([]));
    const provider = new WikidataCareerProvider({ userAgent: 'Test/1.0 (+https://example.test)', http, clock });

    const result = await provider.getCareers([{ playerId: asFootballPlayerId('p1'), name: 'No DOB', dateOfBirth: null }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]?.status).toBe('no-date-of-birth');
    expect(queries).toHaveLength(0);
  });

  it('caches a match and a career, so asking for the same player again makes no new request', async () => {
    const clock = createManualClock();
    let calls = 0;
    const { http } = countingHttp(() => {
      calls += 1;
      if (calls === 1) return sparqlResponse([candidateBinding('Q1', '2000-01-01', 'Test Player')]);
      return sparqlResponse([]);
    });
    const provider = new WikidataCareerProvider({
      userAgent: 'Test/1.0 (+https://example.test)',
      http,
      clock,
      rateLimit: { maxRequests: 10, windowMs: 1_000, maxConcurrent: 5 },
    });

    const lookup = { playerId: asFootballPlayerId('p1'), name: 'Test Player', dateOfBirth: '2000-01-01' };
    await provider.getCareers([lookup]);
    const before = calls;
    await provider.getCareers([lookup]);
    expect(calls).toBe(before);
  });

  it('batches several birth dates into one candidates query', async () => {
    const clock = createManualClock();
    const { http, queries } = countingHttp((request) => {
      void request;
      return sparqlResponse([]);
    });
    const provider = new WikidataCareerProvider({
      userAgent: 'Test/1.0 (+https://example.test)',
      http,
      clock,
      batchSize: 10,
    });

    await provider.getCareers([
      { playerId: asFootballPlayerId('p1'), name: 'A', dateOfBirth: '2000-01-01' },
      { playerId: asFootballPlayerId('p2'), name: 'B', dateOfBirth: '2000-01-02' },
      { playerId: asFootballPlayerId('p3'), name: 'C', dateOfBirth: '2000-01-03' },
    ]);
    // All three birth dates in one query, so exactly one candidates request was made.
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('2000-01-01');
    expect(queries[0]).toContain('2000-01-02');
    expect(queries[0]).toContain('2000-01-03');
  });

  it('enforces a hard hourly query budget and reports RATE_LIMITED rather than queueing forever', async () => {
    const clock = createManualClock();
    const { http } = countingHttp(() => sparqlResponse([]));
    const provider = new WikidataCareerProvider({
      userAgent: 'Test/1.0 (+https://example.test)',
      http,
      clock,
      maxQueriesPerHour: 1,
      batchSize: 1,
    });

    const first = await provider.getCareers([
      { playerId: asFootballPlayerId('p1'), name: 'A', dateOfBirth: '2000-01-01' },
    ]);
    expect(first.ok).toBe(true);
    expect(provider.queriesThisHour).toBe(1);

    const second = await provider.getCareers([
      { playerId: asFootballPlayerId('p2'), name: 'B', dateOfBirth: '2000-01-02' },
    ]);
    // With the budget fully spent and nothing cached yet for p2, the candidates query is refused outright and
    // that failure is returned as a typed RATE_LIMITED result rather than queueing indefinitely or crashing.
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.kind).toBe('RATE_LIMITED');
      expect(second.error.message).toContain('budget');
    }
  });

  it('never guesses: an ambiguous name/date collision yields status "ambiguous", not a match', async () => {
    const clock = createManualClock();
    const { http } = countingHttp(() =>
      sparqlResponse([
        candidateBinding('Q1', '2000-01-01', 'Same Name'),
        candidateBinding('Q2', '2000-01-01', 'Same Name'),
      ]),
    );
    const provider = new WikidataCareerProvider({ userAgent: 'Test/1.0 (+https://example.test)', http, clock });

    const result = await provider.getCareers([
      { playerId: asFootballPlayerId('p1'), name: 'Same Name', dateOfBirth: '2000-01-01' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.status).toBe('ambiguous');
    expect(result.value[0]?.career).toEqual([]);
  });
});
