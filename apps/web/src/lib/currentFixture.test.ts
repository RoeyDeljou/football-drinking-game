import { describe, expect, it } from 'vitest';
import { nowPlayingLabel, type CurrentFixtureSummary } from './currentFixture';

const summary = (mode: CurrentFixtureSummary['mode']): CurrentFixtureSummary => ({
  fixtureId: 'f1',
  competitionId: 'comp-pl',
  mode,
  homeTeam: { name: 'Arsenal', crestUrl: null },
  awayTeam: { name: 'Leeds United', crestUrl: null },
});

describe('nowPlayingLabel', () => {
  it('renders nothing for a general room (currentFixture null)', () => {
    expect(nowPlayingLabel(null)).toBeNull();
  });

  it('labels a single-fixture matchday round with no secondary line', () => {
    expect(nowPlayingLabel(summary('single'))).toEqual({
      primary: 'Arsenal vs Leeds United',
      secondary: null,
    });
  });

  it('labels a gameday round with a distinguishing secondary line', () => {
    const result = nowPlayingLabel(summary('gameday'));
    expect(result?.primary).toBe('Arsenal vs Leeds United');
    expect(result?.secondary).not.toBeNull();
  });
});
