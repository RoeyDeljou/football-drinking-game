import { describe, expect, it } from 'vitest';
import { errorMessage } from './errorCopy';

describe('errorMessage', () => {
  it('never returns the raw machine detail (e.g. a raw epoch timestamp)', () => {
    const message = errorMessage({ code: 'DEADLINE_PASSED', detail: '1789731315317' });
    expect(message).not.toContain('1789731315317');
    expect(message.length).toBeGreaterThan(0);
  });

  it('never returns the raw phase word as the whole message (symptom of the WRONG_PHASE bug)', () => {
    const message = errorMessage({ code: 'WRONG_PHASE', detail: 'intermission' });
    expect(message).not.toBe('intermission');
  });

  it('prefers the submission-specific code when present', () => {
    const message = errorMessage({ code: 'INVALID_SUBMISSION', detail: null, submissionCode: 'SLIP_LOCKED' });
    expect(message).toMatch(/locked/i);
  });

  it('falls back to a generic message for an unrecognized code rather than throwing', () => {
    expect(errorMessage({ code: 'SOME_FUTURE_CODE', detail: 'whatever' })).toBe('Something went wrong. Try again.');
  });

  it('gives the specific lineups-not-out-yet reason when DATA_UNAVAILABLE is missing hasLineups', () => {
    const message = errorMessage({ code: 'DATA_UNAVAILABLE', detail: 'hasLineups,hasShirtNumbers' }, 'matchday');
    expect(message).toMatch(/lineups/i);
    expect(message).toMatch(/kick.?off/i);
  });

  it('never blames lineups outside a matchday room, where there is no real match to wait for', () => {
    for (const category of ['general', null] as const) {
      const message = errorMessage({ code: 'DATA_UNAVAILABLE', detail: 'hasLineups,hasShirtNumbers' }, category);
      expect(message).not.toMatch(/lineups/i);
      expect(message).toMatch(/not enough match data/i);
    }
  });

  it('falls back to the generic DATA_UNAVAILABLE message when hasLineups is not among the missing flags', () => {
    const message = errorMessage({ code: 'DATA_UNAVAILABLE', detail: 'hasCareerHistory' });
    expect(message).not.toMatch(/lineups/i);
    expect(message).toMatch(/not enough match data/i);
  });

  it('falls back to the generic DATA_UNAVAILABLE message when detail is null', () => {
    const message = errorMessage({ code: 'DATA_UNAVAILABLE', detail: null });
    expect(message).toMatch(/not enough match data/i);
  });
});

describe('errorMessage: a finished match', () => {
  it('explains that the match is over when a live round cannot be built', () => {
    for (const detail of ['WRONG_ROUND_CONTEXT: fixture FINISHED', 'fixture FINISHED', 'WRONG_ROUND_CONTEXT']) {
      expect(errorMessage({ code: 'ROUND_GENERATION_FAILED', detail })).toMatch(/match has finished/i);
    }
  });

  it('keeps the generic copy for other generation failures', () => {
    expect(errorMessage({ code: 'ROUND_GENERATION_FAILED', detail: 'INSUFFICIENT_DATA' })).toMatch(/couldn’t build/i);
  });
});
