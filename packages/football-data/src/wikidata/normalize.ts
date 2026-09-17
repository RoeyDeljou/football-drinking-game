/**
 * Wikidata SPARQL results → player matches and `CareerEntry[]`. Pure functions, tested against recorded responses.
 *
 * Matching policy — **never a guess**:
 * - A player is only matched when exactly one footballer born on the same date has a name that matches.
 * - "Matches" means the accent-folded, punctuation-free name equals one of the entity's labels or aliases,
 *   ignoring word order (`Lee Kang-In` = `Kang-in Lee`). If that finds nobody, a stricter-than-it-sounds fallback
 *   accepts a single candidate whose name tokens contain all of ours or vice versa (`Cristian Romero` ⊂
 *   `Cristian Gabriel Romero`). Two or more candidates at either step → `ambiguous`, zero → `no-match`.
 */

import { seasonLabel } from '../competitions.js';
import type { CareerEntry, TeamId } from '../domain.js';
import type { SparqlResults } from './sparql.js';
import { entityIdFromUri } from './sparql.js';

export type CareerMatchStatus = 'matched' | 'no-match' | 'ambiguous' | 'no-date-of-birth';

export interface WikidataCandidate {
  readonly entityId: string;
  readonly dateOfBirth: string;
  readonly names: readonly string[];
}

export function foldPersonName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/ø/g, 'o')
    .replace(/Ø/g, 'O')
    .replace(/ß/g, 'ss')
    .replace(/[łŁ]/g, 'l')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenKey(value: string): string {
  return foldPersonName(value).split(' ').filter(Boolean).sort().join(' ');
}

function tokens(value: string): Set<string> {
  return new Set(foldPersonName(value).split(' ').filter(Boolean));
}

/** Group the date-of-birth query's rows into one candidate per entity. */
export function parseCandidates(results: SparqlResults): readonly WikidataCandidate[] {
  const byEntity = new Map<string, { dateOfBirth: string; names: Set<string> }>();
  for (const row of results.results.bindings) {
    const uri = row['player']?.value;
    const dob = row['dob']?.value;
    if (uri === undefined || dob === undefined) continue;
    const entityId = entityIdFromUri(uri);
    if (entityId === null) continue;
    const entry = byEntity.get(entityId) ?? { dateOfBirth: dob.slice(0, 10), names: new Set<string>() };
    for (const key of ['label', 'alt']) {
      const name = row[key]?.value;
      if (name !== undefined && name.length > 0) entry.names.add(name);
    }
    byEntity.set(entityId, entry);
  }
  return [...byEntity.entries()].map(([entityId, entry]) => ({
    entityId,
    dateOfBirth: entry.dateOfBirth,
    names: [...entry.names],
  }));
}

export interface MatchOutcome {
  readonly status: CareerMatchStatus;
  readonly entityId: string | null;
  readonly note: string;
}

export function matchCandidate(
  names: readonly string[],
  dateOfBirth: string | null,
  candidates: readonly WikidataCandidate[],
): MatchOutcome {
  const display = names[0] ?? 'unknown player';
  if (dateOfBirth === null) {
    return { status: 'no-date-of-birth', entityId: null, note: `${display}: no date of birth, so no Wikidata lookup.` };
  }
  const sameDay = candidates.filter((candidate) => candidate.dateOfBirth === dateOfBirth);
  const ourKeys = new Set(names.filter((name) => name.length > 0).map(tokenKey));

  const exact = sameDay.filter((candidate) => candidate.names.some((name) => ourKeys.has(tokenKey(name))));
  if (exact.length === 1 && exact[0] !== undefined) {
    return { status: 'matched', entityId: exact[0].entityId, note: `${display}: matched ${exact[0].entityId}.` };
  }
  if (exact.length > 1) {
    return {
      status: 'ambiguous',
      entityId: null,
      note: `${display}: ${String(exact.length)} Wikidata footballers share this name and birth date; not guessing.`,
    };
  }

  const ourTokenSets = names.filter((name) => name.length > 0).map(tokens);
  const partial = sameDay.filter((candidate) =>
    candidate.names.some((name) => {
      const theirs = tokens(name);
      return ourTokenSets.some(
        (ours) =>
          ours.size >= 2 &&
          theirs.size >= 2 &&
          ([...ours].every((token) => theirs.has(token)) || [...theirs].every((token) => ours.has(token))),
      );
    }),
  );
  if (partial.length === 1 && partial[0] !== undefined) {
    return {
      status: 'matched',
      entityId: partial[0].entityId,
      note: `${display}: matched ${partial[0].entityId} on name tokens and birth date.`,
    };
  }
  if (partial.length > 1) {
    return {
      status: 'ambiguous',
      entityId: null,
      note: `${display}: ${String(partial.length)} partial name matches on this birth date; not guessing.`,
    };
  }
  return { status: 'no-match', entityId: null, note: `${display}: no Wikidata footballer matches name and birth date.` };
}

/** Wikidata items that mark a national (senior or youth) representative team. */
const NATIONAL_TEAM_TYPES = new Set(['Q6979593', 'Q135408445', 'Q23901123', 'Q23904672', 'Q1194951', 'Q23847779']);

const YOUTH_PATTERN = /\b(under[- ]?\d{2}|u-?\d{2}|youth|olympic|junior|amateur)\b/i;

export interface ParsedCareer {
  readonly entityId: string;
  readonly career: readonly CareerEntry[];
  readonly seniorNationalTeam: string | null;
  readonly excludedNationalSpells: number;
}

/** `2014-07-01T00:00:00Z` → `2014/15`; a January date belongs to the season that started the previous year. */
export function seasonFromWikidataDate(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^(\d{4})-(\d{2})/.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  return seasonLabel(month >= 7 ? year : year - 1);
}

function intOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Group career rows by player, drop national and youth representative teams from the club career (keeping the
 * senior national team as a separate label), and order the spells chronologically.
 */
export function parseCareers(
  results: SparqlResults,
  resolveTeamId: (teamName: string) => TeamId | null = () => null,
): ReadonlyMap<string, ParsedCareer> {
  const rows = new Map<
    string,
    { spells: (CareerEntry & { sortKey: string; statement: string })[]; national: string | null; excluded: number }
  >();

  for (const row of results.results.bindings) {
    const playerUri = row['player']?.value;
    const statement = row['st']?.value;
    const teamName = row['teamLabel']?.value;
    if (playerUri === undefined || statement === undefined || teamName === undefined) continue;
    const entityId = entityIdFromUri(playerUri);
    if (entityId === null) continue;
    const bucket = rows.get(entityId) ?? { spells: [], national: null, excluded: 0 };
    rows.set(entityId, bucket);
    if (bucket.spells.some((spell) => spell.statement === statement)) continue;

    const types = (row['types']?.value ?? '')
      .split(' ')
      .map((uri) => entityIdFromUri(uri))
      .filter((id): id is string => id !== null);
    const nationalByType = types.some((type) => NATIONAL_TEAM_TYPES.has(type));
    const nationalByName = /\bnational\b/i.test(teamName);
    if (nationalByType || nationalByName) {
      if (!YOUTH_PATTERN.test(teamName) && bucket.national === null) bucket.national = teamName;
      bucket.excluded += 1;
      continue;
    }
    // A label that is still a bare Q-id means the team has no usable name; it cannot be played with.
    if (/^Q\d+$/.test(teamName)) continue;

    // `somevalue` qualifiers arrive as blank-node URIs rather than dates; treat them as unknown.
    const startRaw = row['start']?.type === 'literal' ? row['start'].value : undefined;
    const endRaw = row['end']?.type === 'literal' ? row['end'].value : undefined;
    bucket.spells.push({
      statement,
      sortKey: `${startRaw ?? '9999'}|${endRaw ?? '9999'}`,
      teamId: resolveTeamId(teamName),
      teamName,
      fromSeason: seasonFromWikidataDate(startRaw) ?? 'unknown',
      toSeason: seasonFromWikidataDate(endRaw),
      appearances: intOrNull(row['matches']?.value),
      goals: intOrNull(row['goals']?.value),
    });
  }

  const parsed = new Map<string, ParsedCareer>();
  for (const [entityId, bucket] of rows) {
    const career = bucket.spells
      .sort((left, right) => left.sortKey.localeCompare(right.sortKey))
      .map(({ teamId, teamName, fromSeason, toSeason, appearances, goals }) => ({
        teamId,
        teamName,
        fromSeason,
        toSeason,
        appearances,
        goals,
      }));
    parsed.set(entityId, {
      entityId,
      career,
      seniorNationalTeam: bucket.national,
      excludedNationalSpells: bucket.excluded,
    });
  }
  return parsed;
}
