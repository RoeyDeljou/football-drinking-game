import { describe, expect, it } from 'vitest';
import { configFor, DEFAULT_SETTINGS, invalidConfigMessage, settingsSummary, withEdit } from './gameSettings';

describe('configFor', () => {
  it('sends nothing in Default mode, and for a game without settings', () => {
    expect(configFor('M6', DEFAULT_SETTINGS)).toBeNull();
    expect(configFor('G1', { mode: 'custom', edits: { a: 1 } })).toBeNull();
  });

  it('sends defaults plus edits in Custom mode', () => {
    const config = configFor('M8', withEdit({ mode: 'custom', edits: {} }, 'duelSips', 5));
    expect(config).toMatchObject({ duelSips: 5, stats: expect.any(Array), pickWindowMs: 90_000 });
  });

  it('drops an edit when the value is cleared', () => {
    expect(withEdit({ mode: 'custom', edits: { houseCells: ['x'] } }, 'houseCells', undefined).edits).toEqual({});
  });
});

describe('settingsSummary', () => {
  it('is null for the defaults and names what changed otherwise', () => {
    expect(settingsSummary('M8', { duelSips: 2 })).toBeNull();
    expect(settingsSummary('M8', { duelSips: 4 })).toBe('Sips for losing a duel 4 sips');
    expect(settingsSummary('M6', { houseCells: ['a', 'b'], cellPool: new Array(12).fill({}) })).toBe('12 custom cells · 2 house cells');
  });
});

describe('invalidConfigMessage', () => {
  it('turns "path: message" into a readable line', () => {
    expect(invalidConfigMessage('cellPool: a 3x3 card needs at least 7 pool cells, got 3')).toBe(
      'Those settings aren’t valid — Bingo cells: a 3x3 card needs at least 7 pool cells, got 3',
    );
  });
  it('copes with no detail', () => {
    expect(invalidConfigMessage(null)).toBe('Those settings aren’t valid.');
  });
});
