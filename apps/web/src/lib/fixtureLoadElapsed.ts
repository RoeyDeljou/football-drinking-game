/**
 * Pure elapsed-time state for the host page's fixture-list fetch (`GET /competitions/:id/fixtures`).
 *
 * Mirrors the pattern in `selectionPending.ts`/`loadingElapsed.ts`: time is injected (`now`) so this
 * is deterministic in tests, and it decides nothing about rules — a real failure still comes from
 * the fetch's own error state and is handled by the existing retry button, untouched by this module.
 *
 * Why this exists: fetching a league's fixtures is normally fast (the competition list is instant,
 * and the fixture list is cached for 90s), but the FIRST check of a league within that window makes
 * roughly one real request per day of the 14-day upcoming window to the upstream provider, rate
 * limited to about one per second — so a cold check can genuinely take 5-12 seconds before the
 * 90s cache makes every later check instant. Without this, the plain "Loading fixtures…" spinner
 * looks stuck rather than working during that window.
 */

/** Below the API's typical cold-fetch range, so real users see this before they'd start worrying. */
export const FIXTURE_LOAD_SLOW_AFTER_MS = 4_000;

export type FixtureLoadElapsedPhase = 'normal' | 'slow';

export const fixtureLoadElapsedPhase = (input: {
  readonly loading: boolean;
  readonly startedAt: number;
  readonly now: number;
}): FixtureLoadElapsedPhase => {
  if (!input.loading) return 'normal';
  return input.now - input.startedAt >= FIXTURE_LOAD_SLOW_AFTER_MS ? 'slow' : 'normal';
};
