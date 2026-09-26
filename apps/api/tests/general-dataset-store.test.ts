import {
  buildGeneralDataset,
  createFootballDataProvider,
  readFootballDataConfigFromEnv,
  serializeGeneralDataset,
} from '@fdg/football-data';
import type { GeneralDatasetSnapshot } from '@fdg/football-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaGeneralDatasetStore } from '../src/engine/general-dataset-store.js';
import type { TestServer } from './helpers.js';
import { startTestServer } from './helpers.js';

const fixtureSnapshot = async (): Promise<GeneralDatasetSnapshot> => {
  const provider = createFootballDataProvider(
    readFootballDataConfigFromEnv({ FOOTBALL_DATA_PROVIDER: 'fixture' }),
  );
  const built = await buildGeneralDataset(provider);
  if (!built.ok) throw new Error(built.error.message);
  return serializeGeneralDataset(built.value);
};

describe('createPrismaGeneralDatasetStore', () => {
  let server: TestServer;
  let snapshot: GeneralDatasetSnapshot;

  beforeAll(async () => {
    snapshot = await fixtureSnapshot();
    // The server's own loader is injected so nothing else writes to the snapshot table.
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

  it('returns null when nothing is stored', async () => {
    const store = createPrismaGeneralDatasetStore(server.ctx.prisma);
    expect(await store.read()).toBeNull();
  });

  it('round-trips a snapshot and upserts over it', async () => {
    const store = createPrismaGeneralDatasetStore(server.ctx.prisma);
    await store.write(snapshot, { builtAt: snapshot.builtAt, playerCount: snapshot.players.length });
    const first = await store.read();
    expect(first).not.toBeNull();
    expect(first?.snapshot).toEqual(JSON.parse(JSON.stringify(snapshot)));
    expect(Number.isNaN(Date.parse(first?.savedAt ?? ''))).toBe(false);

    const newer: GeneralDatasetSnapshot = { ...snapshot, builtAt: new Date(Date.now() + 1000).toISOString() };
    await store.write(newer, { builtAt: newer.builtAt, playerCount: 7 });
    const second = await store.read();
    expect((second?.snapshot as { builtAt: string }).builtAt).toBe(newer.builtAt);
    const rows = await server.ctx.prisma.generalDatasetSnapshot.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.playerCount).toBe(7);
  });
});
