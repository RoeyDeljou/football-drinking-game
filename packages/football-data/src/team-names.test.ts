import { describe, expect, it } from 'vitest';

import { asTeamId } from './domain.js';
import { createTeamNameResolver, teamNameKey } from './team-names.js';

describe('teamNameKey', () => {
  it('folds a dotted legal-form suffix to the same key as the bare club name (real Wikidata vs ESPN spelling)', () => {
    expect(teamNameKey('Manchester City F.C.')).toBe(teamNameKey('Manchester City'));
    expect(teamNameKey('Paris Saint-Germain FC')).toBe(teamNameKey('Paris Saint-Germain'));
    expect(teamNameKey('AC Milan')).toBe(teamNameKey('A.C. Milan'));
  });

  it('is accent-insensitive', () => {
    expect(teamNameKey('Atlético Madrid')).toBe(teamNameKey('Atletico Madrid'));
  });

  it('distinguishes genuinely different clubs', () => {
    expect(teamNameKey('Manchester City')).not.toBe(teamNameKey('Manchester United'));
  });
});

describe('createTeamNameResolver', () => {
  it('resolves a Wikidata-style club label to the id of the matching known team', () => {
    const resolver = createTeamNameResolver();
    resolver.add({ id: asTeamId('382'), name: 'Manchester City', shortName: 'MCI' });
    expect(resolver.resolve('Manchester City F.C.')).toBe('382');
  });

  it('returns null for a name it has never seen', () => {
    const resolver = createTeamNameResolver();
    expect(resolver.resolve('Nonexistent FC')).toBeNull();
  });

  it('a key claimed by two different team ids resolves to nothing, never a guess', () => {
    const resolver = createTeamNameResolver();
    resolver.add({ id: asTeamId('a'), name: 'Real FC', shortName: 'RFC' });
    resolver.add({ id: asTeamId('b'), name: 'Real FC', shortName: 'RFC' });
    expect(resolver.resolve('Real FC')).toBeNull();
  });

  it('re-adding the same team id under the same key is not treated as a collision', () => {
    const resolver = createTeamNameResolver();
    resolver.add({ id: asTeamId('382'), name: 'Manchester City', shortName: 'MCI' });
    resolver.add({ id: asTeamId('382'), name: 'Manchester City', shortName: 'MCI' });
    expect(resolver.resolve('Manchester City')).toBe('382');
  });
});
