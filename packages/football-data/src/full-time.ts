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
 * 3. If there is none, one is synthesized with the stable id `synthetic:full-time:<fixtureId>`. The id is the same on
 *    every poll, and the `synthetic:` prefix can never collide with `espn:<playId>` or an API-Football content id.
 * 4. The synthetic event's minute is 90 (no extra minute) unless the latest real event is already past 90
 *    (stoppage time or extra time), in which case it reuses that event's minute/extraMinute.
 * 5. If the real event shows up on a later poll, the list again has exactly one FULL_TIME (the real one), but it has
 *    a different id from the synthetic one a consumer may already have applied. Consumers must therefore treat
 *    FULL_TIME idempotently (the first one seen settles the match); it must never be counted twice.
 */

import type { FixtureId, LiveMatchState, MatchEvent } from './domain.js';

export const SYNTHETIC_FULL_TIME_PREFIX = 'synthetic:full-time:';

export function syntheticFullTimeId(fixtureId: FixtureId): string {
  return `${SYNTHETIC_FULL_TIME_PREFIX}${fixtureId}`;
}

export function isSyntheticEvent(event: MatchEvent): boolean {
  return event.id.startsWith('synthetic:');
}

/** Apply rules 2–4 to an event list of a finished fixture. Pure; returns the input untouched if already compliant. */
export function withGuaranteedFullTime(fixtureId: FixtureId, events: readonly MatchEvent[]): readonly MatchEvent[] {
  const real = events.filter((event) => event.type === 'FULL_TIME');
  const last = events[events.length - 1];
  if (real.length === 1 && last === real[0]) return events;
  if (real.length > 0) {
    const finalWhistle = real[real.length - 1];
    if (finalWhistle === undefined) return events;
    return [...events.filter((event) => event.type !== 'FULL_TIME'), finalWhistle];
  }
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

/** Apply the guarantee to a whole live state. */
export function guaranteeFullTime(state: LiveMatchState): LiveMatchState {
  if (state.fixture.status !== 'FINISHED') return state;
  const events = withGuaranteedFullTime(state.fixture.id, state.events);
  return events === state.events ? state : { ...state, events };
}
