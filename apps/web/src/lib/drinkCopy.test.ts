import { describe, expect, it } from 'vitest';
import * as rawCopy from './drinkCopy';

/** The copy keeps "1 sip" together with a non-breaking space; the assertions read it as a plain space. */
const plainSpaces = <A extends unknown[]>(fn: (...args: A) => string) => (...args: A): string => fn(...args).replace(/\u00a0/g, ' ');
const bingoFullHouseCall = plainSpaces(rawCopy.bingoFullHouseCall);
const bingoLineCall = plainSpaces(rawCopy.bingoLineCall);
const drinkActionLabel = plainSpaces(rawCopy.drinkActionLabel);
const drinkAnnouncement = plainSpaces(rawCopy.drinkAnnouncement);
const drinkLine = plainSpaces(rawCopy.drinkLine);
const duelLostLine = plainSpaces(rawCopy.duelLostLine);
const eventFiredLine = plainSpaces(rawCopy.eventFiredLine);
const eventRuleLine = plainSpaces(rawCopy.eventRuleLine);
const roundDrinkTotalLine = plainSpaces(rawCopy.roundDrinkTotalLine);
const yourManLine = plainSpaces(rawCopy.yourManLine);
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

describe('Your Man and Stat Duel copy', () => {
  it('words a bad action as the owner drinking', () => {
    expect(yourManLine('FOUL', 'Dembélé', ['Roey'], 'self', 1)).toBe('Dembélé fouls — Roey drinks 1 sip.');
    expect(yourManLine('RED', 'Dembélé', ['Roey'], 'self', 4)).toBe('Dembélé is sent off — Roey drinks a chug.');
  });

  it('words a good action as everyone else drinking', () => {
    expect(yourManLine('GOAL', 'Dembélé', ['Roey'], 'others', 2)).toBe('Dembélé scores! Everyone but Roey drinks 2 sips.');
    expect(yourManLine('ASSIST', 'Vitinha', ['Roey', 'Ana'], 'others', 1)).toBe('Vitinha assists! Everyone but Roey and Ana drinks 1 sip.');
  });

  it('never prints a zero-sip drink', () => {
    expect(yourManLine('FOUL', 'Dembélé', ['Roey'], 'self', 0)).toBe('Dembélé fouls — no drinking for that one.');
    expect(duelLostLine('Ana', 'Roey', 'Most shots', 0)).toContain('gets away with it');
  });

  it('words a lost duel with the stat and the drink', () => {
    expect(duelLostLine('Ana', 'Roey', 'Most shots', 2)).toBe('Ana lost to Roey on most shots and drinks 2 sips.');
  });
});

describe('plural agreement and non-breaking sips', () => {
  it('says "drink" for two owners and keeps the number and unit together', () => {
    expect(eventFiredLine('Corner', ['Roey', 'Ana'], 'owner', 1)).toBe('Corner! Roey and Ana drink 1 sip.');
    expect(rawCopy.drinkActionLabel(2)).toBe('2 sips');
  });
});
