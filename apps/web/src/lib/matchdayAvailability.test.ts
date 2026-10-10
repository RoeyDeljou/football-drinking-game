import { describe, expect, it } from 'vitest';
import type { FixtureSummary } from './api';
import {
  FRESH_LIVE_WINDOW_MS,
  isFreshLiveFixture,
  isMatchdayVisible,
  matchdayAvailability,
  type CompetitionLiveCheck,
} from './matchdayAvailability';

const NOW = Date.parse('2026-09-28T18:00:00.000Z');

const fixture = (overrides: Partial<FixtureSummary> = {}): FixtureSummary => ({
  fixtureId: 'f1',
  kickoff: new Date(NOW - 10 * 60_000).toISOString(),
  status: 'LIVE',
  minute: 10,
  competitionId: 'comp-1',
  homeTeam: { name: 'Home', crestUrl: null },
  awayTeam: { name: 'Away', crestUrl: null },
  ...overrides,
});

const settledOk = (fixtures: readonly FixtureSummary[]): CompetitionLiveCheck => ({
  status: 'settled',
  result: { ok: true, value: { fixtures } },
});

const settledError = (): CompetitionLiveCheck => ({
  status: 'settled',
  result: { ok: false, message: 'Could not reach the server. Check your connection and try again.' },
});

const pending = (): CompetitionLiveCheck => ({ status: 'pending' });

describe('isFreshLiveFixture', () => {
  it('counts a fixture kicked off just now', () => {
    expect(isFreshLiveFixture(fixture({ kickoff: new Date(NOW).toISOString() }), NOW)).toBe(true);
  });

  it('excludes a live-status fixture that kicked off more than the fresh window ago (stuck provider status)', () => {
    const staleKickoff = new Date(NOW - FRESH_LIVE_WINDOW_MS - 60_000).toISOString();
    expect(isFreshLiveFixture(fixture({ kickoff: staleKickoff, status: 'LIVE' }), NOW)).toBe(false);
  });

  it('excludes a fixture that is not live-status at all, regardless of kickoff', () => {
    expect(isFreshLiveFixture(fixture({ status: 'SCHEDULED', kickoff: new Date(NOW).toISOString() }), NOW)).toBe(false);
  });

  it('trusts a live status when the kickoff is unknown or unparsable', () => {
    expect(isFreshLiveFixture(fixture({ kickoff: 'not-a-date' }), NOW)).toBe(true);
    expect(isFreshLiveFixture(fixture({ kickoff: 'not-a-date', status: 'HALF_TIME' }), NOW)).toBe(true);
    expect(isFreshLiveFixture(fixture({ kickoff: 'not-a-date', status: 'SCHEDULED' }), NOW)).toBe(false);
  });

  it('keeps a match fresh through half-time and stoppage (2h40m after kickoff)', () => {
    const kickoff = new Date(NOW - (2 * 60 + 40) * 60_000).toISOString();
    expect(isFreshLiveFixture(fixture({ kickoff, status: 'LIVE' }), NOW)).toBe(true);
  });
});

describe('matchdayAvailability', () => {
  it('is searching when no competitions have been checked yet', () => {
    expect(matchdayAvailability([], NOW)).toBe('searching');
  });

  it('is unavailable once all competitions settled with zero fresh live fixtures', () => {
    const checks: CompetitionLiveCheck[] = [settledOk([]), settledOk([]), settledError()];
    expect(matchdayAvailability(checks, NOW)).toBe('unavailable');
  });

  it('is available when at least one fresh live fixture is found in any competition', () => {
    const checks: CompetitionLiveCheck[] = [settledOk([]), settledOk([fixture()]), pending()];
    expect(matchdayAvailability(checks, NOW)).toBe('available');
  });

  it('excludes a live-status fixture that kicked off more than the fresh window ago from counting as available', () => {
    const stale = fixture({ kickoff: new Date(NOW - FRESH_LIVE_WINDOW_MS - 60_000).toISOString() });
    const checks: CompetitionLiveCheck[] = [settledOk([stale])];
    expect(matchdayAvailability(checks, NOW)).toBe('unavailable');
  });

  it('does not let one failed sub-request prevent the others from being counted', () => {
    const checks: CompetitionLiveCheck[] = [settledError(), settledOk([fixture()])];
    expect(matchdayAvailability(checks, NOW)).toBe('available');
  });

  it('a failed sub-request alongside all-empty settled results still resolves to unavailable, not stuck searching', () => {
    const checks: CompetitionLiveCheck[] = [settledError(), settledOk([])];
    expect(matchdayAvailability(checks, NOW)).toBe('unavailable');
  });

  it('treats a mix of pending and settled (with nothing found yet) as still searching', () => {
    const checks: CompetitionLiveCheck[] = [settledOk([]), pending(), settledError()];
    expect(matchdayAvailability(checks, NOW)).toBe('searching');
  });
});

describe('isMatchdayVisible', () => {
  it('is visible only when the sweep found a live game', () => {
    expect(isMatchdayVisible('available', 'general')).toBe(true);
    expect(isMatchdayVisible('searching', 'general')).toBe(false);
    expect(isMatchdayVisible('unavailable', 'general')).toBe(false);
  });

  it('never hides Matchday from a host already on it', () => {
    expect(isMatchdayVisible('unavailable', 'matchday')).toBe(true);
    expect(isMatchdayVisible('searching', 'matchday')).toBe(true);
  });
});
