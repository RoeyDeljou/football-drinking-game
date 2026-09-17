import { describe, expect, it } from 'vitest';

import {
  buildBioGuessableStats,
  buildGuessableStats,
  buildSeasonGuessableStats,
  groupGuessableStatsByPlayer,
} from './guessable-stats.js';
import { asCompetitionId, asFootballPlayerId, asSeasonId, asTeamId, type Player, type PlayerSeasonStats, type Team } from './domain.js';

const team: Team = { id: asTeamId('t1'), name: 'Test FC', shortName: 'TFC', crestUrl: null, country: 'Testland' };

function player(overrides: Partial<Player> = {}): Player {
  return {
    id: asFootballPlayerId('p1'),
    name: 'Test Player',
    fullName: null,
    nationality: null,
    dateOfBirth: null,
    age: 24,
    heightCm: 181,
    position: 'FW',
    shirtNumber: 9,
    teamId: team.id,
    photoUrl: null,
    marketValueEur: null,
    ...overrides,
  };
}

function stats(overrides: Partial<PlayerSeasonStats> = {}): PlayerSeasonStats {
  return {
    playerId: asFootballPlayerId('p1'),
    teamId: team.id,
    competitionId: asCompetitionId('premier-league'),
    season: asSeasonId('2026/27'),
    appearances: 10,
    minutesPlayed: 900,
    goals: 7,
    assists: 3,
    yellowCards: 2,
    redCards: 0,
    shots: 30,
    shotsOnTarget: 15,
    passAccuracy: 80,
    tackles: 8,
    rating: 7.4,
    ...overrides,
  };
}

describe('buildBioGuessableStats', () => {
  it('emits age, height and shirt number facts when present', () => {
    const facts = buildBioGuessableStats([player()], new Map([[team.id, team]]));
    const metrics = facts.map((fact) => fact.metric).sort();
    expect(metrics).toEqual(['AGE', 'HEIGHT_CM', 'SHIRT_NUMBER']);
    expect(facts.find((fact) => fact.metric === 'AGE')?.value).toBe(24);
    expect(facts.every((fact) => fact.season === null && fact.competitionId === null)).toBe(true);
    expect(facts.every((fact) => fact.teamName === 'Test FC')).toBe(true);
  });

  it('skips a metric whose source field is null rather than inventing a value', () => {
    const facts = buildBioGuessableStats([player({ heightCm: null })], new Map([[team.id, team]]));
    expect(facts.some((fact) => fact.metric === 'HEIGHT_CM')).toBe(false);
  });
});

describe('buildSeasonGuessableStats', () => {
  it('emits one fact per metric per season-stat row, carrying the season and competition', () => {
    const facts = buildSeasonGuessableStats([stats()], new Map([[player().id, player()]]), new Map([[team.id, team]]));
    expect(facts).toHaveLength(5);
    const goals = facts.find((fact) => fact.metric === 'GOALS');
    expect(goals?.value).toBe(7);
    expect(goals?.unit).toBe('goals');
    expect(goals?.season).toBe('2026/27');
    expect(goals?.competitionId).toBe('premier-league');
  });

  it('produces a fact per row even for the same player across two competitions', () => {
    const rows = [
      stats({ competitionId: asCompetitionId('premier-league'), goals: 7 }),
      stats({ competitionId: asCompetitionId('champions-league'), goals: 2 }),
    ];
    const facts = buildSeasonGuessableStats(rows, new Map([[player().id, player()]]), new Map([[team.id, team]]));
    const goalFacts = facts.filter((fact) => fact.metric === 'GOALS');
    expect(goalFacts).toHaveLength(2);
    expect(goalFacts.map((fact) => fact.value).sort()).toEqual([2, 7]);
  });
});

describe('buildGuessableStats and grouping', () => {
  it('combines bio and season facts and groups them by player', () => {
    const facts = buildGuessableStats([player()], [stats()], [team]);
    expect(facts.length).toBe(3 + 5);
    const byPlayer = groupGuessableStatsByPlayer(facts);
    expect(byPlayer.get(player().id)).toHaveLength(8);
  });
});
