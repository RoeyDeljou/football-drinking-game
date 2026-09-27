import { describe, expect, it } from 'vitest';
import type { ApiResult, Competition, FixtureSummary } from './api';
import {
  competitionsView,
  fixturesView,
  formatKickoffLocal,
  isFixtureLive,
  kickoffCountdown,
  liveBadgeLabel,
} from './matchdayPicker';

const COMPETITIONS: readonly Competition[] = [
  { id: 'premier-league', code: 'PREMIER_LEAGUE', name: 'Premier League', country: 'England', logoUrl: null, currentSeason: '2026/27' },
];

const fixture = (overrides: Partial<FixtureSummary> = {}): FixtureSummary => ({
  fixtureId: 'fx-1',
  kickoff: '2026-01-01T20:00:00.000Z',
  status: 'SCHEDULED',
  minute: null,
  competitionId: 'premier-league',
  homeTeam: { name: 'Arsenal', crestUrl: null },
  awayTeam: { name: 'Chelsea', crestUrl: null },
  ...overrides,
});

describe('competitionsView', () => {
  it('is loading while the request has not resolved', () => {
    expect(competitionsView(null)).toEqual({ status: 'loading' });
  });

  it('surfaces a fetch failure as an error state', () => {
    const result: ApiResult<{ competitions: readonly Competition[] }> = { ok: false, message: 'Could not reach the server.' };
    expect(competitionsView(result)).toEqual({ status: 'error', message: 'Could not reach the server.' });
  });

  it('exposes the competitions once ready', () => {
    const result: ApiResult<{ competitions: readonly Competition[] }> = { ok: true, value: { competitions: COMPETITIONS } };
    expect(competitionsView(result)).toEqual({ status: 'ready', competitions: COMPETITIONS });
  });
});

describe('fixturesView', () => {
  it('is loading while the request has not resolved', () => {
    expect(fixturesView(null)).toEqual({ status: 'loading' });
  });

  it('surfaces a fetch failure (e.g. 503 DATA_UNAVAILABLE) as an error, not an empty state', () => {
    const result: ApiResult<{ fixtures: readonly FixtureSummary[] }> = { ok: false, message: 'Could not load fixtures.' };
    expect(fixturesView(result)).toEqual({ status: 'error', message: 'Could not load fixtures.' });
  });

  it('treats a successful empty list as the normal "no live games" state, not an error', () => {
    const result: ApiResult<{ fixtures: readonly FixtureSummary[] }> = { ok: true, value: { fixtures: [] } };
    expect(fixturesView(result)).toEqual({ status: 'empty' });
  });

  it('exposes the fixtures once ready', () => {
    const fixtures = [fixture()];
    const result: ApiResult<{ fixtures: readonly FixtureSummary[] }> = { ok: true, value: { fixtures } };
    expect(fixturesView(result)).toEqual({ status: 'ready', fixtures });
  });
});

describe('isFixtureLive / liveBadgeLabel', () => {
  it('treats SCHEDULED and FINISHED as not live, with no badge', () => {
    expect(isFixtureLive(fixture({ status: 'SCHEDULED' }))).toBe(false);
    expect(isFixtureLive(fixture({ status: 'FINISHED' }))).toBe(false);
    expect(liveBadgeLabel(fixture({ status: 'SCHEDULED' }))).toBeNull();
  });

  it('treats LIVE/HALF_TIME/EXTRA_TIME/PENALTIES as live, with a badge', () => {
    expect(isFixtureLive(fixture({ status: 'LIVE', minute: 63 }))).toBe(true);
    expect(liveBadgeLabel(fixture({ status: 'LIVE', minute: 63 }))).toBe("LIVE 63'");
    expect(liveBadgeLabel(fixture({ status: 'HALF_TIME' }))).toBe('HALF-TIME');
    expect(liveBadgeLabel(fixture({ status: 'PENALTIES' }))).toBe('PENALTIES');
  });
});

describe('formatKickoffLocal', () => {
  it('formats a valid ISO kickoff into a readable local string', () => {
    const formatted = formatKickoffLocal('2026-01-01T20:00:00.000Z');
    expect(formatted.length).toBeGreaterThan(0);
    expect(formatted).not.toBe('2026-01-01T20:00:00.000Z');
  });

  it('falls back to the raw string for an unparseable date', () => {
    expect(formatKickoffLocal('not-a-date')).toBe('not-a-date');
  });
});

describe('kickoffCountdown', () => {
  const nowMs = Date.parse('2026-01-01T18:00:00.000Z');

  it('says "kicking off" once within a minute of kickoff', () => {
    expect(kickoffCountdown('2026-01-01T18:00:30.000Z', nowMs)).toBe('kicking off');
  });

  it('reports minutes for a near kickoff', () => {
    expect(kickoffCountdown('2026-01-01T18:45:00.000Z', nowMs)).toBe('in 45m');
  });

  it('reports hours and minutes for a same-day kickoff', () => {
    expect(kickoffCountdown('2026-01-01T20:15:00.000Z', nowMs)).toBe('in 2h 15m');
  });

  it('reports days for a far-off kickoff', () => {
    expect(kickoffCountdown('2026-01-05T18:00:00.000Z', nowMs)).toBe('in 4d');
  });
});
