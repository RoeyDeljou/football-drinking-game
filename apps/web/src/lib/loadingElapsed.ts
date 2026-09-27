/**
 * Pure elapsed-time state for the matchday/general prefetch screen (`LoadingScreen.tsx`).
 *
 * Mirrors the pattern in `selectionPending.ts`: time is injected (`now`) so this is deterministic in
 * tests, and it only ever computes "how long has this been running", never anything about rules —
 * a real failure still comes from the engine's `LoadingStep.status === 'failed'` and is handled by
 * the existing retry button, untouched by this module.
 */

import type { LoadingStepStatus } from '@fdg/game-core';

/** Matches the game picker's "slow" threshold so the two waiting experiences feel consistent. */
export const SLOW_AFTER_MS = 8_000;

/**
 * Real matchday prefetch (fixture -> lineups -> squads -> stats against a live provider, possibly a
 * cold server) is expected to run longer than the general-dataset warm-up case the picker's
 * "stalled" copy was sized for, so this "taking longer than usual" threshold sits well past it.
 */
export const TAKING_LONGER_AFTER_MS = 45_000;

export type LoadingElapsedPhase = 'normal' | 'slow' | 'longer';

export interface LoadingElapsedInput {
  readonly startedAt: number;
  readonly steps: readonly { readonly status: LoadingStepStatus }[];
  readonly now: number;
}

/**
 * Only reports "still going" while a step is actually in flight (`pending`/`active`) — once
 * everything is `done`, or a step has `failed`, this is `'normal'` so it never fights with the
 * existing success/failed UI.
 */
export const loadingElapsedPhase = (input: LoadingElapsedInput): LoadingElapsedPhase => {
  const stillGoing = input.steps.some((step) => step.status === 'pending' || step.status === 'active');
  if (!stillGoing) return 'normal';
  const elapsed = input.now - input.startedAt;
  if (elapsed >= TAKING_LONGER_AFTER_MS) return 'longer';
  if (elapsed >= SLOW_AFTER_MS) return 'slow';
  return 'normal';
};
