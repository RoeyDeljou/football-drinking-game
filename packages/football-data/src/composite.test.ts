import { describe, expect, it, vi } from 'vitest';

import { CompositeProvider } from './composite.js';
import {
  asCompetitionId,
  asFixtureId,
  asFootballPlayerId,
  asSeasonId,
  asTeamId,
  type Fixture,
  type Player,
  type PlayerProfile,
  type PlayerSeasonStats,
} from './domain.js';
import type { FootballDataProvider, ProviderKind } from './provider.js';
import { fail, ok } from './result.js';
import type { CareerLookup, CareerLookupResult, CareerProvider } from './wikidata/wikidata-career-provider.js';

function team(id: string, name: string) {
  return { id: asTeamId(id), name, shortName: name.slice(0, 3).toUpperCase(), crestUrl: null, country: null };
}

function fixture(id: string, overrides: Partial<Fixture> = {}): Fixture {
  return {
    id: asFixtureId(id),
    competitionId: asCompetitionId('premier-league'),
    season: asSeasonId('2026/27'),
    kickoff: '2026-09-16T15:00:00.000Z',
    status: 'SCHEDULED',
    minute: null,
    homeTeam: team('h1', 'Home FC'),
    awayTeam: team('a1', 'Away FC'),
    score: null,
    halfTimeScore: null,
    venue: null,
    round: null,
    ...overrides,
  };
}

function player(id: string, overrides: Partial<Player> = {}): Player {
  return {
    id: asFootballPlayerId(id),
    name: `Player ${id}`,
    fullName: null,
    nationality: null,
    dateOfBirth: null,
    age: null,
    heightCm: null,
    position: 'MF',
    shirtNumber: 1,
    teamId: asTeamId('h1'),
    photoUrl: null,
    marketValueEur: null,
    ...overrides,
  };
}

/** A minimal, fully-stubbed FootballDataProvider whose behaviour each test configures per method. */
class FakeProvider implements FootballDataProvider {
  readonly kind: ProviderKind;
  calls: Record<string, number> = {};

  constructor(
    kind: ProviderKind,
    private readonly handlers: Partial<{
      listCompetitions: FootballDataProvider['listCompetitions'];
      getFixturesByCompetition: FootballDataProvider['getFixturesByCompetition'];
      getFixturesByDate: FootballDataProvider['getFixturesByDate'];
      getFixture: FootballDataProvider['getFixture'];
      getLineups: FootballDataProvider['getLineups'];
      getSquad: FootballDataProvider['getSquad'];
      getPlayerSeasonStats: FootballDataProvider['getPlayerSeasonStats'];
      getPlayerProfile: FootballDataProvider['getPlayerProfile'];
      getPlayerProfiles: FootballDataProvider['getPlayerProfiles'];
      getLiveMatchState: FootballDataProvider['getLiveMatchState'];
      getMatchEvents: FootballDataProvider['getMatchEvents'];
    }> = {},
  ) {
    this.kind = kind;
  }

  private track(name: string): void {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
  }

  listCompetitions: FootballDataProvider['listCompetitions'] = (...args) => {
    this.track('listCompetitions');
    return (this.handlers.listCompetitions ?? (() => Promise.resolve(ok([]))))(...args);
  };

  getFixturesByCompetition: FootballDataProvider['getFixturesByCompetition'] = (...args) => {
    this.track('getFixturesByCompetition');
    return (this.handlers.getFixturesByCompetition ?? (() => Promise.resolve(fail('UPSTREAM', 'not configured'))))(
      ...args,
    );
  };

  getFixturesByDate: FootballDataProvider['getFixturesByDate'] = (...args) => {
    this.track('getFixturesByDate');
    return (this.handlers.getFixturesByDate ?? (() => Promise.resolve(fail('UPSTREAM', 'not configured'))))(...args);
  };

  getFixture: FootballDataProvider['getFixture'] = (...args) => {
    this.track('getFixture');
    return (this.handlers.getFixture ?? (() => Promise.resolve(fail('UPSTREAM', 'not configured'))))(...args);
  };

  getLineups: FootballDataProvider['getLineups'] = (...args) => {
    this.track('getLineups');
    return (this.handlers.getLineups ?? (() => Promise.resolve(ok(null))))(...args);
  };

  getSquad: FootballDataProvider['getSquad'] = (...args) => {
    this.track('getSquad');
    return (this.handlers.getSquad ?? (() => Promise.resolve(fail('UPSTREAM', 'not configured'))))(...args);
  };

  getPlayerSeasonStats: FootballDataProvider['getPlayerSeasonStats'] = (...args) => {
    this.track('getPlayerSeasonStats');
    return (this.handlers.getPlayerSeasonStats ?? (() => Promise.resolve(fail('UPSTREAM', 'not configured'))))(
      ...args,
    );
  };

  getPlayerProfile: FootballDataProvider['getPlayerProfile'] = (...args) => {
    this.track('getPlayerProfile');
    return (this.handlers.getPlayerProfile ?? (() => Promise.resolve(ok(null))))(...args);
  };

  getPlayerProfiles: FootballDataProvider['getPlayerProfiles'] = (...args) => {
    this.track('getPlayerProfiles');
    return (this.handlers.getPlayerProfiles ?? (() => Promise.resolve(fail('UPSTREAM', 'not configured'))))(...args);
  };

  getLiveMatchState: FootballDataProvider['getLiveMatchState'] = (...args) => {
    this.track('getLiveMatchState');
    return (this.handlers.getLiveMatchState ?? (() => Promise.resolve(ok(null))))(...args);
  };

  getMatchEvents: FootballDataProvider['getMatchEvents'] = (...args) => {
    this.track('getMatchEvents');
    return (this.handlers.getMatchEvents ?? (() => Promise.resolve(ok([]))))(...args);
  };
}

function fakeCareerProvider(
  respond: (lookups: readonly CareerLookup[]) => readonly CareerLookupResult[],
): CareerProvider {
  return {
    source: 'fake-careers',
    getCareers: (lookups) => Promise.resolve(ok(respond(lookups))),
  };
}

describe('CompositeProvider.describeSources', () => {
  it('reports the configured kinds', () => {
    const primary = new FakeProvider('espn');
    const composite = new CompositeProvider({ primary });
    expect(composite.describeSources()).toEqual({ primary: 'espn', fallback: null, careers: null });
  });
});

describe('CompositeProvider — id-free queries (fixtures by competition/date) fall back on failure', () => {
  it('uses the primary when it succeeds, tagging the source in notes', async () => {
    const primary = new FakeProvider('espn', {
      getFixturesByCompetition: () => Promise.resolve(ok([fixture('f1')])),
    });
    const composite = new CompositeProvider({ primary });
    const result = await composite.getFixturesByCompetition(asCompetitionId('premier-league'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.notes.some((note) => note.includes('source: espn'))).toBe(true);
  });

  it('falls back when the primary fails, and the fallback result is what is returned', async () => {
    const primary = new FakeProvider('espn', {
      getFixturesByCompetition: () => Promise.resolve(fail('UPSTREAM', 'espn down')),
    });
    const fallback = new FakeProvider('api-football', {
      getFixturesByCompetition: () => Promise.resolve(ok([fixture('f2')])),
    });
    const composite = new CompositeProvider({ primary, fallback });
    const result = await composite.getFixturesByCompetition(asCompetitionId('premier-league'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.id).toBe('f2');
    expect(result.notes.some((note) => note.includes('fallback') && note.includes('espn down'))).toBe(true);
  });

  it('returns the primary failure when there is no fallback configured', async () => {
    const primary = new FakeProvider('espn', {
      getFixturesByCompetition: () => Promise.resolve(fail('UPSTREAM', 'espn down')),
    });
    const composite = new CompositeProvider({ primary });
    const result = await composite.getFixturesByCompetition(asCompetitionId('premier-league'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe('espn down');
  });

  it('returns the primary failure when the fallback also fails', async () => {
    const primary = new FakeProvider('espn', { getFixturesByCompetition: () => Promise.resolve(fail('UPSTREAM', 'a')) });
    const fallback = new FakeProvider('api-football', {
      getFixturesByCompetition: () => Promise.resolve(fail('UPSTREAM', 'b')),
    });
    const composite = new CompositeProvider({ primary, fallback });
    const result = await composite.getFixturesByCompetition(asCompetitionId('premier-league'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('a');
  });
});

describe('CompositeProvider — id-based routing remembers which source issued an id', () => {
  it('once a fixture id is seen from the primary, later calls for it never touch the fallback', async () => {
    const primary = new FakeProvider('espn', { getFixture: () => Promise.resolve(ok(fixture('f1'))) });
    const fallback = new FakeProvider('api-football');
    const composite = new CompositeProvider({ primary, fallback });

    await composite.getFixture(asFixtureId('f1'));
    await composite.getLineups(asFixtureId('f1'));
    await composite.getLiveMatchState(asFixtureId('f1'));

    expect(fallback.calls['getFixture']).toBeUndefined();
    expect(fallback.calls['getLineups']).toBeUndefined();
    expect(primary.calls['getLineups']).toBe(1);
  });

  it('an id first served by the fallback (primary failed) routes straight to the fallback next time', async () => {
    const primary = new FakeProvider('espn', { getFixture: () => Promise.resolve(fail('UPSTREAM', 'nope')) });
    const fallback = new FakeProvider('api-football', { getFixture: () => Promise.resolve(ok(fixture('f9'))) });
    const composite = new CompositeProvider({ primary, fallback });

    await composite.getFixture(asFixtureId('f9'));
    expect(primary.calls['getFixture']).toBe(1);
    expect(fallback.calls['getFixture']).toBe(1);

    await composite.getFixture(asFixtureId('f9'));
    // Second call goes straight to the fallback; the primary is not retried for a known fallback id.
    expect(primary.calls['getFixture']).toBe(1);
    expect(fallback.calls['getFixture']).toBe(2);
  });

  it('getSquad and getPlayerSeasonStats route by team id once the team has been seen', async () => {
    const primary = new FakeProvider('espn', {
      getFixture: () => Promise.resolve(ok(fixture('f1', { homeTeam: team('h1', 'Home FC') }))),
      getSquad: () => Promise.resolve(ok([player('p1')])),
    });
    const fallback = new FakeProvider('api-football');
    const composite = new CompositeProvider({ primary, fallback });

    await composite.getFixture(asFixtureId('f1'));
    await composite.getSquad(asTeamId('h1'));

    expect(fallback.calls['getSquad']).toBeUndefined();
    expect(primary.calls['getSquad']).toBe(1);
  });

  it('an unseen team id for getPlayerSeasonStats(teamId) tries primary then falls back', async () => {
    const stats: PlayerSeasonStats = {
      playerId: asFootballPlayerId('p1'),
      teamId: asTeamId('unseen'),
      competitionId: asCompetitionId('premier-league'),
      season: asSeasonId('2026/27'),
      appearances: 1,
      minutesPlayed: 90,
      goals: 0,
      assists: 0,
      yellowCards: 0,
      redCards: 0,
      shots: null,
      shotsOnTarget: null,
      passAccuracy: null,
      tackles: null,
      rating: null,
    };
    const primary = new FakeProvider('espn', {
      getPlayerSeasonStats: () => Promise.resolve(fail('UPSTREAM', 'nope')),
    });
    const fallback = new FakeProvider('api-football', {
      getPlayerSeasonStats: () => Promise.resolve(ok([stats])),
    });
    const composite = new CompositeProvider({ primary, fallback });
    const result = await composite.getPlayerSeasonStats({
      competitionId: asCompetitionId('premier-league'),
      teamId: asTeamId('unseen'),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(1);
  });
});

describe('CompositeProvider.getPlayerProfiles — batching and career enrichment', () => {
  it('groups unknown ids under the primary and enriches a profile with no career via the career provider', async () => {
    const bio: PlayerProfile = { player: player('p1'), career: [] };
    const primary = new FakeProvider('espn', {
      getPlayerProfiles: () => Promise.resolve(ok([bio])),
    });
    const careers = fakeCareerProvider((lookups) => [
      {
        playerId: lookups[0]!.playerId,
        status: 'matched',
        wikidataId: 'Q1',
        career: [{ teamId: null, teamName: 'Some Club', fromSeason: '2020/21', toSeason: null, appearances: 10, goals: 1 }],
        seniorNationalTeam: null,
        notes: ['matched'],
      },
    ]);
    const composite = new CompositeProvider({ primary, careers });

    const result = await composite.getPlayerProfiles([asFootballPlayerId('p1')]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.career).toHaveLength(1);
    expect(result.notes.some((note) => note.includes('careers: fake-careers'))).toBe(true);
    expect(composite.careerOutcome(asFootballPlayerId('p1'))?.status).toBe('matched');
  });

  it('does not call the career provider for a profile that already has career history', async () => {
    const bio: PlayerProfile = {
      player: player('p1'),
      career: [{ teamId: null, teamName: 'Existing Club', fromSeason: '2019/20', toSeason: null, appearances: 5, goals: 0 }],
    };
    const primary = new FakeProvider('espn', { getPlayerProfiles: () => Promise.resolve(ok([bio])) });
    const getCareers = vi.fn().mockResolvedValue(ok([]));
    const composite = new CompositeProvider({ primary, careers: { source: 'fake', getCareers } });

    await composite.getPlayerProfiles([asFootballPlayerId('p1')]);
    expect(getCareers).not.toHaveBeenCalled();
  });

  it('links a resolved career club to a real team id once that team name has been seen from a fixture', async () => {
    const bio: PlayerProfile = { player: player('p1'), career: [] };
    const primary = new FakeProvider('espn', {
      getFixture: () => Promise.resolve(ok(fixture('f1', { homeTeam: team('382', 'Manchester City') }))),
      getPlayerProfiles: () => Promise.resolve(ok([bio])),
    });
    const careers = fakeCareerProvider((lookups) => [
      {
        playerId: lookups[0]!.playerId,
        status: 'matched',
        wikidataId: 'Q1',
        career: [
          { teamId: null, teamName: 'Manchester City F.C.', fromSeason: '2021/22', toSeason: null, appearances: 50, goals: 5 },
        ],
        seniorNationalTeam: null,
        notes: [],
      },
    ]);
    const composite = new CompositeProvider({ primary, careers });

    await composite.getFixture(asFixtureId('f1')); // teaches the composite the real team name -> id mapping
    const result = await composite.getPlayerProfiles([asFootballPlayerId('p1')]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.career[0]?.teamId).toBe('382');
  });

  it('a profile stays without career history when the career provider fails, and it is noted', async () => {
    const bio: PlayerProfile = { player: player('p1'), career: [] };
    const primary = new FakeProvider('espn', { getPlayerProfiles: () => Promise.resolve(ok([bio])) });
    const careers: CareerProvider = { source: 'fake', getCareers: () => Promise.resolve(fail('UPSTREAM', 'wikidata down')) };
    const composite = new CompositeProvider({ primary, careers });

    const result = await composite.getPlayerProfiles([asFootballPlayerId('p1')]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.career).toEqual([]);
    expect(result.notes.some((note) => note.includes('wikidata down'))).toBe(true);
  });

  it('with no career provider configured, profiles pass through unchanged with a note', async () => {
    const bio: PlayerProfile = { player: player('p1'), career: [] };
    const primary = new FakeProvider('espn', { getPlayerProfiles: () => Promise.resolve(ok([bio])) });
    const composite = new CompositeProvider({ primary });

    const result = await composite.getPlayerProfiles([asFootballPlayerId('p1')]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.career).toEqual([]);
    expect(result.notes.some((note) => note.includes('No career source configured'))).toBe(true);
  });
});
