import { beforeAll, describe, expect, it } from 'vitest';

import { createManualClock } from './clock.js';
import { FixtureProvider } from './fixture/fixture-provider.js';
import type { GeneralDataset } from './general-dataset.js';
import { buildGeneralDataset, createGeneralDatasetLoader, REFRESH_REJECTED_PREFIX } from './general-dataset.js';
import type { GeneralDatasetSnapshot, GeneralDatasetStore } from './general-dataset-snapshot.js';
import { hydrateGeneralDataset, isSnapshotFresh, serializeGeneralDataset } from './general-dataset-snapshot.js';
import { createNodeDataSource } from './node-data-source.js';
import type { FootballDataProvider } from './provider.js';
import { fail } from './result.js';

const HOUR = 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

function buildProvider(): FixtureProvider {
  return new FixtureProvider({ dataSource: createNodeDataSource() });
}

/** Counts every provider call so "did not touch the provider" is provable. */
function countingProvider(inner: FootballDataProvider): { provider: FootballDataProvider; calls: () => number } {
  let calls = 0;
  const provider = new Proxy(inner, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls += 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { provider, calls: () => calls };
}

function memoryStore(initial?: { snapshot: unknown; savedAt: string }): GeneralDatasetStore & {
  current: { snapshot: unknown; savedAt: string } | null;
  reads: number;
  writes: number;
} {
  const store = {
    current: initial ?? null,
    reads: 0,
    writes: 0,
    read(): Promise<{ snapshot: unknown; savedAt: string } | null> {
      store.reads += 1;
      return Promise.resolve(store.current);
    },
    write(snapshot: GeneralDatasetSnapshot): Promise<void> {
      store.writes += 1;
      store.current = { snapshot: JSON.parse(JSON.stringify(snapshot)) as unknown, savedAt: 'now' };
      return Promise.resolve();
    },
  };
  return store;
}

let base: GeneralDataset;
let baseSnapshotJson: unknown;

beforeAll(async () => {
  const result = await buildGeneralDataset(buildProvider(), { clock: createManualClock(T0), profileCount: 20 });
  if (!result.ok) throw new Error('fixture build failed');
  base = result.value;
  baseSnapshotJson = JSON.parse(JSON.stringify(serializeGeneralDataset(base))) as unknown;
});

describe('snapshot serialize / hydrate', () => {
  it('round-trips through JSON with every derived field recomputed identically', () => {
    const hydrated = hydrateGeneralDataset(baseSnapshotJson);
    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) return;
    expect(hydrated.value).toEqual(base);
    expect(hydrated.value.playersById.size).toBe(base.players.length);
    expect(hydrated.value.gameAvailability).toEqual(base.gameAvailability);
    expect(hydrated.value.statsByPlayer).toEqual(base.statsByPlayer);
    expect(hydrated.value.profilesByPlayer).toEqual(base.profilesByPlayer);
    expect(hydrated.value.guessableStatsByPlayer).toEqual(base.guessableStatsByPlayer);
  });

  it('the snapshot contains no Maps and carries schemaVersion 1', () => {
    const snapshot = serializeGeneralDataset(base);
    expect(snapshot.schemaVersion).toBe(1);
    expect(Object.values(snapshot).some((value) => value instanceof Map)).toBe(false);
  });

  it('rejects an unknown schemaVersion, corrupt payloads and non-objects without throwing', () => {
    const cases: unknown[] = [
      { ...(baseSnapshotJson as object), schemaVersion: 2 },
      { ...(baseSnapshotJson as object), players: 'nope' },
      { ...(baseSnapshotJson as object), builtAt: 'not a date' },
      { schemaVersion: 1 },
      null,
      'text',
      42,
      undefined,
    ];
    for (const input of cases) {
      const result = hydrateGeneralDataset(input);
      expect(result.ok).toBe(false);
    }
  });

  it('isSnapshotFresh honours the injected clock and rejects garbage timestamps', () => {
    const clock = createManualClock(T0 + 2 * HOUR);
    const builtAt = new Date(T0).toISOString();
    expect(isSnapshotFresh(builtAt, 3 * HOUR, clock)).toBe(true);
    expect(isSnapshotFresh(builtAt, HOUR, clock)).toBe(false);
    expect(isSnapshotFresh('garbage', HOUR, clock)).toBe(false);
  });
});

describe('createGeneralDatasetLoader with a store', () => {
  it('serves a fresh stored snapshot without touching the provider', async () => {
    const store = memoryStore({ snapshot: baseSnapshotJson, savedAt: 's' });
    const { provider, calls } = countingProvider(buildProvider());
    const loader = createGeneralDatasetLoader(provider, { store, clock: createManualClock(T0 + HOUR) });
    const result = await loader.load();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.players.length).toBe(base.players.length);
    expect(calls()).toBe(0);
    expect(store.writes).toBe(0);
  });

  it('serves a stale snapshot instantly, runs exactly one background refresh, and updates the store', async () => {
    const store = memoryStore({ snapshot: baseSnapshotJson, savedAt: 's' });
    const { provider, calls } = countingProvider(buildProvider());
    const clock = createManualClock(T0 + 13 * HOUR);
    const loader = createGeneralDatasetLoader(provider, { store, clock, profileCount: 20 });

    const [a, b] = await Promise.all([loader.load(), loader.load()]);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok) expect(a.value.builtAt).toBe(base.builtAt); // the stale snapshot was served, not the rebuild

    await loader.refresh(); // joins the in-flight background refresh
    expect(store.writes).toBe(1);
    const stored = store.current?.snapshot as GeneralDatasetSnapshot;
    expect(stored.builtAt).toBe(new Date(T0 + 13 * HOUR).toISOString());
    expect(loader.peek()?.builtAt).toBe(stored.builtAt);
    expect(calls()).toBeGreaterThan(0);
    // still exactly one build: a second pass of load() adds no provider calls
    const before = calls();
    await loader.load();
    expect(calls()).toBe(before);
  });

  it('a failed refresh leaves the store and the served dataset unchanged and never rejects', async () => {
    const store = memoryStore({ snapshot: baseSnapshotJson, savedAt: 's' });
    const failing = buildProvider();
    failing.listCompetitions = () => Promise.resolve(fail('NETWORK', 'boom'));
    const warnings: string[] = [];
    const loader = createGeneralDatasetLoader(failing, {
      store,
      clock: createManualClock(T0 + 13 * HOUR),
      onWarning: (message) => warnings.push(message),
    });
    const served = await loader.load();
    expect(served.ok).toBe(true);
    const refreshed = await loader.refresh();
    expect(refreshed.ok).toBe(false);
    expect(store.writes).toBe(0);
    expect(store.current?.snapshot).toBe(baseSnapshotJson);
    expect(loader.peek()?.builtAt).toBe(base.builtAt);
    expect(warnings.some((message) => message.includes('refresh failed'))).toBe(true);
  });

  it('a worse refresh (far fewer players) is rejected', async () => {
    const store = memoryStore({ snapshot: baseSnapshotJson, savedAt: 's' });
    const warnings: string[] = [];
    // One competition out of six is also a partial build; the player-count rule is exercised separately below.
    const loader = createGeneralDatasetLoader(buildProvider(), {
      store,
      clock: createManualClock(T0 + 13 * HOUR),
      competitions: ['PREMIER_LEAGUE'],
      onWarning: (message) => warnings.push(message),
    });
    await loader.load();
    const refreshed = await loader.refresh();
    expect(refreshed.ok).toBe(false);
    expect(store.writes).toBe(0);
    expect(loader.peek()?.players.length).toBe(base.players.length);
    expect(warnings.some((message) => message.includes('rejected'))).toBe(true);
  });

  it('a refresh with under 80% of the held players is rejected even when not partial', async () => {
    const inflated = JSON.parse(JSON.stringify(baseSnapshotJson)) as GeneralDatasetSnapshot & { players: unknown[] };
    const template = inflated.players[0];
    const padding = Array.from({ length: base.players.length * 2 }, (_, index) => ({
      ...(template as object),
      id: `padding-${index}`,
    }));
    const bigger = { ...inflated, players: [...inflated.players, ...padding] };
    const store = memoryStore({ snapshot: bigger, savedAt: 's' });
    const loader = createGeneralDatasetLoader(buildProvider(), { store, clock: createManualClock(T0 + 13 * HOUR) });
    await loader.load();
    const refreshed = await loader.refresh();
    expect(refreshed.ok).toBe(false);
    expect(store.writes).toBe(0);
  });

  it('an empty store falls back to the live build and writes the result', async () => {
    const store = memoryStore();
    const loader = createGeneralDatasetLoader(buildProvider(), { store, clock: createManualClock(T0), profileCount: 20 });
    const result = await loader.load();
    expect(result.ok).toBe(true);
    await loader.flushWrites(); // the store write is fire-and-forget
    expect(store.writes).toBe(1);
    expect(hydrateGeneralDataset(store.current?.snapshot).ok).toBe(true);
  });

  it('a corrupt stored snapshot falls back to a live build and overwrites it', async () => {
    const store = memoryStore({ snapshot: { schemaVersion: 99 }, savedAt: 's' });
    const warnings: string[] = [];
    const loader = createGeneralDatasetLoader(buildProvider(), { store, onWarning: (m) => warnings.push(m) });
    expect((await loader.load()).ok).toBe(true);
    await loader.flushWrites();
    expect(store.writes).toBe(1);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('store.read throwing serves the live build but never writes it (the store may hold a good snapshot)', async () => {
    const warnings: string[] = [];
    let writes = 0;
    const store: GeneralDatasetStore = {
      read: () => Promise.reject(new Error('db down')),
      write: () => {
        writes += 1;
        return Promise.resolve();
      },
    };
    const loader = createGeneralDatasetLoader(buildProvider(), { store, onWarning: (m) => warnings.push(m) });
    const result = await loader.load();
    expect(result.ok).toBe(true);
    expect(loader.peek()).not.toBeNull();
    await loader.flushWrites();
    expect(writes).toBe(0);
    expect(warnings.some((m) => m.includes('read'))).toBe(true);
  });

  it('store.write throwing (read succeeded, empty store) is swallowed and reported', async () => {
    const warnings: string[] = [];
    const store: GeneralDatasetStore = {
      read: () => Promise.resolve(null),
      write: () => Promise.reject(new Error('db still down')),
    };
    const loader = createGeneralDatasetLoader(buildProvider(), { store, onWarning: (m) => warnings.push(m) });
    expect((await loader.load()).ok).toBe(true);
    await loader.flushWrites();
    expect(warnings.some((m) => m.includes('write'))).toBe(true);
  });

  it('concurrent load() calls share one store read and one build', async () => {
    const store = memoryStore();
    const { provider, calls } = countingProvider(buildProvider());
    const loader = createGeneralDatasetLoader(provider, { store, profileCount: 5 });
    await Promise.all([loader.load(), loader.load(), loader.load()]);
    await loader.flushWrites();
    expect(store.reads).toBe(1);
    expect(store.writes).toBe(1);
    const single = countingProvider(buildProvider());
    await buildGeneralDataset(single.provider, { profileCount: 5 });
    expect(calls()).toBe(single.calls());
  });

  it('refresh() forces a build and writes the store even when a fresh snapshot is cached', async () => {
    const store = memoryStore({ snapshot: baseSnapshotJson, savedAt: 's' });
    const { provider, calls } = countingProvider(buildProvider());
    const loader = createGeneralDatasetLoader(provider, { store, clock: createManualClock(T0 + HOUR), profileCount: 20 });
    await loader.load();
    expect(calls()).toBe(0);
    const result = await loader.refresh();
    expect(result.ok).toBe(true);
    expect(calls()).toBeGreaterThan(0);
    expect(store.writes).toBe(1);
  });

  it('a partial live build with no snapshot to fall back on is a retryable failure and is not cached or stored', async () => {
    const partial = buildProvider();
    const original = partial.getPlayerSeasonStats.bind(partial);
    let served = 0;
    partial.getPlayerSeasonStats = (query) => {
      served += 1;
      return served === 1 ? original(query) : Promise.resolve(fail('NETWORK', 'down'));
    };
    const store = memoryStore();
    const loader = createGeneralDatasetLoader(partial, { store, profileCount: 5 });
    const result = await loader.load();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.retryable).toBe(true);
    expect(loader.peek()).toBeNull();
    expect(store.writes).toBe(0);
  });

  it('without a store a partial build is still served but flagged in quality notes', async () => {
    const partial = buildProvider();
    const original = partial.getPlayerSeasonStats.bind(partial);
    let served = 0;
    partial.getPlayerSeasonStats = (query) => {
      served += 1;
      return served === 1 ? original(query) : Promise.resolve(fail('NETWORK', 'down'));
    };
    const loader = createGeneralDatasetLoader(partial, { profileCount: 5 });
    const result = await loader.load();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.quality.notes.some((note) => note.startsWith('Partial build'))).toBe(true);
  });
});

describe('refresh integrity (typed outcome)', () => {
  const T13 = T0 + 13 * HOUR;
  function partialProvider(): FixtureProvider {
    const partial = buildProvider();
    const original = partial.getPlayerSeasonStats.bind(partial);
    let served = 0;
    partial.getPlayerSeasonStats = (query) => {
      served += 1;
      return served === 1 ? original(query) : Promise.resolve(fail('NETWORK', 'down'));
    };
    return partial;
  }

  it('refuses to refresh when the stored baseline cannot be read, and writes nothing', async () => {
    const store = memoryStore({ snapshot: baseSnapshotJson, savedAt: 's' });
    store.read = () => Promise.reject(new Error('db blip'));
    const { provider, calls } = countingProvider(buildProvider());
    const loader = createGeneralDatasetLoader(provider, {
      store,
      clock: createManualClock(T0),
      competitions: ['PREMIER_LEAGUE'],
    });
    const result = await loader.refreshDetailed();
    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') expect(result.reason).toBe('baseline-unreadable');
    expect(store.writes).toBe(0);
    expect(calls()).toBe(0);
    expect(loader.peek()).toBeNull();
    const legacy = await loader.refresh();
    expect(legacy.ok).toBe(false);
    if (!legacy.ok) expect(legacy.error.message.startsWith(REFRESH_REJECTED_PREFIX)).toBe(true);
  });

  it('a corrupt stored row is treated as nothing stored (not as an unreadable baseline)', async () => {
    const store = memoryStore({ snapshot: { schemaVersion: 99 }, savedAt: 's' });
    const loader = createGeneralDatasetLoader(buildProvider(), { store, clock: createManualClock(T0), profileCount: 5 });
    const result = await loader.refreshDetailed();
    expect(result.outcome).toBe('written');
    expect(store.writes).toBe(1);
  });

  it('rejects a partial build even with an empty store', async () => {
    const store = memoryStore();
    const loader = createGeneralDatasetLoader(partialProvider(), { store, clock: createManualClock(T0), profileCount: 5 });
    const result = await loader.refreshDetailed();
    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') expect(result.reason).toBe('partial');
    expect(store.writes).toBe(0);
    expect(loader.peek()).toBeNull();
  });

  it('reports a store write failure as write-failed, still serves the data, and refresh() stays ok', async () => {
    const store = memoryStore();
    store.write = () => Promise.reject(new Error('disk full'));
    const loader = createGeneralDatasetLoader(buildProvider(), { store, clock: createManualClock(T0), profileCount: 5 });
    const result = await loader.refreshDetailed();
    expect(result.outcome).toBe('write-failed');
    if (result.outcome === 'write-failed') {
      expect(result.detail).toContain('disk full');
      expect(result.dataset.players.length).toBeGreaterThan(0);
    }
    expect(loader.peek()).not.toBeNull();
    expect((await loader.refresh()).ok).toBe(true);
  });

  it('reports written with the player count on success', async () => {
    const store = memoryStore();
    const loader = createGeneralDatasetLoader(buildProvider(), { store, clock: createManualClock(T0), profileCount: 5 });
    const result = await loader.refreshDetailed();
    expect(result.outcome).toBe('written');
    if (result.outcome === 'written') expect(result.playerCount).toBe(result.dataset.players.length);
  });

  it('compares against the larger of the in-memory dataset and a fresh store read', async () => {
    const store = memoryStore({ snapshot: baseSnapshotJson, savedAt: 's' });
    const loader = createGeneralDatasetLoader(buildProvider(), {
      store,
      clock: createManualClock(T0 + HOUR),
      profileCount: 20,
    });
    await loader.load(); // in-memory copy is the base snapshot
    const inflated = JSON.parse(JSON.stringify(baseSnapshotJson)) as { players: object[] };
    const template = inflated.players[0] as object;
    const padding = Array.from({ length: base.players.length * 2 }, (_, index) => ({ ...template, id: `newer-${index}` }));
    store.current = { snapshot: { ...inflated, players: [...inflated.players, ...padding] }, savedAt: 'later' };
    const result = await loader.refreshDetailed();
    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') expect(result.reason).toBe('smaller');
    expect(store.writes).toBe(0);
  });

  it('load() does not wait for the store write', async () => {
    const store = memoryStore();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realWrite = store.write.bind(store);
    store.write = async (snapshot, meta) => {
      await gate;
      return realWrite(snapshot, meta);
    };
    const loader = createGeneralDatasetLoader(buildProvider(), { store, clock: createManualClock(T0), profileCount: 5 });
    const result = await loader.load(); // would hang forever if it awaited the gated write
    expect(result.ok).toBe(true);
    expect(store.writes).toBe(0);
    release();
    await loader.flushWrites();
    expect(store.writes).toBe(1);
  });

  it('a fire-and-forget write failure is reported via onWarning and never rejects', async () => {
    const store = memoryStore();
    store.write = () => Promise.reject(new Error('nope'));
    const warnings: string[] = [];
    const loader = createGeneralDatasetLoader(buildProvider(), {
      store,
      profileCount: 5,
      onWarning: (m) => warnings.push(m),
    });
    expect((await loader.load()).ok).toBe(true);
    await expect(loader.flushWrites()).resolves.toBeUndefined();
    expect(warnings.some((m) => m.includes('write'))).toBe(true);
  });

  it('a background refresh that is refused (baseline unreadable) never throws', async () => {
    const store = memoryStore({ snapshot: baseSnapshotJson, savedAt: 's' });
    const realRead = store.read.bind(store);
    let reads = 0;
    store.read = () => {
      reads += 1;
      return reads === 1 ? realRead() : Promise.reject(new Error('gone'));
    };
    const loader = createGeneralDatasetLoader(buildProvider(), { store, clock: createManualClock(T13) });
    expect((await loader.load()).ok).toBe(true); // stale snapshot served, background refresh started
    const joined = await loader.refreshDetailed(); // joins it
    expect(joined.outcome).toBe('rejected');
    expect(store.writes).toBe(0);
  });
});
