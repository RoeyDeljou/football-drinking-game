import { describe, expect, it } from 'vitest';
import { setupScopeLabel } from './setupScopeLabel';

const fixture = { homeTeam: { name: 'Arsenal' }, awayTeam: { name: 'Chelsea' } };

describe('setupScopeLabel', () => {
  it('names the general scope, defaulting to all competitions', () => {
    const base = { category: 'general', matchdayCompetitionName: null, gameday: false, fixture: null } as const;
    expect(setupScopeLabel({ ...base, generalCompetitionName: null })).toBe('All competitions');
    expect(setupScopeLabel({ ...base, generalCompetitionName: 'Serie A' })).toBe('Serie A');
  });

  it('names the fixture for a single-match matchday room', () => {
    expect(
      setupScopeLabel({
        category: 'matchday',
        generalCompetitionName: null,
        matchdayCompetitionName: 'Premier League',
        gameday: false,
        fixture,
      }),
    ).toBe('Arsenal vs Chelsea');
  });

  it('names the league for a whole-gameday room', () => {
    expect(
      setupScopeLabel({
        category: 'matchday',
        generalCompetitionName: null,
        matchdayCompetitionName: 'La Liga',
        gameday: true,
        fixture: null,
      }),
    ).toBe('Live gameday · La Liga');
  });
});
