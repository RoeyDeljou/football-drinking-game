import { describe, expect, it } from 'vitest';
import { gamedayOptionLabel, liveFixtureCount, shouldOfferGameday } from './matchdayPicker';
import type { FixtureSummary } from './api';

const fixture = (status: FixtureSummary['status']): Pick<FixtureSummary, 'status'> => ({ status });

describe('liveFixtureCount', () => {
  it('counts every live-ish status', () => {
    const fixtures = [fixture('LIVE'), fixture('HALF_TIME'), fixture('SCHEDULED'), fixture('FINISHED')];
    expect(liveFixtureCount(fixtures)).toBe(2);
  });

  it('is zero for an empty list', () => {
    expect(liveFixtureCount([])).toBe(0);
  });
});

describe('shouldOfferGameday', () => {
  it('does not offer gameday mode with zero live fixtures', () => {
    expect(shouldOfferGameday(0)).toBe(false);
  });

  it('does not offer gameday mode with exactly one live fixture — direct pick already covers it', () => {
    expect(shouldOfferGameday(1)).toBe(false);
  });

  it('offers gameday mode with two or more live fixtures', () => {
    expect(shouldOfferGameday(2)).toBe(true);
    expect(shouldOfferGameday(5)).toBe(true);
  });
});

describe('gamedayOptionLabel', () => {
  it('pluralizes correctly', () => {
    expect(gamedayOptionLabel(2)).toBe('2 live matches — play them all');
    expect(gamedayOptionLabel(1)).toBe('1 live match — play them all');
  });
});
