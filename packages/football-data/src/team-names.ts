/**
 * Conservative club-name matching across sources ("Manchester City F.C." on Wikidata = "Manchester City" on
 * ESPN). Used to attach real team ids to career entries. Only exact matches after removing accents, punctuation
 * and legal-form tokens count; anything looser would link careers to the wrong club.
 */

import type { Team, TeamId } from './domain.js';

/** Tokens that describe a club's legal form or sport rather than identify it. */
const NOISE_TOKENS = new Set([
  'fc',
  'cf',
  'afc',
  'ac',
  'as',
  'ss',
  'ssc',
  'sc',
  'sv',
  'rc',
  'ogc',
  'cfc',
  'club',
  'football',
  'futbol',
  'calcio',
  'de',
  'the',
]);

export function teamNameKey(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      // Collapse dotted abbreviations ("F.C.", "A.C.", "U.C.") to one token before general punctuation
      // splitting, so "Manchester City F.C." and "Manchester City" fold to the same key. Without this, the
      // dots split "F.C." into the single letters "f" and "c", which NOISE_TOKENS (built from whole words like
      // "fc") never matches.
      .replace(/\./g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((token) => token.length > 0 && !NOISE_TOKENS.has(token))
      .join(' ')
  );
}

export interface TeamNameResolver {
  add(team: Pick<Team, 'id' | 'name' | 'shortName'>): void;
  resolve(name: string): TeamId | null;
}

/** A resolver that learns teams as they are seen. A key claimed by two different teams resolves to nothing. */
export function createTeamNameResolver(initial: readonly Pick<Team, 'id' | 'name' | 'shortName'>[] = []): TeamNameResolver {
  const byKey = new Map<string, TeamId | null>();
  const add = (team: Pick<Team, 'id' | 'name' | 'shortName'>): void => {
    const key = teamNameKey(team.name);
    if (key.length === 0) return;
    const existing = byKey.get(key);
    if (existing === undefined) byKey.set(key, team.id);
    else if (existing !== team.id) byKey.set(key, null);
  };
  for (const team of initial) add(team);
  return {
    add,
    resolve: (name) => {
      const key = teamNameKey(name);
      return key.length === 0 ? null : (byKey.get(key) ?? null);
    },
  };
}
