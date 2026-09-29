import { describe, expect, it } from 'vitest';
import { competitionMonogram } from './competitionMonogram';

describe('competitionMonogram', () => {
  it('uses the initials of the first two words', () => {
    expect(competitionMonogram('Premier League')).toBe('PL');
    expect(competitionMonogram('Champions League')).toBe('CL');
    expect(competitionMonogram('Ligue 1')).toBe('L1');
    expect(competitionMonogram('National Teams')).toBe('NT');
  });

  it('uses the first two letters of a one-word name', () => {
    expect(competitionMonogram('Bundesliga')).toBe('BU');
  });

  it('never returns an empty mark', () => {
    expect(competitionMonogram('   ')).toBe('?');
  });
});
