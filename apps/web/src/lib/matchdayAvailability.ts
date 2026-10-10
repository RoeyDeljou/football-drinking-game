/**
 * Pure decision logic for whether the "Matchday" category is selectable at all (Task: background
 * live-game sweep across every competition on the host page).
 *
 * A fixture only counts if it is both live-status *and* fresh: the server already filters
 * `window=live` fixtures to LIVE/HALF_TIME/EXTRA_TIME/PENALTIES, but a provider can get stuck
 * reporting a match as LIVE long after it actually finished, so a client-side recency check (kicked
 * off less than `FRESH_LIVE_WINDOW_MS` ago) guards against that.
 *
 * Kept free of React, exactly like `matchdayPicker.ts` — the component only ever renders a state
 * this module computed.
 */

import type { ApiResult, FixtureSummary } from './api';
import { isFixtureLive } from './matchdayPicker';

/** Only count a live fixture if it kicked off less than 3 hours ago (90 min + half-time + stoppage + delays). */
export const FRESH_LIVE_WINDOW_MS = 3 * 60 * 60 * 1000;

export const isFreshLiveFixture = (fixture: Pick<FixtureSummary, 'status' | 'kickoff'>, nowMs: number): boolean => {
  if (!isFixtureLive(fixture)) return false;
  const kickoffMs = Date.parse(fixture.kickoff);
  // The provider says it is live and gave no usable kickoff time: trust the status.
  if (Number.isNaN(kickoffMs)) return true;
  return nowMs - kickoffMs < FRESH_LIVE_WINDOW_MS;
};

/** One competition's live-fixture check, as fanned out in parallel over every competition. */
export type CompetitionLiveCheck =
  | { readonly status: 'pending' }
  | { readonly status: 'settled'; readonly result: ApiResult<{ fixtures: readonly FixtureSummary[] }> };

export type MatchdayAvailability = 'searching' | 'available' | 'unavailable';

/**
 * `checks` is one entry per competition being swept. Strategy for mixed pending/settled:
 *  - If ANY settled check already has a fresh live fixture, the category is `'available'`
 *    immediately — no need to wait for the rest (a host shouldn't sit in "searching" a moment
 *    longer than necessary once we already know the answer is yes).
 *  - Otherwise, if every check has settled (a failed sub-request counts as settled — "no live
 *    fixtures found there", it never blocks the others) and none had a fresh live fixture, the
 *    category is `'unavailable'`.
 *  - Otherwise (nothing found yet, but not everything has settled — including the empty-list case,
 *    which means the sweep hasn't even been kicked off yet) it's `'searching'`.
 */
export const matchdayAvailability = (checks: readonly CompetitionLiveCheck[], nowMs: number): MatchdayAvailability => {
  const hasFreshLiveFixture = checks.some(
    (check) =>
      check.status === 'settled' &&
      check.result.ok &&
      check.result.value.fixtures.some((fixture) => isFreshLiveFixture(fixture, nowMs)),
  );
  if (hasFreshLiveFixture) return 'available';

  const allSettled = checks.length > 0 && checks.every((check) => check.status === 'settled');
  return allSettled ? 'unavailable' : 'searching';
};

/**
 * Whether the host page renders the Matchday category at all. It is hidden (not greyed out) unless
 * the sweep found a live game: no disabled button, and no flicker while the sweep is `'searching'`.
 *
 * A host who is already on Matchday keeps seeing it even if a re-check flips to `'unavailable'` —
 * availability only gates a *new* selection, it never yanks the host out of what they're setting up.
 */
export const isMatchdayVisible = (availability: MatchdayAvailability, currentCategory: 'matchday' | 'general'): boolean =>
  availability === 'available' || currentCategory === 'matchday';
