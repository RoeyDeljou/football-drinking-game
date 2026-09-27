import { describe, expect, it } from 'vitest';
import { loadingElapsedPhase, SLOW_AFTER_MS, TAKING_LONGER_AFTER_MS } from './loadingElapsed';

const STARTED_AT = 1_000_000;

describe('loadingElapsedPhase', () => {
  it('is normal right after starting', () => {
    const phase = loadingElapsedPhase({
      startedAt: STARTED_AT,
      steps: [{ status: 'active' }, { status: 'pending' }],
      now: STARTED_AT + 1_000,
    });
    expect(phase).toBe('normal');
  });

  it('becomes slow once past the slow threshold while a step is still active', () => {
    const phase = loadingElapsedPhase({
      startedAt: STARTED_AT,
      steps: [{ status: 'done' }, { status: 'active' }],
      now: STARTED_AT + SLOW_AFTER_MS + 1,
    });
    expect(phase).toBe('slow');
  });

  it('becomes "longer" once past the taking-longer threshold', () => {
    const phase = loadingElapsedPhase({
      startedAt: STARTED_AT,
      steps: [{ status: 'pending' }],
      now: STARTED_AT + TAKING_LONGER_AFTER_MS + 1,
    });
    expect(phase).toBe('longer');
  });

  it('is normal once every step is done, no matter how much time has passed', () => {
    const phase = loadingElapsedPhase({
      startedAt: STARTED_AT,
      steps: [{ status: 'done' }, { status: 'done' }],
      now: STARTED_AT + TAKING_LONGER_AFTER_MS + 1,
    });
    expect(phase).toBe('normal');
  });

  it('is normal once a step has failed, deferring to the existing failed-state UI', () => {
    const phase = loadingElapsedPhase({
      startedAt: STARTED_AT,
      steps: [{ status: 'failed' }, { status: 'done' }],
      now: STARTED_AT + TAKING_LONGER_AFTER_MS + 1,
    });
    expect(phase).toBe('normal');
  });
});
