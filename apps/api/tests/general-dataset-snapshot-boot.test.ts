import type { ProjectedRoom } from '@fdg/game-core';
import {
  buildGeneralDataset,
  createFootballDataProvider,
  readFootballDataConfigFromEnv,
  serializeGeneralDataset,
} from '@fdg/football-data';
import type { FootballDataProvider, GeneralDatasetSnapshot } from '@fdg/football-data';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/db/client.js';
import { createPrismaGeneralDatasetStore } from '../src/engine/general-dataset-store.js';
import type { TestServer } from './helpers.js';
import { connectAndTrack, jsonFetch, startTestServer } from './helpers.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const newFixtureProvider = (): FootballDataProvider =>
  createFootballDataProvider(readFootballDataConfigFromEnv({ FOOTBALL_DATA_PROVIDER: 'fixture' }));

/** Wraps every provider method so tests can count upstream calls. */
const countingProvider = (
  inner: FootballDataProvider,
): { provider: FootballDataProvider; calls: () => number } => {
  let calls = 0;
  const provider = new Proxy(inner, {
    get: (target, key) => {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls += 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { provider, calls: () => calls };
};

const poll = async (predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`poll timed out after ${timeoutMs}ms`);
};

describe('general dataset served from the stored snapshot', () => {
  let base: GeneralDatasetSnapshot;
  let server: TestServer | null = null;

  beforeAll(async () => {
    const built = await buildGeneralDataset(newFixtureProvider());
    if (!built.ok) throw new Error(built.error.message);
    base = serializeGeneralDataset(built.value);
  }, 60_000);

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  const seed =
    (snapshot: GeneralDatasetSnapshot) =>
    async (prisma: PrismaClient): Promise<void> => {
      await createPrismaGeneralDatasetStore(prisma).write(snapshot, {
        builtAt: snapshot.builtAt,
        playerCount: snapshot.players.length,
      });
    };

  const selectGeneralGame = async (s: TestServer): Promise<void> => {
    const created = await jsonFetch(`${s.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({
        category: 'general',
        hostNickname: 'Hosty',
        settings: { minPlayersToStart: 1 },
      }),
    });
    const { roomToken, hostPlayerId } = created.body as { roomToken: string; hostPlayerId: string };
    const host = await connectAndTrack<ProjectedRoom>(s, { mode: 'reconnect', roomToken });
    const selected = host.state.waitFor((state) => state.selection?.moduleId === 'G6', 5_000);
    host.socket.emit('room:action', {
      type: 'SELECT_GAME',
      actorId: hostPlayerId,
      moduleId: 'G6',
      config: null,
    });
    await selected;
    host.socket.close();
  };

  it('(a) a fresh snapshot serves the first SELECT_GAME with zero provider calls', async () => {
    const { provider, calls } = countingProvider(newFixtureProvider());
    const logs: string[] = [];
    server = await startTestServer({
      footballData: provider,
      prepareDatabase: seed({ ...base, builtAt: new Date().toISOString() }),
      warmup: { log: (line) => logs.push(line) },
    });
    await server.warmup.done;
    await selectGeneralGame(server);
    expect(calls()).toBe(0);
    expect(logs.join('\n')).toMatch(/ready \(attempt 1\).*source: snapshot/);
  }, 30_000);

  it('(b) a stale snapshot is served instantly while a background refresh replaces it', async () => {
    const { provider, calls } = countingProvider(newFixtureProvider());
    const logs: string[] = [];
    const staleBuiltAt = new Date(Date.now() - 13 * 3_600_000).toISOString();
    server = await startTestServer({
      footballData: provider,
      prepareDatabase: seed({ ...base, builtAt: staleBuiltAt }),
      warmup: { log: (line) => logs.push(line) },
    });
    await server.warmup.done;
    expect(logs.join('\n')).toMatch(/source: snapshot, data age: 13\.\dh/);
    await selectGeneralGame(server);

    const prisma = server.ctx.prisma;
    await poll(async () => {
      const row = await prisma.generalDatasetSnapshot.findUnique({ where: { id: 'general' } });
      return row !== null && row.builtAt.toISOString() !== staleBuiltAt;
    });
    expect(calls()).toBeGreaterThan(0);
  }, 60_000);

  it('(c) a corrupt row falls back to a live build, does not crash, and is replaced', async () => {
    const { provider, calls } = countingProvider(newFixtureProvider());
    const logs: string[] = [];
    server = await startTestServer({
      footballData: provider,
      prepareDatabase: async (prisma) => {
        await prisma.generalDatasetSnapshot.create({
          data: {
            id: 'general',
            builtAt: new Date(),
            playerCount: 1,
            payload: { schemaVersion: 1, nonsense: true },
          },
        });
      },
      warmup: { log: (line) => logs.push(line) },
    });
    await server.warmup.done;
    expect(logs.join('\n')).toMatch(/ready \(attempt 1\).*source: live build/);
    expect(calls()).toBeGreaterThan(0);
    await selectGeneralGame(server);

    const prisma = server.ctx.prisma;
    await poll(async () => {
      const row = await prisma.generalDatasetSnapshot.findUnique({ where: { id: 'general' } });
      return row !== null && row.playerCount > 1;
    });
  }, 60_000);
});
