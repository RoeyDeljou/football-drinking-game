/**
 * The Wikidata adapter contract test: real recorded SPARQL results in, matched players and careers out.
 *
 * Runs entirely from `data/raw-samples/wikidata/` — no network. Both samples are genuine SPARQL Query Service
 * responses fetched on 2026-09-16 (see `data/raw-samples/wikidata/README.md`).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultDataDir } from '../node-data-source.js';
import { asTeamId } from '../domain.js';
import {
  foldPersonName,
  matchCandidate,
  parseCandidates,
  parseCareers,
  seasonFromWikidataDate,
} from './normalize.js';
import { sparqlResultsSchema } from './sparql.js';

function loadSample(name: 'candidates-by-birthdate' | 'careers'): unknown {
  return JSON.parse(readFileSync(join(defaultDataDir(), 'raw-samples', 'wikidata', `${name}.json`), 'utf8'));
}

describe('foldPersonName', () => {
  it('is accent- and punctuation-insensitive and order-preserving as text', () => {
    expect(foldPersonName('Kylian Mbappé')).toBe('kylian mbappe');
    expect(foldPersonName("N'Golo Kanté")).toBe('n golo kante');
  });
});

describe('seasonFromWikidataDate', () => {
  it('assigns a January date to the season that started the previous July', () => {
    expect(seasonFromWikidataDate('2015-01-01T00:00:00Z')).toBe('2014/15');
  });

  it('assigns a September date to the season starting that year', () => {
    expect(seasonFromWikidataDate('2025-09-01T00:00:00Z')).toBe('2025/26');
  });

  it('returns null for an absent value', () => {
    expect(seasonFromWikidataDate(undefined)).toBeNull();
  });
});

describe('parseCandidates — real candidates-by-birth-date query result (1,435 bindings)', () => {
  const parsed = sparqlResultsSchema.safeParse(loadSample('candidates-by-birthdate'));

  it('parses against the results schema', () => {
    expect(parsed.success).toBe(true);
  });

  it('groups the real multi-language label rows into one candidate per entity', () => {
    if (!parsed.success) return;
    const candidates = parseCandidates(parsed.data);
    // 1,435 rows collapse to far fewer entities once the per-language label repeats are deduplicated.
    expect(candidates.length).toBeGreaterThan(200);
    expect(candidates.length).toBeLessThan(1435);
    const widmer = candidates.find((c) => c.entityId === 'Q114386');
    expect(widmer).toBeDefined();
    if (widmer === undefined) return;
    expect(widmer.dateOfBirth).toBe('1993-03-05');
    // Real Wikidata rows repeat the same alias across languages; the label/alt set is deduplicated.
    expect(widmer.names).toContain('Silvan Widmer');
    expect(widmer.names).toContain('Silvan Dominic Widmer');
  });

  it('this real batch of birth dates contains a genuine name collision (many footballers share a birthday)', () => {
    if (!parsed.success) return;
    const candidates = parseCandidates(parsed.data);
    const sameDay = candidates.filter((c) => c.dateOfBirth === '1993-03-05');
    expect(sameDay.length).toBeGreaterThan(10);
  });
});

describe('matchCandidate — never a guess', () => {
  const parsed = sparqlResultsSchema.safeParse(loadSample('candidates-by-birthdate'));

  it('matches a real player by exact name + date of birth', () => {
    if (!parsed.success) return;
    const candidates = parseCandidates(parsed.data);
    const outcome = matchCandidate(['Silvan Widmer'], '1993-03-05', candidates);
    expect(outcome.status).toBe('matched');
    expect(outcome.entityId).toBe('Q114386');
  });

  it('is ambiguous rather than guessing when several candidates share the exact name and date', () => {
    const candidates = [
      { entityId: 'Q1', dateOfBirth: '2000-01-01', names: ['John Smith'] },
      { entityId: 'Q2', dateOfBirth: '2000-01-01', names: ['John Smith'] },
    ];
    const outcome = matchCandidate(['John Smith'], '2000-01-01', candidates);
    expect(outcome.status).toBe('ambiguous');
    expect(outcome.entityId).toBeNull();
  });

  it('reports no-match rather than a low-confidence guess', () => {
    const outcome = matchCandidate(['Nobody Real'], '1993-03-05', []);
    expect(outcome.status).toBe('no-match');
    expect(outcome.entityId).toBeNull();
  });

  it('reports no-date-of-birth without ever attempting a name-only match', () => {
    const outcome = matchCandidate(['Silvan Widmer'], null, []);
    expect(outcome.status).toBe('no-date-of-birth');
  });

  it('matches on name tokens (word order / diacritics) when the exact label differs', () => {
    if (!parsed.success) return;
    const candidates = parseCandidates(parsed.data);
    // "Silvan Dominic Widmer" is the alt label; querying with a reordered/partial form should still resolve
    // uniquely to the same entity via the token-based fallback, since only one Q114386 exists on this date.
    const outcome = matchCandidate(['Widmer Silvan'], '1993-03-05', candidates);
    expect(outcome.entityId).toBe('Q114386');
  });
});

describe('parseCareers — real career query result for Gianluigi Donnarumma (Q20830808) and others', () => {
  const parsed = sparqlResultsSchema.safeParse(loadSample('careers'));

  it('parses against the results schema', () => {
    expect(parsed.success).toBe(true);
  });

  it('covers 11 real players in this batch', () => {
    if (!parsed.success) return;
    const careers = parseCareers(parsed.data);
    expect(careers.size).toBe(11);
  });

  it('rebuilds a real club career in chronological order: AC Milan -> PSG -> Manchester City', () => {
    if (!parsed.success) return;
    const careers = parseCareers(parsed.data);
    const donnarumma = careers.get('Q20830808');
    expect(donnarumma).toBeDefined();
    if (donnarumma === undefined) return;
    expect(donnarumma.career.map((entry) => entry.teamName)).toEqual([
      'AC Milan',
      'Paris Saint-Germain FC',
      'Manchester City F.C.',
    ]);
    expect(donnarumma.career[0]).toMatchObject({ fromSeason: '2014/15', toSeason: '2020/21', appearances: 215, goals: 0 });
    expect(donnarumma.career[2]?.toSeason).toBeNull(); // still there — no end date recorded
  });

  it('reports the senior national team separately and never as a club', () => {
    if (!parsed.success) return;
    const careers = parseCareers(parsed.data);
    const donnarumma = careers.get('Q20830808');
    expect(donnarumma?.seniorNationalTeam).toBe("Italy men's national association football team");
    expect(donnarumma?.career.some((entry) => entry.teamName.includes('Italy'))).toBe(false);
  });

  it('excludes youth national teams entirely (not counted as the senior team either)', () => {
    if (!parsed.success) return;
    const careers = parseCareers(parsed.data);
    const donnarumma = careers.get('Q20830808');
    expect(donnarumma?.excludedNationalSpells).toBeGreaterThanOrEqual(4); // senior + 3 youth age groups (at least)
    expect(donnarumma?.seniorNationalTeam).not.toContain('under');
  });

  it('links a career club to a real team id when a resolver is supplied', () => {
    if (!parsed.success) return;
    const careers = parseCareers(parsed.data, (name) => (name === 'Manchester City F.C.' ? asTeamId('382') : null));
    const donnarumma = careers.get('Q20830808');
    const manCity = donnarumma?.career.find((entry) => entry.teamName === 'Manchester City F.C.');
    expect(manCity?.teamId).toBe('382');
    const acMilan = donnarumma?.career.find((entry) => entry.teamName === 'AC Milan');
    expect(acMilan?.teamId).toBeNull(); // resolver has no mapping for this club
  });
});
