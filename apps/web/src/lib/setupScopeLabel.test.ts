import { describe, expect, it } from 'vitest';
import { setupScopeLabel } from './setupScopeLabel';

const fixture = (home: string, away: string) => ({ homeTeam: { name: home }, awayTeam: { name: away } });

describe('setupScopeLabel', () => {
  it('names the general scope, defaulting to all competitions', () => {
    const base = { category: 'general', fixtures: [] } as const;
    expect(setupScopeLabel({ ...base, generalCompetitionName: null })).toBe('All competitions');
    expect(setupScopeLabel({ ...base, generalCompetitionName: 'Serie A' })).toBe('Serie A');
  });

  it('names the fixture for a single-match matchday room', () => {
    expect(setupScopeLabel({ category: 'matchday', generalCompetitionName: null, fixtures: [fixture('Arsenal', 'Chelsea')] })).toBe('Arsenal vs Chelsea');
  });

  it('names the first match and counts the rest for a rotation room', () => {
    expect(
      setupScopeLabel({
        category: 'matchday',
        generalCompetitionName: null,
        fixtures: [fixture('Arsenal', 'Chelsea'), fixture('Barcelona', 'Levante'), fixture('Lazio', 'Milan')],
      }),
    ).toBe('Arsenal v Chelsea +2 more');
  });
});
