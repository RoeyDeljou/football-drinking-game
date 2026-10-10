/**
 * The "open for play" window: a fixture can be picked for a matchday room from this long BEFORE its scheduled
 * kickoff (players join and the host sets up cards while the teams warm up) and for as long as it is live.
 * One constant, used by the fixture list (`window=open`) and documented for the room-creation check.
 */

import type { Fixture } from '@fdg/football-data';
import { isLiveFixtureStatus } from '@fdg/football-data';

export const OPEN_BEFORE_KICKOFF_MS = 30 * 60 * 1000;

/** A scheduled fixture whose kickoff has not slipped more than this far into the past still counts (provider lag). */
const SCHEDULED_GRACE_MS = 2 * 60 * 60 * 1000;

/** Live, or SCHEDULED and kicking off within `OPEN_BEFORE_KICKOFF_MS` (or just past, awaiting the provider's flip). */
export const isOpenForPlay = (fixture: Fixture, nowMs: number): boolean => {
  if (isLiveFixtureStatus(fixture.status)) return true;
  if (fixture.status !== 'SCHEDULED') return false;
  const kickoffMs = Date.parse(fixture.kickoff);
  if (Number.isNaN(kickoffMs)) return false;
  return kickoffMs <= nowMs + OPEN_BEFORE_KICKOFF_MS && kickoffMs >= nowMs - SCHEDULED_GRACE_MS;
};

/** Calendar date (`YYYY-MM-DD`) of an instant in US Eastern time, the day boundary ESPN's current scoreboard uses. */
const easternDate = (ms: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(ms),
  );

/**
 * The dated scoreboard to ALSO check, or `null`: only when `now + 30 min` falls on a different Eastern calendar day than
 * `now`, i.e. a match kicking off just after midnight ET is already inside the window but absent from the current
 * scoreboard. At most one extra call per slug.
 */
export const nextDayToCheck = (nowMs: number): string | null => {
  const later = nowMs + OPEN_BEFORE_KICKOFF_MS;
  return easternDate(later) === easternDate(nowMs) ? null : easternDate(later);
};
