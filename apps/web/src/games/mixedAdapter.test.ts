import type { ProjectedRound } from '@fdg/game-core';
import { describe, expect, it } from 'vitest';
import { unwrapMixedRound } from './mixedAdapter';

const baseFields = {
  id: 'round-1',
  index: 2,
  moduleId: 'G-MIX',
  kind: 'simultaneous-answer',
  status: 'open',
  startedAt: 1_000,
  answerWindowMs: 20_000,
  deadlineAt: 21_000,
  turn: null,
  submissionStatus: [],
} as const;

const preRevealRound = (): ProjectedRound =>
  ({
    ...baseFields,
    visibility: 'pre-reveal',
    publicPayload: { kind: 'MIXED', moduleId: 'G1', inner: { kind: 'GUESS_PLAYER', clues: [], options: [] } },
    privatePayload: null,
    yourSubmission: null,
  }) as unknown as ProjectedRound;

const revealedRound = (): ProjectedRound =>
  ({
    ...baseFields,
    visibility: 'revealed',
    publicPayload: { kind: 'MIXED', moduleId: 'G3', inner: { kind: 'CAREER_PATH', clubs: [], options: [] } },
    solution: { moduleId: 'G3', inner: { playerId: 'p1', name: 'Someone', clueCount: 3 } },
    privatePayload: null,
    yourSubmission: { playerId: 'p1' },
    outcome: null,
    submissions: [{ playerId: 'p1', payload: { playerId: 'p1' }, submittedAt: 1_500, elapsedMs: 500 }],
    penalties: [],
  }) as unknown as ProjectedRound;

describe('unwrapMixedRound', () => {
  it('unwraps a pre-reveal round to the inner public payload, leaving the solution absent', () => {
    const { moduleId, round } = unwrapMixedRound(preRevealRound());
    expect(moduleId).toBe('G1');
    expect(round.publicPayload).toEqual({ kind: 'GUESS_PLAYER', clues: [], options: [] });
    expect(round.visibility).toBe('pre-reveal');
  });

  it('unwraps a revealed round to the inner public payload and inner solution', () => {
    const { moduleId, round } = unwrapMixedRound(revealedRound());
    expect(moduleId).toBe('G3');
    expect(round.publicPayload).toEqual({ kind: 'CAREER_PATH', clubs: [], options: [] });
    expect(round.visibility).toBe('revealed');
    if (round.visibility === 'revealed') {
      expect(round.solution).toEqual({ playerId: 'p1', name: 'Someone', clueCount: 3 });
    }
  });

  it('passes submissions and yourSubmission through untouched (they were never wrapped)', () => {
    const { round } = unwrapMixedRound(revealedRound());
    expect(round.yourSubmission).toEqual({ playerId: 'p1' });
    if (round.visibility === 'revealed') {
      expect(round.submissions).toEqual([{ playerId: 'p1', payload: { playerId: 'p1' }, submittedAt: 1_500, elapsedMs: 500 }]);
    }
  });
});
