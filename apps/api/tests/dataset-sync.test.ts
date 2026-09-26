import {
  buildGeneralDataset,
  createFootballDataProvider,
  createGeneralDatasetLoader,
  fail,
  readFootballDataConfigFromEnv,
  serializeGeneralDataset,
} from '@fdg/football-data';
import type { FootballDataProvider, GeneralDatasetStore } from '@fdg/football-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REFRESH_REJECTED_PREFIX, runDatasetSync } from '../src/engine/dataset-sync.js';
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
    const warnings: string[] = [];
    const loader = createGeneralDatasetLoader(fixtureProvider(), {
      store,
      onWarning: (m) => warnings.push(m),
    });
    const lines: string[] = [];
    const outcome = await runDatasetSync({ loader, store, warnings, log: (l) => lines.push(l) });
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

    const warnings: string[] = [];
    const loader = createGeneralDatasetLoader(fixtureProvider(), {
      store,
      onWarning: (m) => warnings.push(m),
    });
    const outcome = await runDatasetSync({ loader, store, warnings, log: () => undefined });
    expect(outcome).toMatchObject({ exitCode: 0, wrote: false });
    expect(outcome.summary).toContain(REFRESH_REJECTED_PREFIX);
    const after = await server.ctx.prisma.generalDatasetSnapshot.findUnique({ where: { id: 'general' } });
    expect(after?.playerCount).toBe(inflated.players.length);
  });
});

describe('runDatasetSync (fakes)', () => {
  const emptyStore: GeneralDatasetStore = {
    read: () => Promise.resolve(null),
    write: () => Promise.resolve(),
  };

  it('hard failure with nothing stored: exit 1', async () => {
    const loader = {
      refresh: () => Promise.resolve(fail('NETWORK', 'ESPN unreachable', { retryable: true })),
    };
    const outcome = await runDatasetSync({ loader, store: emptyStore, warnings: [], log: () => undefined });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.summary).toContain('ESPN unreachable');
  });

  it('a rejection with nothing stored is a failure, not a no-op', async () => {
    const loader = {
      refresh: () =>
        Promise.resolve(fail('INVALID_RESPONSE', `${REFRESH_REJECTED_PREFIX}: it has no players`)),
    };
    const outcome = await runDatasetSync({ loader, store: emptyStore, warnings: [], log: () => undefined });
    expect(outcome.exitCode).toBe(1);
  });

  it('a thrown refresh is exit 1, never an exception', async () => {
    const loader = { refresh: () => Promise.reject(new Error('boom')) };
    const outcome = await runDatasetSync({ loader, store: emptyStore, warnings: [], log: () => undefined });
    expect(outcome.exitCode).toBe(1);
  });
});
