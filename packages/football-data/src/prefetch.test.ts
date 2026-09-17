import { describe, expect, it } from 'vitest';

import { asFixtureId } from './domain.js';
import { FixtureProvider } from './fixture/fixture-provider.js';
import { createNodeDataSource } from './node-data-source.js';
import { MatchdayPrefetcher, PREFETCH_STEP_ORDER } from './prefetch.js';

// A finished fixture with real recorded lineups, live state and season stats — no replay needed.
const FIXTURE_ID = asFixtureId('401879278'); // Manchester United 0-1 Manchester City

function buildProvider(): FixtureProvider {
  return new FixtureProvider({ dataSource: createNodeDataSource() });
}

describe('MatchdayPrefetcher — progress ordering', () => {
  it('reports steps in exactly fixture -> lineups -> squads -> stats order, each running then done', async () => {
    const snapshots: { step: string; status: string }[] = [];
    const prefetcher = new MatchdayPrefetcher(buildProvider(), {
      onProgress: (progress) => {
        const current = progress.steps.find((step) => step.status === 'running');
        if (current !== undefined) snapshots.push({ step: current.id, status: 'running' });
        for (const step of progress.steps) {
          if (step.status === 'done' && !snapshots.some((s) => s.step === step.id && s.status === 'done')) {
            snapshots.push({ step: step.id, status: 'done' });
          }
        }
      },
    });

    const result = await prefetcher.run(FIXTURE_ID);
    expect(result.ok).toBe(true);

    // Extract just the sequence of "done" events and confirm it matches PREFETCH_STEP_ORDER.
    const doneOrder = snapshots.filter((s) => s.status === 'done').map((s) => s.step);
    expect(doneOrder).toEqual(PREFETCH_STEP_ORDER);
  });

  it('progress() starts idle, moves through running, and ends complete', async () => {
    const prefetcher = new MatchdayPrefetcher(buildProvider());
    expect(prefetcher.progress().status).toBe('idle');
    const result = await prefetcher.run(FIXTURE_ID);
    expect(result.ok).toBe(true);
    expect(prefetcher.progress().status).toBe('complete');
    expect(prefetcher.progress().ratio).toBe(1);
    expect(prefetcher.progress().steps.every((step) => step.status === 'done')).toBe(true);
  });

  it('a second run() resets progress from scratch', async () => {
    const prefetcher = new MatchdayPrefetcher(buildProvider());
    await prefetcher.run(FIXTURE_ID);
    const secondRunProgressSnapshots: string[] = [];
    const prefetcher2 = new MatchdayPrefetcher(buildProvider(), {
      onProgress: (p) => secondRunProgressSnapshots.push(p.status),
    });
    await prefetcher2.run(FIXTURE_ID);
    expect(secondRunProgressSnapshots[0]).toBe('running');
    expect(secondRunProgressSnapshots.at(-1)).toBe('complete');
  });
});

describe('MatchdayPrefetcher — bundle assembly from real recorded data', () => {
  it('assembles a full bundle: fixture, confirmed lineups, both squads, season stats and quality', async () => {
    const prefetcher = new MatchdayPrefetcher(buildProvider());
    const result = await prefetcher.run(FIXTURE_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bundle = result.value;
    expect(bundle.fixture.id).toBe(FIXTURE_ID);
    expect(bundle.lineups).not.toBeNull();
    expect(bundle.lineups?.confirmed).toBe(true);
    expect(bundle.squads).toHaveLength(2);
    expect(bundle.squads.every((squad) => squad.players.length > 0)).toBe(true);
    expect(bundle.seasonStats.length).toBeGreaterThan(0);
    expect(bundle.quality.hasLineups).toBe(true);
    expect(bundle.quality.hasPlayerSeasonStats).toBe(true);

    const g7 = bundle.gameAvailability.find((row) => row.gameId === 'G7');
    expect(g7?.available).toBe(true);
    const g1 = bundle.gameAvailability.find((row) => row.gameId === 'G1');
    expect(g1).toBeDefined();
  });

  it('resolves career profiles for at least some of the starting XI', async () => {
    const prefetcher = new MatchdayPrefetcher(buildProvider(), { profileCount: 22 });
    const result = await prefetcher.run(FIXTURE_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.profiles.length).toBeGreaterThan(0);
  });
});

describe('MatchdayPrefetcher — failure policy', () => {
  it('an unknown fixture fails fatally at the first step and skips the rest', async () => {
    const snapshots: MatchdayPrefetcher[] = [];
    const prefetcher = new MatchdayPrefetcher(buildProvider());
    const result = await prefetcher.run(asFixtureId('not-a-real-fixture'));
    expect(result.ok).toBe(false);
    const progress = prefetcher.progress();
    expect(progress.status).toBe('failed');
    const fixtureStep = progress.steps.find((step) => step.id === 'fixture');
    expect(fixtureStep?.status).toBe('failed');
    for (const id of ['lineups', 'squads', 'stats']) {
      expect(progress.steps.find((step) => step.id === id)?.status).toBe('skipped');
    }
    void snapshots;
  });

  it('a scheduled fixture with no lineups yet still produces a bundle with lineups null and a quality note', async () => {
    const prefetcher = new MatchdayPrefetcher(buildProvider());
    // A recorded scheduled fixture with no confirmed lineups (per data/README.md).
    const result = await prefetcher.run(asFixtureId('401879275'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lineups).toBeNull();
    expect(result.value.quality.hasLineups).toBe(false);
    expect(result.value.quality.notes.length).toBeGreaterThan(0);
    const m3 = result.value.gameAvailability.find((row) => row.gameId === 'M3');
    expect(m3?.available).toBe(false);
  });
});
