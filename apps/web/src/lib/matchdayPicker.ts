/**
 * Pure view-state derivation for the host's league -> fixture picker (Task A).
 *
 * Kept free of React so it is trivially unit-testable and so the component only ever renders a
 * state this module computed — it never decides "is this empty or still loading" inline in JSX.
 */

import type { ApiResult, Competition, FixtureSummary } from './api';

export type CompetitionsView =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly competitions: readonly Competition[] };

/** `result === null` means the request hasn't resolved yet (still in flight or not yet sent). */
export const competitionsView = (result: ApiResult<{ competitions: readonly Competition[] }> | null): CompetitionsView => {
  if (result === null) return { status: 'loading' };
  if (!result.ok) return { status: 'error', message: result.message };
  return { status: 'ready', competitions: result.value.competitions };
};

export type FixturesView =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'empty' }
  | { readonly status: 'ready'; readonly fixtures: readonly FixtureSummary[] };

/** An empty-but-successful list is a normal state ("No live games for this competition."), not an error. */
export const fixturesView = (result: ApiResult<{ fixtures: readonly FixtureSummary[] }> | null): FixturesView => {
  if (result === null) return { status: 'loading' };
  if (!result.ok) return { status: 'error', message: result.message };
  return result.value.fixtures.length === 0
    ? { status: 'empty' }
    : { status: 'ready', fixtures: result.value.fixtures };
};

const LIVE_STATUSES: readonly FixtureSummary['status'][] = ['LIVE', 'HALF_TIME', 'EXTRA_TIME', 'PENALTIES'];

export const isFixtureLive = (fixture: Pick<FixtureSummary, 'status'>): boolean =>
  LIVE_STATUSES.includes(fixture.status);

/** How many of a fixture list's entries are currently live — the basis for whether "play the whole
 * live gameday" is worth offering at all. */
export const liveFixtureCount = (fixtures: readonly Pick<FixtureSummary, 'status'>[]): number =>
  fixtures.filter(isFixtureLive).length;

/** Gameday mode only makes sense with something to *rotate* through — one live fixture is already
 * covered fine by picking it directly, and zero means the option shouldn't render at all. */
export const shouldOfferGameday = (liveCount: number): boolean => liveCount >= 2;

/** e.g. "3 live matches — play them all". */
export const gamedayOptionLabel = (liveCount: number): string =>
  `${liveCount} live match${liveCount === 1 ? '' : 'es'} — play them all`;

/** `LIVE 63'`, `HALF-TIME`, or nothing for a not-yet-started fixture. */
export const liveBadgeLabel = (fixture: Pick<FixtureSummary, 'status' | 'minute'>): string | null => {
  if (fixture.status === 'HALF_TIME') return 'HALF-TIME';
  if (fixture.status === 'EXTRA_TIME') return `LIVE ${fixture.minute ?? '—'}' (ET)`;
  if (fixture.status === 'PENALTIES') return 'PENALTIES';
  if (fixture.status === 'LIVE') return `LIVE ${fixture.minute ?? '—'}'`;
  return null;
};

/** Kickoff formatted in the viewer's own local time zone/locale, e.g. `Sat 20:00`. */
export const formatKickoffLocal = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
};

/** `in 2h 15m`, `in 45m`, `in 3d`, or `kicking off` once we're within a minute of kickoff. */
export const kickoffCountdown = (iso: string, nowMs: number): string => {
  const kickoffMs = Date.parse(iso);
  if (Number.isNaN(kickoffMs)) return '';
  const remainingMs = kickoffMs - nowMs;
  if (remainingMs <= 60_000) return 'kicking off';
  const minutes = Math.round(remainingMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return remMinutes > 0 ? `in ${hours}h ${remMinutes}m` : `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
};
