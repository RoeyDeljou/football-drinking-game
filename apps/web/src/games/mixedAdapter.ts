/**
 * Pure unwrapping for a Mixed (`G-MIX`/`M-MIX`) round.
 *
 * The engine's Mixed envelope is `{ kind: 'MIXED', moduleId, inner }` for the public payload and
 * `{ moduleId, inner }` for the solution (see `packages/game-core/src/modules/mixed.ts`). Submissions
 * are never wrapped. `unwrapMixedRound` strips the envelope so the *existing* per-game screen
 * component can render the round exactly as if it had been selected directly — it never needs to know
 * it might be running inside a rotation.
 */
import type { ProjectedRound } from '@fdg/game-core';

interface MixedPublicPayload {
  readonly kind: 'MIXED';
  readonly moduleId: string;
  readonly inner: unknown;
}

interface MixedSolution {
  readonly moduleId: string;
  readonly inner: unknown;
}

export interface UnwrappedMixedRound {
  /** The sub-module id this particular round was drawn from — used to pick the inner screen. */
  readonly moduleId: string;
  /** `round` with `publicPayload`/`solution` replaced by the sub-module's own unwrapped shape;
   * every other field (submissions, yourSubmission, visibility, deadlines, …) passes through as-is. */
  readonly round: ProjectedRound;
}

export const unwrapMixedRound = (round: ProjectedRound): UnwrappedMixedRound => {
  const payload = round.publicPayload as MixedPublicPayload;
  if (round.visibility === 'revealed') {
    const solution = round.solution as MixedSolution;
    return {
      moduleId: payload.moduleId,
      round: { ...round, publicPayload: payload.inner, solution: solution.inner },
    };
  }
  return {
    moduleId: payload.moduleId,
    round: { ...round, publicPayload: payload.inner },
  };
};
