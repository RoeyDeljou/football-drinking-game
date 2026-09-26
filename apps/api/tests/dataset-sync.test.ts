import {
  buildGeneralDataset,
  createFootballDataProvider,
  createGeneralDatasetLoader,
  readFootballDataConfigFromEnv,
  serializeGeneralDataset,
} from '@fdg/football-data';
import type {
  FootballDataProvider,
  GeneralDataset,
  GeneralDatasetStore,
  RefreshResult,
} from '@fdg/football-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDatasetSync } from '../src/engine/dataset-sync.js';
import { createPrismaGeneralDatasetStore } from '../src/engine/general-dataset-store.js';
import type { TestServer } from './helpers.js';
import { startTestServer } from './helpers.js';

const fixtureProvider = (): FootballDataProvider =>
  createFootballDataProvider(readFootballDataConfigFromEnv({ FOOTBALL_DATA_PROVIDER: 'fixture' }));

describe('runDatasetSync (real Postgres store + fixture provider)', { timeout: 30_000 }, () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer({
      generalDatasetLoader: {
        load: () => Promise.reject(new Error('unused')),
        peek: () => null,
        invalidate: () => undefined,
      },
      warmup: { log: () => undefined, retryDelayMs: 60_000 },
    });
  }, 60_000);
  afterAll(async () => {
    await server.stop();
  });

  it('success: builds, writes the row, exits 0', async () => {
    const store = createPrismaGeneralDatasetStore(server.ctx.prisma);
    const loader = createGeneralDatasetLoader(fixtureProvider(), {
      store,
      onWarning: () => undefined,
    });
    const lines: string[] = [];
    const outcome = await runDatasetSync({ loader, store, log: (l) => lines.push(l) });
    expect(outcome).toMatchObject({ exitCode: 0, wrote: true });
    expect(lines[0]).toMatch(/^\[sync\] OK: wrote \d+ players, \d+\/\d+ competitions/);
    const row = await server.ctx.prisma.generalDatasetSnapshot.findUnique({ where: { id: 'general' } });
    expect(row?.playerCount).toBeGreaterThan(0);
  });

  it('worse result than the stored snapshot: no-op, exit 0, row untouched', async () => {
    const store = createPrismaGeneralDatasetStore(server.ctx.prisma);
    const full = await buildGeneralDataset(fixtureProvider());
    if (!full.ok) throw new Error('fixture build failed');
    // Store a snapshot 10x larger than what the provider can now produce.
    const snapshot = serializeGeneralDataset(full.value);
    const inflated = { ...snapshot, players: Array.from({ length: 10 }, () => snapshot.players).flat() };
    await store.write(inflated, { builtAt: snapshot.builtAt, playerCount: inflated.players.length });

    const loader = createGeneralDatasetLoader(fixtureProvider(), {
      store,
      onWarning: () => undefined,
    });
    const outcome = await runDatasetSync({ loader, store, log: () => undefined });
    expect(outcome).toMatchObject({ exitCode: 0, wrote: false });
    expect(outcome.summary).toContain('rejected (smaller)');
    const after = await server.ctx.prisma.generalDatasetSnapshot.findUnique({ where: { id: 'general' } });
    expect(after?.playerCount).toBe(inflated.players.length);
  });
});

describe('runDatasetSync (outcome -> exit code, fakes)', () => {
  const snapshotRow = { snapshot: {}, builtAt: new Date(0).toISOString(), playerCount: 1 };
  const emptyStore = { read: () => Promise.resolve(null) } as unknown as Pick<GeneralDatasetStore, 'read'>;
  const filledStore = { read: () => Promise.resolve(snapshotRow) } as unknown as Pick<
    GeneralDatasetStore,
    'read'
  >;
  const dataset = {
    players: [{}, {}],
    competitions: [{}, {}],
    seasonStats: [{ competitionId: 'a' }, { competitionId: 'b' }],
  } as unknown as GeneralDataset;
  const legacy = { ok: true, value: dataset } as unknown as RefreshResult extends { result: infer R }
    ? R
    : never;
  const rejected = (
    reason: 'build-failed' | 'empty' | 'partial' | 'smaller' | 'baseline-unreadable',
  ): RefreshResult =>
    ({
      outcome: 'rejected',
      reason,
      detail: `detail-${reason}`,
      error: { message: 'x' },
    }) as unknown as RefreshResult;
  const run = (result: RefreshResult | Error, store: Pick<GeneralDatasetStore, 'read'>) =>
    runDatasetSync({
      loader: {
        refreshDetailed: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
      },
      store,
      log: () => undefined,
    });

  it('written -> 0', async () => {
    const outcome = await run({ outcome: 'written', dataset, playerCount: 2, result: legacy }, emptyStore);
    expect(outcome).toMatchObject({ exitCode: 0, wrote: true });
    expect(outcome.summary).toContain('wrote 2 players, 2/2 competitions');
  });

  it('write-failed -> 1', async () => {
    const outcome = await run(
      { outcome: 'write-failed', dataset, detail: 'disk full', result: legacy },
      filledStore,
    );
    expect(outcome).toMatchObject({ exitCode: 1, wrote: false });
    expect(outcome.summary).toContain('disk full');
  });

  it('smaller with a stored snapshot -> 0 (no-op)', async () => {
    expect(await run(rejected('smaller'), filledStore)).toMatchObject({ exitCode: 0, wrote: false });
  });

  it('smaller with nothing stored -> 1', async () => {
    expect((await run(rejected('smaller'), emptyStore)).exitCode).toBe(1);
  });

  it('partial -> 1 even with an empty store, and names the reason', async () => {
    const outcome = await run(rejected('partial'), emptyStore);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.summary).toContain('partial');
  });

  it('partial -> 1 with a stored snapshot too (broken upstream must go red)', async () => {
    expect((await run(rejected('partial'), filledStore)).exitCode).toBe(1);
  });

  it.each(['empty', 'build-failed', 'baseline-unreadable'] as const)('%s -> 1', async (reason) => {
    const outcome = await run(rejected(reason), filledStore);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.summary).toContain(reason);
  });

  it('a thrown refresh is exit 1, never an exception', async () => {
    expect((await run(new Error('boom'), emptyStore)).exitCode).toBe(1);
  });

  it('unreadable store fails fast BEFORE the build, with the URL redacted', async () => {
    let built = false;
    const outcome = await runDatasetSync({
      loader: {
        refreshDetailed: () => {
          built = true;
          return Promise.resolve(rejected('partial'));
        },
      },
      store: { read: () => Promise.reject(new Error('cannot connect to postgresql://fdg:secretpw@host/db')) },
      log: () => undefined,
    });
    expect(outcome.exitCode).toBe(1);
    expect(built).toBe(false);
    expect(outcome.summary).toContain('before building');
    expect(outcome.summary).not.toContain('secretpw');
  });

  it('flushes pending writes after the refresh', async () => {
    let flushed = false;
    await runDatasetSync({
      loader: {
        refreshDetailed: () => Promise.resolve(rejected('partial')),
        flushWrites: () => {
          flushed = true;
          return Promise.resolve();
        },
      },
      store: emptyStore,
      log: () => undefined,
    });
    expect(flushed).toBe(true);
  });
});
