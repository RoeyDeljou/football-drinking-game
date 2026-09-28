import { describe, expect, it } from 'vitest';
import { FIXTURE_LOAD_SLOW_AFTER_MS, fixtureLoadElapsedPhase } from './fixtureLoadElapsed';

describe('fixtureLoadElapsedPhase', () => {
  it('is normal while not loading, regardless of elapsed time', () => {
    expect(fixtureLoadElapsedPhase({ loading: false, startedAt: 0, now: 100_000 })).toBe('normal');
  });

  it('is normal just after the fetch starts', () => {
    expect(fixtureLoadElapsedPhase({ loading: true, startedAt: 1_000, now: 1_500 })).toBe('normal');
  });

  it('is normal right up to the threshold', () => {
    const startedAt = 1_000;
    expect(
      fixtureLoadElapsedPhase({ loading: true, startedAt, now: startedAt + FIXTURE_LOAD_SLOW_AFTER_MS - 1 }),
    ).toBe('normal');
  });

  it('becomes slow once the threshold is reached', () => {
    const startedAt = 1_000;
    expect(fixtureLoadElapsedPhase({ loading: true, startedAt, now: startedAt + FIXTURE_LOAD_SLOW_AFTER_MS })).toBe(
      'slow',
    );
  });

  it('stays slow well past the threshold', () => {
    expect(fixtureLoadElapsedPhase({ loading: true, startedAt: 0, now: 30_000 })).toBe('slow');
  });
});
