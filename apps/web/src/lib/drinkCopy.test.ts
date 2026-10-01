import { describe, expect, it } from 'vitest';
import {
  bingoFullHouseCall,
  bingoLineCall,
  drinkActionLabel,
  drinkAnnouncement,
  drinkLine,
  eventFiredLine,
  eventRuleLine,
  roundDrinkTotalLine,
} from './drinkCopy';
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

describe('live pitch game copy (Event Roulette, Match Bingo)', () => {
  it('words an owner-drinks fire as "Corner! Roey drinks 1 sip."', () => {
    expect(eventFiredLine('Corner', ['Roey'], 'owner', 1)).toBe('Corner! Roey drinks 1 sip.');
  });

  it('words an others-drink fire so the owner is clearly safe', () => {
    expect(eventFiredLine('Foul', ['Roey'], 'others', 2)).toBe('Foul! Roey is safe, everyone else drinks 2 sips.');
    expect(eventFiredLine('Foul', ['Roey', 'Ana'], 'others', 1)).toContain('Roey and Ana are safe');
  });

  it('states the rule for the dealt viewer', () => {
    expect(eventRuleLine('owner', 1)).toBe('When your event fires, you drink 1 sip.');
    expect(eventRuleLine('others', 3)).toBe('When your event fires, everyone else drinks a chug.');
  });

  it('calls a bingo line and a full house through the shared drink wording', () => {
    expect(bingoLineCall('Roey', 2)).toBe('Line! Everyone but Roey drinks 2 sips.');
    expect(bingoFullHouseCall('Roey', 6)).toBe('Full house! Roey is done, everyone else downs a shot.');
  });

  it('totals a recipient without ever printing "0 sips"', () => {
    expect(roundDrinkTotalLine('Ana', 0)).toBe('Ana gets away with it.');
    expect(roundDrinkTotalLine('Ana', 2)).toBe('Ana downs 2 sips.');
  });
});
