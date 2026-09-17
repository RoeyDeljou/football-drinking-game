import { describe, expect, it } from 'vitest';

import { createManualClock } from './clock.js';
import { buildGeneralDataset, createGeneralDatasetLoader } from './general-dataset.js';
import { FixtureProvider } from './fixture/fixture-provider.js';
import { createNodeDataSource } from './node-data-source.js';

function buildProvider(): FixtureProvider {
  return new FixtureProvider({ dataSource: createNodeDataSource() });
}

describe('buildGeneralDataset — against the real recorded snapshot', () => {
  it('builds a dataset covering all six competitions with players, stats, leaderboards and guessable facts', async () => {
    const clock = createManualClock(1_700_000_000_000);
    const result = await buildGeneralDataset(buildProvider(), { clock, profileCount: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const dataset = result.value;
    expect(dataset.competitions).toHaveLength(6);
    expect(dataset.players.length).toBeGreaterThan(100);
    expect(dataset.seasonStats.length).toBeGreaterThan(100);
    expect(dataset.builtAt).toBe(new Date(1_700_000_000_000).toISOString());

    // Leaderboards: at least a goals board with real entries, ranked descending.
    const goalsBoard = dataset.leaderboards.find((board) => board.metric === 'GOALS');
    expect(goalsBoard).toBeDefined();
    expect(goalsBoard?.entries.length).toBeGreaterThan(0);
    const values = goalsBoard?.entries.map((entry) => entry.value) ?? [];
    expect(values).toEqual([...values].sort((a, b) => b - a));

    // Guessable stats (G7): every fact has a positive value and a season for season metrics.
    expect(dataset.guessableStats.length).toBeGreaterThan(0);
    const seasonFact = dataset.guessableStats.find((fact) => fact.metric === 'GOALS');
    expect(seasonFact?.season).not.toBeNull();
    const bioFact = dataset.guessableStats.find((fact) => fact.metric === 'AGE');
    expect(bioFact?.season).toBeNull();
  });

  it('lookups by id are populated and consistent with the arrays', async () => {
    const result = await buildGeneralDataset(buildProvider());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dataset = result.value;
    expect(dataset.playersById.size).toBe(dataset.players.length);
    const first = dataset.players[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(dataset.playersById.get(first.id)).toEqual(first);
    expect(dataset.guessableStatsByPlayer.get(first.id)?.length).toBeGreaterThan(0);
  });

  it('quality reports G7 available on season stats alone, independent of market values', async () => {
    const result = await buildGeneralDataset(buildProvider());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quality.hasMarketValues).toBe(false);
    const g7 = result.value.gameAvailability.find((row) => row.gameId === 'G7');
    expect(g7?.available).toBe(true);
  });

  it('restricting to one competition still builds a usable dataset', async () => {
    const result = await buildGeneralDataset(buildProvider(), { competitions: ['PREMIER_LEAGUE'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.competitions).toHaveLength(1);
    expect(result.value.competitions[0]?.code).toBe('PREMIER_LEAGUE');
  });
});

describe('createGeneralDatasetLoader — app-start cache', () => {
  it('load() builds once and shares the result across concurrent callers', async () => {
    const provider = buildProvider();
    const loader = createGeneralDatasetLoader(provider);
    const [a, b, c] = await Promise.all([loader.load(), loader.load(), loader.load()]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(a.value.builtAt).toBe(b.value.builtAt);
    expect(a.value.builtAt).toBe(c.value.builtAt);
  });

  it('peek() is null before the first load and populated after', async () => {
    const loader = createGeneralDatasetLoader(buildProvider());
    expect(loader.peek()).toBeNull();
    await loader.load();
    expect(loader.peek()).not.toBeNull();
  });

  it('invalidate() forces the next load() to rebuild', async () => {
    const loader = createGeneralDatasetLoader(buildProvider());
    const first = await loader.load();
    expect(first.ok).toBe(true);
    loader.invalidate();
    expect(loader.peek()).toBeNull();
    const second = await loader.load();
    expect(second.ok).toBe(true);
  });

  it('a cached load reports fromCache: true', async () => {
    const loader = createGeneralDatasetLoader(buildProvider());
    await loader.load();
    const second = await loader.load();
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.fromCache).toBe(true);
  });
});
