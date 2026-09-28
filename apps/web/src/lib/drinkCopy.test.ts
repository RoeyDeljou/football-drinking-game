import { describe, expect, it } from 'vitest';
import { drinkActionLabel, drinkAnnouncement, drinkLine } from './drinkCopy';
import type { RecordedPenalty } from '@fdg/game-core';

describe('drinkActionLabel', () => {
  it('varies the instruction by sip count instead of always saying "N sips"', () => {
    expect(drinkActionLabel(0)).toBe('no drinking');
    expect(drinkActionLabel(1)).toBe('1 sip');
    expect(drinkActionLabel(2)).toBe('2 sips');
    expect(drinkActionLabel(3)).toBe('a chug');
    expect(drinkActionLabel(4)).toBe('a chug');
    expect(drinkActionLabel(5)).toBe('a shot');
    expect(drinkActionLabel(7)).toBe('a shot');
    expect(drinkActionLabel(8)).toBe('2 shots');
    expect(drinkActionLabel(50)).toBe('2 shots');
  });

  it('never returns a bare number as the whole label', () => {
    for (const sips of [0, 1, 2, 3, 5, 8, 20]) {
      expect(drinkActionLabel(sips)).not.toMatch(/^\d+$/);
    }
  });
});

const penalty = (overrides: Partial<RecordedPenalty> = {}): RecordedPenalty => ({
  sessionId: 'session-1' as RecordedPenalty['sessionId'],
  roundId: 'round-1' as RecordedPenalty['roundId'],
  playerId: 'player-1' as RecordedPenalty['playerId'],
  recipientId: 'player-1' as RecordedPenalty['recipientId'],
  target: 'self',
  requestedSips: 2,
  appliedSips: 2,
  cappedBy: 'none',
  reason: 'WRONG_ANSWER',
  meta: null,
  ...overrides,
});

describe('drinkLine', () => {
  it('says "gets away with it" rather than "downs 0 sips" for a fully capped penalty', () => {
    expect(drinkLine(penalty({ appliedSips: 0 }), 'Alice')).toBe('Alice gets away with it this time.');
  });

  it('uses the varied action label, not a raw sip count, for a non-zero penalty', () => {
    const line = drinkLine(penalty({ appliedSips: 6 }), 'Alice');
    expect(line).toContain('a shot');
    expect(line).not.toContain('6 sips');
  });
});

describe('drinkAnnouncement', () => {
  it('never renders "0 sips" for a fully capped penalty', () => {
    const line = drinkAnnouncement(penalty({ appliedSips: 0, target: 'others' }), 'Bob');
    expect(line).not.toContain('0 sips');
    expect(line).toContain('gets away with it');
  });

  it('uses the varied action label for a non-zero penalty', () => {
    const line = drinkAnnouncement(penalty({ appliedSips: 9, target: 'everyone' }), 'Bob');
    expect(line).toContain('2 shots');
  });
});
