import { describe, expect, it } from 'vitest';
import {
  assignGuesses,
  compactName,
  editDistance,
  nameDistance,
  nameKeys,
  normalizeName,
  typoAllowance,
} from './name-matching.js';

const c = (id: string, name: string) => ({ id, name });

describe('normalizeName', () => {
  it('strips accents, transliterates special letters, lower-cases and splits on any punctuation', () => {
    expect(normalizeName('Kylian Mbappé')).toBe('kylian mbappe');
    expect(normalizeName('Marc-André ter Stegen')).toBe('marc andre ter stegen');
    expect(normalizeName('Martin Ødegaard')).toBe('martin odegaard');
    expect(normalizeName('Robert Lewandowski')).toBe('robert lewandowski');
    expect(normalizeName('Łukasz Fabiański')).toBe('lukasz fabianski');
    expect(normalizeName("N'Golo Kanté")).toBe('n golo kante');
    expect(normalizeName('  Thomas   MÜLLER ')).toBe('thomas muller');
    expect(normalizeName('Çalhanoğlu')).toBe('calhanoglu');
    expect(normalizeName('Straße')).toBe('strasse');
    expect(normalizeName('!!!')).toBe('');
    expect(compactName('Ter-Stegen')).toBe('terstegen');
  });
});

describe('nameKeys', () => {
  it('offers the full name, every surname suffix and the first name', () => {
    expect(nameKeys('Kylian Mbappé')).toEqual(['kylianmbappe', 'mbappe', 'kylian']);
    expect(nameKeys('Frenkie de Jong')).toEqual(['frenkiedejong', 'dejong', 'jong', 'frenkie']);
    expect(nameKeys('Son Heung-Min')).toEqual(['sonheungmin', 'heungmin', 'min', 'son']);
  });

  it('keeps mononyms whole and never offers a bare particle', () => {
    expect(nameKeys('Vitinha')).toEqual(['vitinha']);
    expect(nameKeys('Virgil van Dijk')).not.toContain('van');
    expect(nameKeys('')).toEqual([]);
  });
});

describe('editDistance / typoAllowance', () => {
  it('counts insertions, deletions, substitutions and adjacent swaps', () => {
    expect(editDistance('mbappe', 'mbappe', 2)).toBe(0);
    expect(editDistance('mbape', 'mbappe', 2)).toBe(1);
    expect(editDistance('mbpape', 'mbappe', 2)).toBe(1);
    expect(editDistance('lewandowksi', 'lewandowski', 2)).toBe(1);
    expect(editDistance('abc', 'xyz', 1)).toBe(2);
    expect(editDistance('a', 'abcdef', 2)).toBe(3);
  });

  it('scales with the name: exact up to 4 letters, 1 typo up to 8, 2 beyond', () => {
    expect([4, 5, 8, 9].map(typoAllowance)).toEqual([0, 1, 1, 2]);
  });
});

describe('nameDistance', () => {
  const mbappe = c('m', 'Kylian Mbappé');
  it('accepts surname, full name, first name, typos and missing accents', () => {
    for (const guess of ['Mbappé', 'mbappe', 'MBAPPE', 'Kylian Mbappe', 'kylian', 'mbape', 'Mbapé']) {
      expect(nameDistance(guess, mbappe)).not.toBeNull();
    }
  });

  it('rejects other names, short fragments and blank input', () => {
    expect(nameDistance('Messi', mbappe)).toBeNull();
    expect(nameDistance('mb', mbappe)).toBeNull();
    expect(nameDistance('   ', mbappe)).toBeNull();
    // Short keys get no typo allowance: "Ruiz" is not "Ruis".
    expect(nameDistance('Ruis', c('r', 'Fabián Ruiz'))).toBeNull();
  });

  it('accepts a compound surname with or without its particle, spaced or not', () => {
    const vvd = c('v', 'Virgil van Dijk');
    for (const guess of ['van Dijk', 'vandijk', 'Dijk', 'Van-Dijk']) expect(nameDistance(guess, vvd)).not.toBeNull();
  });
});

describe('assignGuesses', () => {
  const xi = [c('theo', 'Theo Hernández'), c('lucas', 'Lucas Hernández'), c('km', 'Kylian Mbappé'), c('vit', 'Vitinha')];

  it('credits each target at most once and reports duplicates', () => {
    const result = assignGuesses(['Mbappe', 'mbappé', 'Vitinha'], xi);
    expect(result.results.map((entry) => entry.status)).toEqual(['matched', 'duplicate', 'matched']);
    expect(result.creditedIds).toEqual(['km', 'vit']);
  });

  it('never lets an ambiguous surname block a later, more specific guess (maximum matching)', () => {
    const result = assignGuesses(['Hernandez', 'Theo Hernandez'], xi);
    expect(result.creditedIds).toEqual(['theo', 'lucas']);
    expect(result.results.map((entry) => entry.targetId)).toEqual(['lucas', 'theo']);
  });

  it('credits both namesakes to two plain-surname guesses', () => {
    expect(assignGuesses(['Hernández', 'hernandez'], xi).creditedIds).toEqual(['theo', 'lucas']);
  });

  it('does not credit a starter for a name that better matches a decoy (a substitute)', () => {
    const decoys = [c('dig', 'Lucas Digne')];
    const result = assignGuesses(['Lucas Digne', 'Digne', 'Lucas'], xi, decoys);
    expect(result.results.map((entry) => entry.status)).toEqual(['decoy', 'decoy', 'matched']);
    // A plain "Lucas" matches the starter and the sub equally: the starter gets the benefit of the doubt.
    expect(result.results[2]?.targetId).toBe('lucas');
  });

  it('marks nonsense unknown and is deterministic', () => {
    const guesses = ['zzz', 'Hernandez', 'mbape'];
    const first = assignGuesses(guesses, xi);
    expect(first.results[0]?.status).toBe('unknown');
    expect(assignGuesses(guesses, xi)).toEqual(first);
  });
});
