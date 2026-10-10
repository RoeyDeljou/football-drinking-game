import { afterEach, describe, expect, it } from 'vitest';
import type {
  Competition,
  CompetitionId,
  DataResult,
  Fixture,
  FixtureId,
  FixtureLineups,
  FixtureQuery,
  FixturesByDateQuery,
  FootballPlayerId,
  FootballDataProvider,
  LiveMatchState,
  MatchEvent,
  Player,
  PlayerProfile,
  PlayerSeasonStats,
  ProviderKind,
  SeasonStatsQuery,
  TeamId,
} from '@fdg/football-data';
import { asCompetitionId, asFixtureId, asSeasonId, asTeamId, fail, ok } from '@fdg/football-data';
import type { TestServer } from './helpers.js';
import { jsonFetch, startTestServer } from './helpers.js';

/**
 * A minimal, fully controllable `FootballDataProvider`: only `listCompetitions` and
 * `getFixturesByCompetition` are exercised by these routes, everything else fails loudly if a
 * future test accidentally reaches it.
 */
class StubProvider implements FootballDataProvider {
  readonly kind: ProviderKind = 'fixture';
  calls = 0;
  /** Every `query` this stub was actually called with, in order — so a test can assert the route
   * asked for what it should have, not just that the (correctly-filtered) output looked right. */
  receivedQueries: FixtureQuery[] = [];

  constructor(
    private fixturesByCompetition: Map<string, readonly Fixture[]> = new Map(),
    private shouldFail: boolean | 'throw' = false,
  ) {}

  setFixtures(competitionId: string, fixtures: readonly Fixture[]): void {
    this.fixturesByCompetition.set(competitionId, fixtures);
  }

  setShouldFail(value: boolean | 'throw'): void {
    this.shouldFail = value;
  }

  async getFixturesByCompetition(
    competitionId: CompetitionId,
    query?: FixtureQuery,
  ): Promise<DataResult<readonly Fixture[]>> {
    this.calls += 1;
    this.receivedQueries.push(query ?? {});
    if (this.shouldFail === 'throw') throw new Error('upstream exploded');
    if (this.shouldFail) return fail('UPSTREAM', 'upstream is down');
    return ok(this.fixturesByCompetition.get(competitionId) ?? []);
  }

  async listCompetitions(): Promise<DataResult<readonly Competition[]>> {
    return ok([]);
  }

  /** Calls to `listLiveFixtures` (the only thing `window=live` may use), kept apart from `calls`. */
  liveCalls = 0;
  async listLiveFixtures(competitionId: CompetitionId): Promise<DataResult<readonly Fixture[]>> {
    this.liveCalls += 1;
    if (this.shouldFail === 'throw') throw new Error('upstream exploded');
    if (this.shouldFail) return fail('UPSTREAM', 'upstream is down');
    return ok((this.fixturesByCompetition.get(competitionId) ?? []).filter((f) => f.status === 'LIVE' || f.status === 'HALF_TIME'));
  }

  private notImplemented(): never {
    throw new Error('not implemented in StubProvider');
  }

  getFixturesByDate(_query: FixturesByDateQuery): Promise<DataResult<readonly Fixture[]>> {
    this.notImplemented();
  }
  getFixture(_fixtureId: FixtureId): Promise<DataResult<Fixture | null>> {
    this.notImplemented();
  }
  getLineups(_fixtureId: FixtureId): Promise<DataResult<FixtureLineups | null>> {
    this.notImplemented();
  }
  getSquad(_teamId: TeamId): Promise<DataResult<readonly Player[]>> {
    this.notImplemented();
  }
  getPlayerSeasonStats(_query: SeasonStatsQuery): Promise<DataResult<readonly PlayerSeasonStats[]>> {
    this.notImplemented();
  }
  getPlayerProfile(_playerId: FootballPlayerId): Promise<DataResult<PlayerProfile | null>> {
    this.notImplemented();
  }
  getPlayerProfiles(_playerIds: readonly FootballPlayerId[]): Promise<DataResult<readonly PlayerProfile[]>> {
    this.notImplemented();
  }
  getLiveMatchState(_fixtureId: FixtureId): Promise<DataResult<LiveMatchState | null>> {
    this.notImplemented();
  }
  getMatchEvents(_fixtureId: FixtureId): Promise<DataResult<readonly MatchEvent[]>> {
    this.notImplemented();
  }
}

const team = (name: string) => ({ id: asTeamId(name), name, shortName: name, crestUrl: `${name}.png`, country: null });

const fixture = (id: string, kickoffIso: string, status: Fixture['status']): Fixture => ({
  id: asFixtureId(id),
  competitionId: asCompetitionId('premier-league'),
  season: asSeasonId('2026/27'),
  kickoff: kickoffIso,
  status,
  minute: status === 'LIVE' ? 12 : null,
  homeTeam: team('Home FC'),
  awayTeam: team('Away FC'),
  score: null,
  halfTimeScore: null,
  venue: null,
  round: null,
});

/**
 * Every test in this file boots its own real server (Prisma migrate included), same as every other
 * integration suite in this repo — see `helpers.ts` and e.g. `auth.test.ts` / `room-game.test.ts`.
 * That routinely takes longer than vitest's default 5s test timeout, so every test that boots one
 * gets the same extended budget those other suites give it.
 */
const SERVER_BOOT_TIMEOUT_MS = 30_000;

describe('GET /competitions', () => {
  let server: TestServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it(
    'returns the seven supported competitions straight from config',
    async () => {
      server = await startTestServer({ footballData: new StubProvider() });
      const response = await jsonFetch(`${server.baseUrl}/competitions`);
      expect(response.status).toBe(200);
      const body = response.body as { competitions: readonly { id: string; code: string; name: string }[] };
      expect(body.competitions).toHaveLength(7);
      expect(body.competitions.map((c) => c.code)).toContain('CHAMPIONS_LEAGUE');
      expect(body.competitions.map((c) => c.code)).toContain('NATIONAL_TEAMS');
      expect(body.competitions.map((c) => c.id)).toContain('premier-league');
      expect(body.competitions.map((c) => c.id)).toContain('national-teams');
    },
    SERVER_BOOT_TIMEOUT_MS,
  );
});

describe('GET /competitions/:id/fixtures', () => {
  let server: TestServer | null = null;
  let provider: StubProvider;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it(
    '400s for an unknown competition id, without calling the provider',
    async () => {
      provider = new StubProvider();
      server = await startTestServer({ footballData: provider });
      const response = await jsonFetch(`${server.baseUrl}/competitions/not-a-real-league/fixtures`);
      expect(response.status).toBe(400);
      expect((response.body as { error: { code: string } }).error.code).toBe('UNKNOWN_COMPETITION');
      expect(provider.calls).toBe(0);
    },
    SERVER_BOOT_TIMEOUT_MS,
  );

  it(
    '400s for an invalid window query value',
    async () => {
      provider = new StubProvider();
      server = await startTestServer({ footballData: provider });
      const response = await jsonFetch(`${server.baseUrl}/competitions/premier-league/fixtures?window=whenever`);
      expect(response.status).toBe(400);
      expect((response.body as { error: { code: string } }).error.code).toBe('INVALID_QUERY');
    },
    SERVER_BOOT_TIMEOUT_MS,
  );

  it(
    'returns an empty array with 200 when there are no matching fixtures',
    async () => {
      provider = new StubProvider();
      server = await startTestServer({ footballData: provider });
      const response = await jsonFetch(`${server.baseUrl}/competitions/premier-league/fixtures`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ fixtures: [] });
    },
    SERVER_BOOT_TIMEOUT_MS,
  );

  it(
    'asks the provider for a 14-day upcoming window (from=now to=now+14d), not an unbounded call',
    async () => {
      // Regression: against the real ESPN provider, calling `getFixturesByCompetition` with no
      // `from`/`to` returns only a single day's scoreboard, so the route's own (correct) filtering
      // logic had nothing to filter — Premier League and La Liga both came back with 0 upcoming
      // fixtures live. Assert on the call the route actually makes, not just the filtered output,
      // so this regresses loudly even when a stub provider's filtered result would look fine either way.
      provider = new StubProvider(new Map([['premier-league', []]]));
      server = await startTestServer({ footballData: provider });

      const beforeMs = Date.now();
      const response = await jsonFetch(`${server.baseUrl}/competitions/premier-league/fixtures`);
      const afterMs = Date.now();
      expect(response.status).toBe(200);

      expect(provider.calls).toBe(1);
      const query = provider.receivedQueries[0];
      expect(query?.from).toBeDefined();
      expect(query?.to).toBeDefined();
      const fromMs = Date.parse(query!.from!);
      const toMs = Date.parse(query!.to!);
      expect(Number.isNaN(fromMs)).toBe(false);
      expect(Number.isNaN(toMs)).toBe(false);

      // `from` is today (allowing for the request's own execution time), `to` is ~14 days later.
      const dayMs = 24 * 60 * 60 * 1000;
      expect(fromMs).toBeGreaterThanOrEqual(beforeMs - dayMs);
      expect(fromMs).toBeLessThanOrEqual(afterMs);
      const spanMs = toMs - fromMs;
      expect(spanMs).toBeGreaterThanOrEqual(13 * dayMs);
      expect(spanMs).toBeLessThanOrEqual(15 * dayMs);
    },
    SERVER_BOOT_TIMEOUT_MS,
  );

  it(
    'returns DATA_UNAVAILABLE (not a 500) when the provider fails',
    async () => {
      provider = new StubProvider(new Map(), true);
      server = await startTestServer({ footballData: provider });
      const response = await jsonFetch(`${server.baseUrl}/competitions/premier-league/fixtures`);
      expect(response.status).toBe(503);
      const body = response.body as { error: { code: string; message: string } };
      expect(body.error.code).toBe('DATA_UNAVAILABLE');
      // Sanitized: the raw upstream error text ("upstream is down") never reaches the client.
      expect(body.error.message).not.toContain('upstream is down');
    },
    SERVER_BOOT_TIMEOUT_MS,
  );

  it(
    'returns a clean DATA_UNAVAILABLE 503 (not a raw 500) when the provider throws instead of rejecting',
    async () => {
      provider = new StubProvider(new Map(), 'throw');
      server = await startTestServer({ footballData: provider });
      const response = await jsonFetch(`${server.baseUrl}/competitions/premier-league/fixtures`);
      expect(response.status).toBe(503);
      const body = response.body as { error: { code: string; message: string } };
      expect(body.error.code).toBe('DATA_UNAVAILABLE');
      expect(body.error.message).not.toContain('upstream exploded');
    },
    SERVER_BOOT_TIMEOUT_MS,
  );

  it(
    'filters and orders: live fixture first, then upcoming within 14 days; excludes past/postponed/too-far',
    async () => {
      const now = Date.now();
      const live = fixture('live-1', new Date(now - 10 * 60_000).toISOString(), 'LIVE');
      const soon = fixture('soon', new Date(now + 24 * 3_600_000).toISOString(), 'SCHEDULED');
      const later = fixture('later', new Date(now + 10 * 24 * 3_600_000).toISOString(), 'SCHEDULED');
      const tooFar = fixture('too-far', new Date(now + 20 * 24 * 3_600_000).toISOString(), 'SCHEDULED');
      const past = fixture('past', new Date(now - 20 * 24 * 3_600_000).toISOString(), 'FINISHED');
      provider = new StubProvider(new Map([['premier-league', [tooFar, past, later, live, soon]]]));
      server = await startTestServer({ footballData: provider });

      const response = await jsonFetch(`${server.baseUrl}/competitions/premier-league/fixtures`);
      expect(response.status).toBe(200);
      const body = response.body as { fixtures: readonly { fixtureId: string; status: string }[] };
      expect(body.fixtures.map((f) => f.fixtureId)).toEqual(['live-1', 'soon', 'later']);
      const first = body.fixtures[0];
      expect(first).toMatchObject({
        status: 'LIVE',
        homeTeam: { name: 'Home FC', crestUrl: 'Home FC.png' },
        awayTeam: { name: 'Away FC' },
      });
    },
    SERVER_BOOT_TIMEOUT_MS,
  );

  it(
    'window=live and window=upcoming narrow the combined list',
    async () => {
      const now = Date.now();
      const live = fixture('live-1', new Date(now - 10 * 60_000).toISOString(), 'LIVE');
      const soon = fixture('soon', new Date(now + 24 * 3_600_000).toISOString(), 'SCHEDULED');
      provider = new StubProvider(new Map([['premier-league', [live, soon]]]));
      server = await startTestServer({ footballData: provider });

      const liveOnly = await jsonFetch(`${server.baseUrl}/competitions/premier-league/fixtures?window=live`);
      expect((liveOnly.body as { fixtures: { fixtureId: string }[] }).fixtures.map((f) => f.fixtureId)).toEqual([
        'live-1',
      ]);

      const upcomingOnly = await jsonFetch(`${server.baseUrl}/competitions/premier-league/fixtures?window=upcoming`);
      expect(
        (upcomingOnly.body as { fixtures: { fixtureId: string }[] }).fixtures.map((f) => f.fixtureId),
      ).toEqual(['soon']);
    },
    SERVER_BOOT_TIMEOUT_MS,
  );

  it(
    'window=live uses the current scoreboard only (one listLiveFixtures call, no 14-day walk), is fast, and is cached briefly',
    async () => {
      const now = Date.now();
      provider = new StubProvider(new Map([['premier-league', [fixture('live-1', new Date(now - 600_000).toISOString(), 'LIVE')]]]));
      server = await startTestServer({ footballData: provider });

      const started = Date.now();
      const first = await jsonFetch(`${server.baseUrl}/competitions/premier-league/fixtures?window=live`);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect((first.body as { fixtures: { fixtureId: string }[] }).fixtures.map((f) => f.fixtureId)).toEqual(['live-1']);
      expect(provider.liveCalls).toBe(1);
      expect(provider.calls).toBe(0); // never the dated getFixturesByCompetition walk
      expect(provider.receivedQueries).toEqual([]);

      await jsonFetch(`${server.baseUrl}/competitions/premier-league/fixtures?window=live`);
      expect(provider.liveCalls).toBe(1); // inside the live TTL: served from the short cache
    },
    SERVER_BOOT_TIMEOUT_MS,
  );

  it(
    'window=open returns live + scheduled-within-30-min from the current scoreboard only (one call, no date window)',
    async () => {
      const now = Date.now();
      provider = new StubProvider(
        new Map([
          [
            'premier-league',
            [
              fixture('live-1', new Date(now - 600_000).toISOString(), 'LIVE'),
              fixture('soon-20', new Date(now + 20 * 60_000).toISOString(), 'SCHEDULED'),
              fixture('later-45', new Date(now + 45 * 60_000).toISOString(), 'SCHEDULED'),
              fixture('done', new Date(now - 3 * 3_600_000).toISOString(), 'FINISHED'),
            ],
          ],
        ]),
      );
      server = await startTestServer({ footballData: provider });
      const response = await jsonFetch(`${server.baseUrl}/competitions/premier-league/fixtures?window=open`);
      expect((response.body as { fixtures: { fixtureId: string }[] }).fixtures.map((f) => f.fixtureId)).toEqual(['live-1', 'soon-20']);
      // Current scoreboard only (no from/to), at most one extra day-call near midnight ET, no listLiveFixtures.
      expect(provider.liveCalls).toBe(0);
      expect(provider.calls).toBeLessThanOrEqual(2);
      expect(provider.receivedQueries[0]).toEqual({});
      // Cached briefly: a second request does not call the provider again.
      const callsBefore = provider.calls;
      await jsonFetch(`${server.baseUrl}/competitions/premier-league/fixtures?window=open`);
      expect(provider.calls).toBe(callsBefore);
    },
    SERVER_BOOT_TIMEOUT_MS,
  );

  it(
    'window=live reflects a status change after the live TTL (a finished match drops off)',
    async () => {
      const now = Date.now();
      provider = new StubProvider(new Map([['premier-league', [fixture('live-1', new Date(now - 600_000).toISOString(), 'LIVE')]]]));
      server = await startTestServer({ footballData: provider, fixtureListCacheTtlMs: 50 });
      const ids = async () =>
        ((await jsonFetch(`${server!.baseUrl}/competitions/premier-league/fixtures?window=live`)).body as { fixtures: { fixtureId: string }[] }).fixtures.map((f) => f.fixtureId);
      expect(await ids()).toEqual(['live-1']);
      provider.setFixtures('premier-league', [fixture('live-1', new Date(now - 600_000).toISOString(), 'FINISHED')]);
      expect(await ids()).toEqual(['live-1']); // still inside the 15s live window
    },
    SERVER_BOOT_TIMEOUT_MS,
  );

  it(
    'caches: two requests inside the TTL hit the provider once; a request after expiry hits it again',
    async () => {
      provider = new StubProvider(new Map([['premier-league', []]]));
      server = await startTestServer({ footballData: provider, fixtureListCacheTtlMs: 200 });

      await jsonFetch(`${server.baseUrl}/competitions/premier-league/fixtures`);
      await jsonFetch(`${server.baseUrl}/competitions/premier-league/fixtures`);
      expect(provider.calls).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 250));
      await jsonFetch(`${server.baseUrl}/competitions/premier-league/fixtures`);
      expect(provider.calls).toBe(2);
    },
    SERVER_BOOT_TIMEOUT_MS,
  );
});
