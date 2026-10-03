import { describe, expect, it } from 'vitest';
import { liveGameAvailability, liveGamesNote, LIVE_ONLY_GAME_IDS } from './liveGames';

describe('live-only games', () => {
  it('names M1 and M4 to M9 and not the lineup games', () => {
    for (const id of ['M1', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9']) expect(LIVE_ONLY_GAME_IDS.has(id)).toBe(true);
    for (const id of ['M2', 'M3', 'M10', 'G1']) expect(LIVE_ONLY_GAME_IDS.has(id)).toBe(false);
  });

  it('hides them for a finished or cancelled match, greys them for a postponed one', () => {
    expect(liveGameAvailability('FINISHED')).toBe('hidden');
    expect(liveGameAvailability('CANCELLED')).toBe('hidden');
    expect(liveGameAvailability('POSTPONED')).toBe('greyed');
    for (const status of ['LIVE', 'SCHEDULED', 'HALF_TIME', null, undefined]) expect(liveGameAvailability(status)).toBe('available');
    expect(liveGamesNote('FINISHED')).toMatch(/finished/);
    expect(liveGamesNote('LIVE')).toBeNull();
  });
});
