import type { Fixture } from '@fdg/football-data';
import { describe, expect, it } from 'vitest';
import { selectRelevantFixtures } from './routes.js';
import { isOpenForPlay, nextDayToCheck, OPEN_BEFORE_KICKOFF_MS } from './open-window.js';

const NOW = Date.parse('2026-10-10T15:00:00.000Z');
const fx = (id: string, status: Fixture['status'], kickoffOffsetMs: number): Fixture =>
  ({ id, status, kickoff: new Date(NOW + kickoffOffsetMs).toISOString() }) as unknown as Fixture;

describe('open-for-play window', () => {
  it('is exactly 30 minutes before kickoff', () => {
    expect(OPEN_BEFORE_KICKOFF_MS).toBe(30 * 60 * 1000);
    expect(isOpenForPlay(fx('a', 'SCHEDULED', OPEN_BEFORE_KICKOFF_MS), NOW)).toBe(true);
    expect(isOpenForPlay(fx('b', 'SCHEDULED', OPEN_BEFORE_KICKOFF_MS + 1000), NOW)).toBe(false);
    expect(isOpenForPlay(fx('c', 'SCHEDULED', 5 * 60_000), NOW)).toBe(true);
  });

  it('includes live fixtures and a just-past scheduled one awaiting the provider flip; excludes finished/postponed/old', () => {
    for (const status of ['LIVE', 'HALF_TIME', 'EXTRA_TIME', 'PENALTIES'] as const) {
      expect(isOpenForPlay(fx('l', status, -3_600_000), NOW)).toBe(true);
    }
    expect(isOpenForPlay(fx('lag', 'SCHEDULED', -10 * 60_000), NOW)).toBe(true);
    expect(isOpenForPlay(fx('stale', 'SCHEDULED', -5 * 3_600_000), NOW)).toBe(false);
    expect(isOpenForPlay(fx('f', 'FINISHED', -3_600_000), NOW)).toBe(false);
    expect(isOpenForPlay(fx('p', 'POSTPONED', 60_000), NOW)).toBe(false);
  });

  it('selectRelevantFixtures(open) returns live first then scheduled-soon, soonest first', () => {
    const list = [
      fx('later', 'SCHEDULED', 25 * 60_000),
      fx('far', 'SCHEDULED', 45 * 60_000),
      fx('soon', 'SCHEDULED', 10 * 60_000),
      fx('live', 'LIVE', -30 * 60_000),
      fx('done', 'FINISHED', -2 * 3_600_000),
    ];
    expect(selectRelevantFixtures(list, 'open', NOW).map((f) => f.id)).toEqual(['live', 'soon', 'later']);
    // the existing windows are unchanged
    expect(selectRelevantFixtures(list, 'live', NOW).map((f) => f.id)).toEqual(['live']);
  });

  it('only asks for the next day when the window crosses midnight Eastern', () => {
    // 23:45 ET (EDT, UTC-4) on 2026-10-10 = 03:45Z on the 11th: +30 min is past midnight ET.
    expect(nextDayToCheck(Date.parse('2026-10-11T03:45:00.000Z'))).toBe('2026-10-11');
    expect(nextDayToCheck(Date.parse('2026-10-11T03:20:00.000Z'))).toBeNull(); // 23:20 ET + 30 = 23:50 ET
    expect(nextDayToCheck(NOW)).toBeNull();
    // Winter (EST, UTC-5): 23:40 ET = 04:40Z
    expect(nextDayToCheck(Date.parse('2026-12-11T04:40:00.000Z'))).toBe('2026-12-11');
  });
});
