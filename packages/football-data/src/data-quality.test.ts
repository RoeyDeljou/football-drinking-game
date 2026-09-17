import { describe, expect, it } from 'vitest';

import {
  assessFixtureDataQuality,
  assessGeneralDataQuality,
  availableGameIds,
  DATA_CAPABILITIES,
  EMPTY_DATA_QUALITY,
  evaluateGameAvailability,
  GAME_DATA_REQUIREMENTS,
  mergeDataQuality,
} from './data-quality.js';
import {
  asCompetitionId,
  asFootballPlayerId,
  asSeasonId,
  asTeamId,
  type DataQuality,
  type Player,
  type PlayerProfile,
  type PlayerSeasonStats,
} from './domain.js';

function player(overrides: Partial<Player> = {}): Player {
  return {
    id: asFootballPlayerId('p1'),
    name: 'Test Player',
    fullName: null,
    nationality: null,
    dateOfBirth: null,
    age: null,
    heightCm: null,
    position: 'MF',
    shirtNumber: 10,
    teamId: asTeamId('t1'),
    photoUrl: null,
    marketValueEur: null,
    ...overrides,
  };
}

function seasonStats(overrides: Partial<PlayerSeasonStats> = {}): PlayerSeasonStats {
  return {
    playerId: asFootballPlayerId('p1'),
    teamId: asTeamId('t1'),
    competitionId: asCompetitionId('premier-league'),
    season: asSeasonId('2026/27'),
    appearances: 10,
    minutesPlayed: 900,
    goals: 5,
    assists: 2,
    yellowCards: 1,
    redCards: 0,
    shots: 20,
    shotsOnTarget: 10,
    passAccuracy: 85,
    tackles: 5,
    rating: 7.2,
    ...overrides,
  };
}

describe('GAME_DATA_REQUIREMENTS', () => {
  it('gates G7 Guess the Number on season stats, not market values', () => {
    expect(GAME_DATA_REQUIREMENTS['G7']).toEqual(['hasPlayerSeasonStats']);
  });

  it('every requirement key uses a real DataCapability', () => {
    for (const requirements of Object.values(GAME_DATA_REQUIREMENTS)) {
      for (const capability of requirements) {
        expect(DATA_CAPABILITIES).toContain(capability);
      }
    }
  });
});

describe('evaluateGameAvailability', () => {
  it('marks G7 available once season stats exist, independent of market values', () => {
    const quality: DataQuality = { ...EMPTY_DATA_QUALITY, hasPlayerSeasonStats: true, hasMarketValues: false };
    const rows = evaluateGameAvailability(quality);
    const g7 = rows.find((row) => row.gameId === 'G7');
    expect(g7?.available).toBe(true);
    expect(g7?.missing).toEqual([]);
  });

  it('marks G7 unavailable without season stats even if market values exist', () => {
    const quality: DataQuality = { ...EMPTY_DATA_QUALITY, hasPlayerSeasonStats: false, hasMarketValues: true };
    const g7 = evaluateGameAvailability(quality).find((row) => row.gameId === 'G7');
    expect(g7?.available).toBe(false);
    expect(g7?.missing).toEqual(['hasPlayerSeasonStats']);
  });

  it('G10 and G11 are always available (no data requirements)', () => {
    const rows = evaluateGameAvailability(EMPTY_DATA_QUALITY);
    expect(rows.find((row) => row.gameId === 'G10')?.available).toBe(true);
    expect(rows.find((row) => row.gameId === 'G11')?.available).toBe(true);
  });

  it('availableGameIds returns just the playable ids, sorted', () => {
    const quality: DataQuality = { ...EMPTY_DATA_QUALITY, hasPlayerSeasonStats: true };
    const ids = availableGameIds(quality, { G6: ['hasPlayerSeasonStats'], G7: ['hasPlayerSeasonStats'], G10: [] });
    expect(ids).toEqual(['G10', 'G6', 'G7']);
  });
});

describe('mergeDataQuality', () => {
  it('a capability is true only when every report has it', () => {
    const a: DataQuality = { ...EMPTY_DATA_QUALITY, hasLineups: true, hasPlayerSeasonStats: true };
    const b: DataQuality = { ...EMPTY_DATA_QUALITY, hasLineups: true, hasPlayerSeasonStats: false };
    const merged = mergeDataQuality([a, b]);
    expect(merged.hasLineups).toBe(true);
    expect(merged.hasPlayerSeasonStats).toBe(false);
  });

  it('returns EMPTY_DATA_QUALITY for no reports', () => {
    expect(mergeDataQuality([])).toEqual(EMPTY_DATA_QUALITY);
  });

  it('deduplicates notes', () => {
    const a: DataQuality = { ...EMPTY_DATA_QUALITY, notes: ['x'] };
    const b: DataQuality = { ...EMPTY_DATA_QUALITY, notes: ['x', 'y'] };
    expect(mergeDataQuality([a, b]).notes).toEqual(['x', 'y']);
  });
});

describe('assessFixtureDataQuality', () => {
  it('reports every capability false with explanatory notes when nothing is available', () => {
    const quality = assessFixtureDataQuality({
      lineups: null,
      live: null,
      squadPlayers: [],
      seasonStats: [],
    });
    expect(quality.hasLineups).toBe(false);
    expect(quality.hasLiveEvents).toBe(false);
    expect(quality.hasPlayerSeasonStats).toBe(false);
    expect(quality.notes.length).toBeGreaterThan(0);
  });

  it('flags missing market values without affecting other capabilities', () => {
    const quality = assessFixtureDataQuality({
      lineups: null,
      live: null,
      squadPlayers: [player({ marketValueEur: null })],
      seasonStats: [seasonStats()],
    });
    expect(quality.hasMarketValues).toBe(false);
    expect(quality.hasPlayerSeasonStats).toBe(true);
  });

  it('hasMarketValues true when at least one squad player is valued', () => {
    const quality = assessFixtureDataQuality({
      lineups: null,
      live: null,
      squadPlayers: [player({ id: asFootballPlayerId('a'), marketValueEur: 1_000_000 }), player({ id: asFootballPlayerId('b') })],
      seasonStats: [],
    });
    expect(quality.hasMarketValues).toBe(true);
  });
});

describe('assessGeneralDataQuality', () => {
  it('gates career history on a minimum count, not just non-zero', () => {
    const profiles: PlayerProfile[] = [
      { player: player({ id: asFootballPlayerId('a') }), career: [] },
      {
        player: player({ id: asFootballPlayerId('b') }),
        career: [{ teamId: null, teamName: 'X', fromSeason: '2020/21', toSeason: null, appearances: null, goals: null }],
      },
    ];
    const quality = assessGeneralDataQuality({
      players: [],
      seasonStats: [seasonStats()],
      profiles,
      minCareerPlayers: 2,
    });
    expect(quality.hasCareerHistory).toBe(false);
    expect(quality.notes.some((note) => note.includes('need 2'))).toBe(true);
  });

  it('never sets matchday-only capabilities', () => {
    const quality = assessGeneralDataQuality({ players: [], seasonStats: [seasonStats()], profiles: [] });
    expect(quality.hasLineups).toBe(false);
    expect(quality.hasLiveEvents).toBe(false);
    expect(quality.hasPlayerMatchStats).toBe(false);
  });

  it('notes the absence of market values without mentioning a retired game name', () => {
    const quality = assessGeneralDataQuality({ players: [player({ marketValueEur: null })], seasonStats: [], profiles: [] });
    expect(quality.hasMarketValues).toBe(false);
    expect(quality.notes.some((note) => note.toLowerCase().includes('price is right'))).toBe(false);
  });

  it('G7 is playable from a general dataset that only has season stats, no market values', () => {
    const quality = assessGeneralDataQuality({
      players: [player({ marketValueEur: null })],
      seasonStats: [seasonStats()],
      profiles: [],
    });
    expect(quality.hasMarketValues).toBe(false);
    const g7 = evaluateGameAvailability(quality).find((row) => row.gameId === 'G7');
    expect(g7?.available).toBe(true);
  });
});
