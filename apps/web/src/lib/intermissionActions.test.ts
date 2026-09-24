import { describe, expect, it } from 'vitest';
import { intermissionContinueAction } from './intermissionActions';

describe('intermissionContinueAction', () => {
  it('dispatches START_SESSION when the session has finished (play again / new game)', () => {
    expect(intermissionContinueAction(true)).toEqual({ type: 'START_SESSION' });
  });

  it('never dispatches START_LOADING from intermission — the engine rejects it with WRONG_PHASE', () => {
    const action = intermissionContinueAction(true);
    expect(action.type).not.toBe('START_LOADING');
  });

  it('dispatches ADVANCE mid-session (next round of the same game)', () => {
    expect(intermissionContinueAction(false)).toEqual({ type: 'ADVANCE' });
  });
});
