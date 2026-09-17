/**
 * Integrity checks on the shipped recorded snapshot itself (`data/`), as opposed to the provider that serves it.
 *
 * These exist because a provider can pass every unit test while the *data it serves* is still wrong — that is
 * exactly how the stale `careers.json` (B4) and the mislabeled partial timeline (B1) shipped in the first place.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultDataDir } from './node-data-source.js';
import { createTeamNameResolver } from './team-names.js';
import type { Team } from './domain.js';

interface CompetitionIndexEntry {
  readonly code: string;
  readonly file: string;
}

interface CompetitionFile {
  readonly teams: readonly Team[];
}

interface CareerEntryRow {
  readonly teamId: string | null;
  readonly teamName: string;
}

interface CareersFile {
  readonly careers: readonly { readonly playerId: string; readonly entries: readonly CareerEntryRow[] }[];
}

function readJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(defaultDataDir(), ...segments), 'utf8')) as T;
}

describe('data integrity — careers.json is linked with the current (fixed) team-name resolver (B4)', () => {
  it('no career entry whose club name resolves against a real recorded team is left with teamId: null', () => {
    const index = readJson<{ competitions: readonly CompetitionIndexEntry[] }>('index.json');
    const resolver = createTeamNameResolver();
    for (const entry of index.competitions) {
      const competition = readJson<CompetitionFile>(entry.file);
      for (const team of competition.teams) resolver.add(team);
    }

    const careers = readJson<CareersFile>('careers.json');
    const unlinkedButResolvable: string[] = [];
    for (const row of careers.careers) {
      for (const entry of row.entries) {
        if (entry.teamId !== null) continue;
        const resolved = resolver.resolve(entry.teamName);
        if (resolved !== null) unlinkedButResolvable.push(`${row.playerId}: ${entry.teamName} -> ${resolved}`);
      }
    }

    expect(unlinkedButResolvable).toEqual([]);
  });

  it('a genuine real-world example is actually linked: a Manchester United spell carries team id 360', () => {
    const careers = readJson<CareersFile>('careers.json');
    const manUtdEntries = careers.careers.flatMap((row) =>
      row.entries.filter((entry) => entry.teamName.includes('Manchester United')),
    );
    expect(manUtdEntries.length).toBeGreaterThan(0);
    expect(manUtdEntries.every((entry) => entry.teamId === '360')).toBe(true);
  });
});

describe('data integrity — the replayable timeline is genuinely complete (B1)', () => {
  it('index.json names exactly the one real, complete timeline, and no orphaned timeline file is shipped', () => {
    const index = readJson<{ timelines: readonly { fixtureId: string; file: string }[] }>('index.json');
    expect(index.timelines).toEqual([{ fixtureId: '401915445', file: 'timelines/401915445.json' }]);
  });

  it('the timeline file itself contains a FULL_TIME event and events well past minute 70', () => {
    const timeline = readJson<{ events: readonly { type: string; minute: number }[] }>('timelines/401915445.json');
    expect(timeline.events.some((event) => event.type === 'FULL_TIME')).toBe(true);
    expect(timeline.events.filter((event) => event.minute > 70).length).toBeGreaterThan(0);
  });

  it("the provenance description does not claim completeness it doesn't have (no stale 'as it stood' wording)", () => {
    const timeline = readJson<{ provenance: { description: string } }>('timelines/401915445.json');
    expect(timeline.provenance.description.toLowerCase()).toContain('full time');
    expect(timeline.provenance.description.toLowerCase()).not.toContain('as it stood');
  });
});
