import { describe, expect, it } from 'vitest';
import {
  choiceAfterCategoryChange,
  choiceFromModuleId,
  choiceLabel,
  DEFAULT_CHOICE,
  miniGamesFor,
  NO_MINI_GAME_MESSAGE,
  resolveModuleId,
  validateChoice,
} from './gameMode';

describe('gameMode', () => {
  it('defaults to shuffle and maps it to the category MIX module', () => {
    expect(DEFAULT_CHOICE.mode).toBe('shuffle');
    expect(resolveModuleId('general', DEFAULT_CHOICE)).toBe('G-MIX');
    expect(resolveModuleId('matchday', DEFAULT_CHOICE)).toBe('M-MIX');
  });

  it('lists only non-MIX games of the category', () => {
    const general = miniGamesFor('general').map((game) => game.id);
    expect(general).toEqual(expect.arrayContaining(['G1', 'G3', 'G6']));
    expect(general.every((id) => id.startsWith('G') && id !== 'G-MIX')).toBe(true);
    const matchday = miniGamesFor('matchday').map((game) => game.id);
    expect(matchday).toEqual(expect.arrayContaining(['M1', 'M2', 'M3']));
    expect(matchday).not.toContain('M-MIX');
  });

  it('resolves a picked mini game, and null when none is picked', () => {
    expect(resolveModuleId('general', { mode: 'select', miniGameId: 'G6' })).toBe('G6');
    expect(resolveModuleId('general', { mode: 'select', miniGameId: null })).toBeNull();
  });

  it('rejects a mini game from the other category', () => {
    expect(resolveModuleId('general', { mode: 'select', miniGameId: 'M1' })).toBeNull();
  });

  it('validates: select without a pick gets a clear message, everything else passes', () => {
    expect(validateChoice('general', { mode: 'select', miniGameId: null })).toBe(NO_MINI_GAME_MESSAGE);
    expect(validateChoice('general', { mode: 'select', miniGameId: 'G1' })).toBeNull();
    expect(validateChoice('matchday', DEFAULT_CHOICE)).toBeNull();
  });

  it('a category change resets to shuffle', () => {
    expect(choiceAfterCategoryChange()).toEqual({ mode: 'shuffle', miniGameId: null });
  });

  it('choiceFromModuleId is the inverse of resolveModuleId', () => {
    expect(choiceFromModuleId(null)).toEqual(DEFAULT_CHOICE);
    expect(choiceFromModuleId('G-MIX')).toEqual(DEFAULT_CHOICE);
    expect(choiceFromModuleId('M3')).toEqual({ mode: 'select', miniGameId: 'M3' });
  });

  it('labels shuffle as "Shuffle game" for both categories', () => {
    expect(choiceLabel('G-MIX')).toBe('Shuffle game');
    expect(choiceLabel('M-MIX')).toBe('Shuffle game');
    expect(choiceLabel('G6')).toBe('Trivia Rush');
  });
});
