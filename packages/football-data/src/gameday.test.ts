/**
 * Tests for gameday mode's data layer: `FootballDataProvider.listLiveFixtures` and
 * `MatchdayPrefetcher.runGameday`. Everything here runs offline — no network, no API key — against either the
 * recorded/offline `FixtureProvider` (fed a small hand-built in-memory dataset with several simultaneously "live"
 * fixtures) or a fully-stubbed in-memory `FootballDataProvider` fake for the cases that need precise control over
 * timing (concurrency) and failure (partial-failure policy).
 */

import { describe, expect, it } from 'vitest';

import { COMPETITIONS } from './competitions.js';
import {
  asCompetitionId,
  asFixtureId,
  asFootballPlayerId,
  asTeamId,
  type Fixture,
  type FixtureStatus,
  type Player,
  type PlayerProfile,
  type PlayerSeasonStats,
} from './domain.js';
import { createInMemoryDataSource } from './data-source.js';
import { FixtureProvider } from './fixture/fixture-provider.js';
import type { FootballDataProvider, ProviderKind } from './provider.js';
import { MatchdayPrefetcher } from './prefetch.js';
import { fail, ok, type DataResult } from './result.js';

const PL = COMPETITIONS.PREMIER_LEAGUE;
const LA_LIGA = COMPETITIONS.LA_LIGA;
const SERIE_A = COMPETITIONS.SERIE_A;

// ---- Hand-built recorded dataset: several competitions, mixed fixture statuses -----------------------------

function team(id: string, name: string) {
  return { id: asTeamId(id), name, shortName: name.slice(0, 3).toUpperCase(), crestUrl: null, country: null };
}

function player(id: string, teamId: string) {
  return {
    id: asFootballPlayerId(id),
    name: `Player ${id}`,
    fullName: null,
    nationality: null,
    dateOfBirth: null,
    age: null,
    heightCm: null,
    position: 'MF' as const,
    shirtNumber: 1,
    teamId: asTeamId(teamId),
    photoUrl: null,
    marketValueEur: null,
  };
}

function recordedFixture(
  id: string,
  competitionCode: keyof typeof COMPETITIONS,
  status: FixtureStatus,
  homeId: string,
  awayId: string,
) {
  const config = COMPETITIONS[competitionCode];
  return {
    id: asFixtureId(id),
    competitionId: config.id,
    season: config.currentSeason,
    kickoff: '2026-09-27T15:00:00.000Z',
    status,
    minute: status === 'LIVE' ? 42 : null,
    homeTeam: team(homeId, `${homeId} FC`),
    awayTeam: team(awayId, `${awayId} FC`),
    score: status === 'SCHEDULED' ? null : { home: 1, away: 0 },
    halfTimeScore: null,
    venue: null,
    round: null,
  };
}

const PROVENANCE = {
  kind: 'recorded-sample-data' as const,
  description: 'test fixture',
  recordedAt: '2026-09-27T00:00:00.000Z',
  disclaimer: 'test data',
};

function competitionFile(competitionCode: keyof typeof COMPETITIONS, fixtures: ReturnType<typeof recordedFixture>[]) {
  const config = COMPETITIONS[competitionCode];
  const teamIds = new Set<string>();
  for (const fx of fixtures) {
    teamIds.add(fx.homeTeam.id);
    teamIds.add(fx.awayTeam.id);
  }
  return {
    provenance: PROVENANCE,
    competitionCode,
    season: config.currentSeason,
    teams: [...teamIds].map((id) => team(id, `${id} FC`)),
    players: [...teamIds].map((id) => player(`${id}-p1`, id)),
    seasonStats: [],
    fixtures,
    lineups: [],
    liveStates: [],
  };
}

/**
 * Premier League: two simultaneously live fixtures (a full matchday), one scheduled, one finished.
 * La Liga: one live fixture — used to prove a competition's live list never leaks another competition's fixtures.
 * Serie A: nothing live at all — the "zero live fixtures" case.
 */
function buildDataSource() {
  const plArsenal = recordedFixture('pl-live-1', 'PREMIER_LEAGUE', 'LIVE', 'arsenal', 'leeds');
  const plChelsea = recordedFixture('pl-live-2', 'PREMIER_LEAGUE', 'HALF_TIME', 'chelsea', 'bournemouth');
  const plScheduled = recordedFixture('pl-scheduled', 'PREMIER_LEAGUE', 'SCHEDULED', 'spurs', 'everton');
  const plFinished = recordedFixture('pl-finished', 'PREMIER_LEAGUE', 'FINISHED', 'villa', 'fulham');
  const laLigaLive = recordedFixture('laliga-live', 'LA_LIGA', 'LIVE', 'real-madrid', 'sevilla');
  const serieAScheduled = recordedFixture('seriea-scheduled', 'SERIE_A', 'SCHEDULED', 'inter', 'roma');

  const documents = {
    'index.json': {
      provenance: PROVENANCE,
      version: 1,
      competitions: [
        { code: 'PREMIER_LEAGUE', file: 'competitions/premier-league.json' },
        { code: 'LA_LIGA', file: 'competitions/la-liga.json' },
        { code: 'SERIE_A', file: 'competitions/serie-a.json' },
      ],
      careersFile: 'careers.json',
      timelines: [],
    },
    'competitions/premier-league.json': competitionFile('PREMIER_LEAGUE', [plArsenal, plChelsea, plScheduled, plFinished]),
    'competitions/la-liga.json': competitionFile('LA_LIGA', [laLigaLive]),
    'competitions/serie-a.json': competitionFile('SERIE_A', [serieAScheduled]),
    'careers.json': { provenance: PROVENANCE, careers: [] },
  };
  return { dataSource: createInMemoryDataSource(documents), plArsenal, plChelsea, plScheduled, plFinished, laLigaLive };
}

function fixtureProvider(): { provider: FixtureProvider; scenario: ReturnType<typeof buildDataSource> } {
  const scenario = buildDataSource();
  return { provider: new FixtureProvider({ dataSource: scenario.dataSource }), scenario };
}

describe('FootballDataProvider.listLiveFixtures — FixtureProvider (offline)', () => {
  it('returns exactly the live fixtures for one competition, in a matchday with a live/scheduled/finished mix', async () => {
    const { provider } = fixtureProvider();
    const result = await provider.listLiveFixtures(PL.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((f) => f.id).sort()).toEqual(['pl-live-1', 'pl-live-2'].sort());
    expect(result.value.every((f) => f.status === 'LIVE' || f.status === 'HALF_TIME')).toBe(true);
  });

  it('never leaks another competition’s live fixture', async () => {
    const { provider } = fixtureProvider();
    const pl = await provider.listLiveFixtures(PL.id);
    const laLiga = await provider.listLiveFixtures(LA_LIGA.id);
    expect(pl.ok && laLiga.ok).toBe(true);
    if (!pl.ok || !laLiga.ok) return;
    expect(pl.value.some((f) => f.id === 'laliga-live')).toBe(false);
    expect(laLiga.value.map((f) => f.id)).toEqual(['laliga-live']);
  });

  it('zero live fixtures is ok:true with an empty array, not an error', async () => {
    const { provider } = fixtureProvider();
    const result = await provider.listLiveFixtures(SERIE_A.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('a provider failure (unsupported competition id) is a clean DataResult failure, never a throw', async () => {
    const { provider } = fixtureProvider();
    const result = await provider.listLiveFixtures(asCompetitionId('not-a-real-competition'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('BAD_REQUEST');
    expect(result.error.retryable).toBe(false);
  });
});

// ---- A fully-stubbed provider for precise control over concurrency and per-fixture failure -------------------

interface FakeHandlers {
  listLiveFixtures?: FootballDataProvider['listLiveFixtures'];
  getFixture?: FootballDataProvider['getFixture'];
}

class FakeProvider implements FootballDataProvider {
  readonly kind: ProviderKind = 'fixture';
  private readonly handlers: FakeHandlers;

  constructor(handlers: FakeHandlers) {
    this.handlers = handlers;
  }

  listLiveFixtures: FootballDataProvider['listLiveFixtures'] = (competitionId) =>
    (this.handlers.listLiveFixtures ?? (() => Promise.resolve(ok([]))))(competitionId);

  getFixture: FootballDataProvider['getFixture'] = (fixtureId) =>
    (this.handlers.getFixture ?? (() => Promise.resolve(ok(null))))(fixtureId);

  listCompetitions(): Promise<DataResult<never[]>> {
    return Promise.resolve(ok([]));
  }
  getFixturesByCompetition(): ReturnType<FootballDataProvider['getFixturesByCompetition']> {
    return Promise.resolve(ok([]));
  }
  getFixturesByDate(): ReturnType<FootballDataProvider['getFixturesByDate']> {
    return Promise.resolve(ok([]));
  }
  getLineups(): ReturnType<FootballDataProvider['getLineups']> {
    return Promise.resolve(ok(null));
  }
  getSquad(): Promise<DataResult<readonly Player[]>> {
    return Promise.resolve(ok([]));
  }
  getPlayerSeasonStats(): Promise<DataResult<readonly PlayerSeasonStats[]>> {
    return Promise.resolve(ok([]));
  }
  getPlayerProfile(): ReturnType<FootballDataProvider['getPlayerProfile']> {
    return Promise.resolve(ok(null));
  }
  getPlayerProfiles(): Promise<DataResult<readonly PlayerProfile[]>> {
    return Promise.resolve(ok([]));
  }
  getLiveMatchState(): ReturnType<FootballDataProvider['getLiveMatchState']> {
    return Promise.resolve(ok(null));
  }
  getMatchEvents(): Promise<DataResult<readonly never[]>> {
    return Promise.resolve(ok([]));
  }
}

function fakeFixture(id: string): Fixture {
  return recordedFixture(id, 'PREMIER_LEAGUE', 'LIVE', `${id}-home`, `${id}-away`);
}

describe('MatchdayPrefetcher.runGameday — bundle assembly', () => {
  it('produces one full MatchdayBundle per live fixture, in listLiveFixtures order', async () => {
    const { provider } = fixtureProvider();
    const prefetcher = new MatchdayPrefetcher(provider);
    const result = await prefetcher.runGameday(PL.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.competitionId).toBe(PL.id);
    expect(result.value.fixtures.map((b) => b.fixture.id)).toEqual(['pl-live-1', 'pl-live-2']);
    expect(result.value.skipped).toEqual([]);
  });

  it('zero live fixtures is a valid empty gameday bundle, not a failure', async () => {
    const { provider } = fixtureProvider();
    const prefetcher = new MatchdayPrefetcher(provider);
    const result = await prefetcher.runGameday(SERIE_A.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fixtures).toEqual([]);
    expect(result.value.skipped).toEqual([]);
  });

  it('a listLiveFixtures failure propagates as this call’s failure', async () => {
    const provider = new FakeProvider({
      listLiveFixtures: () => Promise.resolve(fail('UPSTREAM', 'upstream is down')),
    });
    const prefetcher = new MatchdayPrefetcher(provider);
    const result = await prefetcher.runGameday(asCompetitionId('premier-league'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('UPSTREAM');
  });

  it('one fixture failing its prefetch is skipped, not fatal — the rest of the gameday still comes back', async () => {
    const fixtures = [fakeFixture('f1'), fakeFixture('f2'), fakeFixture('f3')];
    const provider = new FakeProvider({
      listLiveFixtures: () => Promise.resolve(ok(fixtures)),
      getFixture: (fixtureId) => {
        if (fixtureId === 'f2') return Promise.resolve(fail('UPSTREAM', 'ESPN summary 500'));
        const found = fixtures.find((f) => f.id === fixtureId) ?? null;
        return Promise.resolve(ok(found));
      },
    });
    const prefetcher = new MatchdayPrefetcher(provider);
    const result = await prefetcher.runGameday(asCompetitionId('premier-league'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fixtures.map((b) => b.fixture.id).sort()).toEqual(['f1', 'f3']);
    expect(result.value.skipped).toEqual([{ fixtureId: asFixtureId('f2'), error: expect.objectContaining({ kind: 'UPSTREAM' }) }]);
  });

  it('every fixture failing its prefetch fails the whole gameday build', async () => {
    const fixtures = [fakeFixture('f1'), fakeFixture('f2')];
    const provider = new FakeProvider({
      listLiveFixtures: () => Promise.resolve(ok(fixtures)),
      getFixture: () => Promise.resolve(fail('UPSTREAM', 'ESPN summary 500')),
    });
    const prefetcher = new MatchdayPrefetcher(provider);
    const result = await prefetcher.runGameday(asCompetitionId('premier-league'));
    expect(result.ok).toBe(false);
  });
});

describe('MatchdayPrefetcher.runGameday — bounded concurrency', () => {
  it('never runs more than the configured number of fixture pipelines at once', async () => {
    const fixtureCount = 6;
    const concurrencyLimit = 2;
    const fixtures = Array.from({ length: fixtureCount }, (_, index) => fakeFixture(`f${String(index)}`));

    let inFlight = 0;
    let maxObserved = 0;
    const provider = new FakeProvider({
      listLiveFixtures: () => Promise.resolve(ok(fixtures)),
      getFixture: async (fixtureId) => {
        inFlight += 1;
        maxObserved = Math.max(maxObserved, inFlight);
        // A real delay so overlapping calls are actually observable rather than resolving synchronously.
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight -= 1;
        const found = fixtures.find((f) => f.id === fixtureId) ?? null;
        return ok(found);
      },
    });

    const prefetcher = new MatchdayPrefetcher(provider);
    const result = await prefetcher.runGameday(asCompetitionId('premier-league'), { concurrency: concurrencyLimit });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fixtures).toHaveLength(fixtureCount);
    expect(maxObserved).toBeLessThanOrEqual(concurrencyLimit);
    // Prove concurrency was actually used, not accidentally serialized down to 1.
    expect(maxObserved).toBeGreaterThanOrEqual(2);
  });

  it('reports progress per fixture through onFixtureProgress, keyed by fixture id', async () => {
    const fixtures = [fakeFixture('f1'), fakeFixture('f2')];
    const provider = new FakeProvider({
      listLiveFixtures: () => Promise.resolve(ok(fixtures)),
      getFixture: (fixtureId) => Promise.resolve(ok(fixtures.find((f) => f.id === fixtureId) ?? null)),
    });
    const seen = new Set<string>();
    const prefetcher = new MatchdayPrefetcher(provider);
    const result = await prefetcher.runGameday(asCompetitionId('premier-league'), {
      onFixtureProgress: (fixtureId) => seen.add(fixtureId),
    });
    expect(result.ok).toBe(true);
    expect([...seen].sort()).toEqual(['f1', 'f2']);
  });
});
