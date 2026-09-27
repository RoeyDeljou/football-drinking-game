/** All wording for the matchday/general prefetch screen's elapsed-time states lives here (same convention as `pickerCopy.ts`). */

import type { LoadingElapsedPhase } from './loadingElapsed';

export const LOADING_COPY = {
  slow: 'Still working — fetching everything needed to start can take a little longer than usual.',
  longer: 'Taking longer than usual, but still going. Hang tight — this can happen on a cold start.',
} as const;

export const loadingElapsedMessage = (phase: LoadingElapsedPhase): string | null => {
  switch (phase) {
    case 'slow':
      return LOADING_COPY.slow;
    case 'longer':
      return LOADING_COPY.longer;
    default:
      return null;
  }
};
