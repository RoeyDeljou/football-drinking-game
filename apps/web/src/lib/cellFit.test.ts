import { describe, expect, it } from 'vitest';
import { labelFitWarning, longestWord, wordTooLongForCell } from './cellFit';

describe('cell fit', () => {
  it('measures the longest word, treating hyphens as break points', () => {
    expect(longestWord('Commentator says world class')).toBe(11);
    expect(longestWord('Trent Alexander-Arnold')).toBe(9);
    expect(longestWord('')).toBe(0);
  });

  it('flags only words past the comfortable limit', () => {
    expect(wordTooLongForCell('Commentator says world class')).toBeNull();
    expect(wordTooLongForCell('Wolfeschlegelsteinhausen scores')).toBe('Wolfeschlegelsteinhausen');
    expect(labelFitWarning('short words only')).toBeNull();
    expect(labelFitWarning('Superlongwordhere!!')).toMatch(/long word/);
  });
});
