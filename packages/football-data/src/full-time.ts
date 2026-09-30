/**
 * The FULL_TIME guarantee.
 *
 * Consumers (Match Markets auto-resolution) settle full-time markets on the `FULL_TIME` event, but upstream feeds
 * routinely flip a fixture to FINISHED before the final-whistle play is published (or never publish one). The data
 * layer therefore guarantees: **any `LiveMatchState` whose fixture status is `FINISHED` contains exactly one
 * `FULL_TIME` event, last in the list.**
 *
 * ## Rules
 *
 * 1. Only applies when `fixture.status === 'FINISHED'`. Events of a match still in progress are never touched.
 * 2. A real (upstream) `FULL_TIME` always wins over a synthetic one. If the upstream list has one or more real
 *    `FULL_TIME` events (ESPN emits `end-regular-time` *and* `end-extra-time` for a match that goes to extra time),
 *    only the LAST real one is kept — the final whistle — earlier ones are dropped, and it is moved to the end.
 * 3. **A synthetic one is only ever created when it is safe to settle on**, i.e. when ALL hold:
 *    a. the final status is confirmed (an explicit final status name or `completed: true`, never a bare `post`
 *       fallback) — providers pass `confirmedFinal`;
 *    b. `fixture.score` is known; and
 *    c. the goals counted from the events (GOAL and PENALTY_SCORED for the scoring side, OWN_GOAL credited to the
 *       opponent of the player's team; shootout kicks are never events) equal `fixture.score` home and away.
 *    A lagging feed that already says FINISHED but is missing a late goal, or has no plays at all while the score is
 *    non-zero, fails (c): no synthetic is emitted (the state is FINISHED without FULL_TIME) and providers keep the
 *    summary on the short TTL so the missing plays can land. A full time is never synthesized from an
 *    inconsistent event list, however long it stays inconsistent; the host can reveal manually.
 * 4. When synthesized: id `synthetic:full-time:<fixtureId>` (same on every poll; the `synthetic:` prefix can never
 *    collide with `espn:<playId>` or `apif:` ids), minute 90 unless the latest event is already at 90 or later, in
 *    which case it reuses that event's minute/extraMinute; appended after all other events.
 * 5. If the real event shows up on a later poll, the list again has exactly one FULL_TIME (the real one), but its id
 *    differs from the synthetic one a consumer may already have applied. Consumers must treat FULL_TIME
 *    idempotently (the first one seen settles the match).
 */

import type { Fixture, FixtureId, LiveMatchState, MatchEvent, Score } from './domain.js';

export const SYNTHETIC_FULL_TIME_PREFIX = 'synthetic:full-time:';

export function syntheticFullTimeId(fixtureId: FixtureId): string {
  return `${SYNTHETIC_FULL_TIME_PREFIX}${fixtureId}`;
}

export function isSyntheticEvent(event: MatchEvent): boolean {
  return event.id.startsWith('synthetic:');
}

/**
 * Do the goals in `events` add up to `score`? Own goals count for the opponent of the scorer's team. A goal with no
 * team cannot be attributed, so the list is treated as inconsistent.
 */
export function goalsMatchScore(events: readonly MatchEvent[], score: Score, homeTeamId: string): boolean {
  let home = 0;
  let away = 0;
  for (const event of events) {
    const scored = event.type === 'GOAL' || event.type === 'PENALTY_SCORED';
    const own = event.type === 'OWN_GOAL';
    if (!scored && !own) continue;
    if (event.teamId === null) return false;
    const forHome = event.teamId === homeTeamId;
    if ((scored && forHome) || (own && !forHome)) home += 1;
    else away += 1;
  }
  return home === score.home && away === score.away;
}

export function eventsMatchFixtureScore(fixture: Fixture, events: readonly MatchEvent[]): boolean {
  return fixture.score !== null && goalsMatchScore(events, fixture.score, fixture.homeTeam.id);
}

/**
 * Apply rules 2–4 to an event list of a finished fixture. Pure; returns the input untouched if already compliant.
 * `allowSynthetic` is the caller's verdict on rule 3 (confirmed final and score-consistent).
 */
export function withGuaranteedFullTime(
  fixtureId: FixtureId,
  events: readonly MatchEvent[],
  allowSynthetic = true,
): readonly MatchEvent[] {
  const real = events.filter((event) => event.type === 'FULL_TIME');
  const last = events[events.length - 1];
  if (real.length === 1 && last === real[0]) return events;
  if (real.length > 0) {
    const finalWhistle = real[real.length - 1];
    if (finalWhistle === undefined) return events;
    return [...events.filter((event) => event.type !== 'FULL_TIME'), finalWhistle];
  }
  if (!allowSynthetic) return events;
  const latest = last !== undefined && last.minute >= 90 ? last : null;
  const synthetic: MatchEvent = {
    id: syntheticFullTimeId(fixtureId),
    fixtureId,
    type: 'FULL_TIME',
    minute: latest?.minute ?? 90,
    extraMinute: latest?.extraMinute ?? null,
    teamId: null,
    playerId: null,
    playerName: null,
    relatedPlayerId: null,
    detail: 'Full time (synthesized: the upstream feed reported the match finished without a full-time event)',
  };
  return [...events, synthetic];
}

/** Apply the guarantee to a whole live state (score consistency is checked here; see rule 3). */
export function guaranteeFullTime(state: LiveMatchState, confirmedFinal = true): LiveMatchState {
  if (state.fixture.status !== 'FINISHED') return state;
  const allow = confirmedFinal && eventsMatchFixtureScore(state.fixture, state.events);
  const events = withGuaranteedFullTime(state.fixture.id, state.events, allow);
  return events === state.events ? state : { ...state, events };
}
