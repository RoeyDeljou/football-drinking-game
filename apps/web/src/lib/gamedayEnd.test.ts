import { describe, expect, it } from 'vitest';
import { isGamedayExhaustedErrorCode, shouldShowGamedayExhaustedBanner } from './gamedayEnd';

describe('isGamedayExhaustedErrorCode', () => {
  it('recognizes both shapes the backend may reject an exhausted ADVANCE with', () => {
    expect(isGamedayExhaustedErrorCode('ROUND_GENERATION_FAILED')).toBe(true);
    expect(isGamedayExhaustedErrorCode('DATA_UNAVAILABLE')).toBe(true);
  });

  it('does not misclassify an unrelated rejection', () => {
    expect(isGamedayExhaustedErrorCode('WRONG_PHASE')).toBe(false);
    expect(isGamedayExhaustedErrorCode('NOT_HOST')).toBe(false);
  });
});

describe('shouldShowGamedayExhaustedBanner', () => {
  it('shows the dedicated banner only for a gameday room whose rejected ADVANCE has a matching error code', () => {
    expect(shouldShowGamedayExhaustedBanner(true, 'ROUND_GENERATION_FAILED', true)).toBe(true);
    expect(shouldShowGamedayExhaustedBanner(true, 'DATA_UNAVAILABLE', true)).toBe(true);
  });

  it('never shows it for a non-gameday room even with the same error code', () => {
    expect(shouldShowGamedayExhaustedBanner(false, 'ROUND_GENERATION_FAILED', true)).toBe(false);
    expect(shouldShowGamedayExhaustedBanner(false, 'DATA_UNAVAILABLE', true)).toBe(false);
  });

  it('never shows it when there is no error', () => {
    expect(shouldShowGamedayExhaustedBanner(true, null, true)).toBe(false);
  });

  it('never shows it for an unrelated error code, even in a gameday room', () => {
    expect(shouldShowGamedayExhaustedBanner(true, 'WRONG_PHASE', true)).toBe(false);
  });

  it('never shows it when the matching error code came from a different action than ADVANCE (e.g. SELECT_GAME rejecting a specific unplayable game)', () => {
    expect(shouldShowGamedayExhaustedBanner(true, 'DATA_UNAVAILABLE', false)).toBe(false);
    expect(shouldShowGamedayExhaustedBanner(true, 'ROUND_GENERATION_FAILED', false)).toBe(false);
  });
});
