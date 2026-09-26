import type { ProjectedRoom } from '@fdg/game-core';
import {
  createFootballDataProvider,
  createGeneralDatasetLoader,
  fail,
  readFootballDataConfigFromEnv,
} from '@fdg/football-data';
import type { FootballDataProvider, GeneralDataset, GeneralDatasetLoader } from '@fdg/football-data';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGeneralDatasetAccess,
  startGeneralDatasetWarmup,
} from '../src/engine/general-dataset-access.js';
import type { TestServer } from './helpers.js';
import { connectAndTrack, jsonFetch, startTestServer } from './helpers.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The fixture provider (no network), wrapped so tests can count upstream calls. */
const fixtureProvider = (): { provider: FootballDataProvider; listCompetitionsCalls: () => number } => {
  process.env.FOOTBALL_DATA_PROVIDER = 'fixture';
  const inner = createFootballDataProvider(readFootballDataConfigFromEnv(process.env));
  let calls = 0;
  const provider = new Proxy(inner, {
    get: (target, key) => {
      const value = Reflect.get(target, key) as unknown;
      if (key === 'listCompetitions' && typeof value === 'function') {
        return (...args: unknown[]) => {
          calls += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { provider, listCompetitionsCalls: () => calls };
};

/** A loader whose `load()` waits `delayMs` first, then behaves as `inner` (after `failures` scripted failures). */
const scriptedLoader = (
  inner: GeneralDatasetLoader,
  opts: { delayMs: number; failures?: number; throws?: boolean },
): { loader: GeneralDatasetLoader; loads: () => number } => {
  let loads = 0;
  let remainingFailures = opts.failures ?? 0;
  return {
    loads: () => loads,
    loader: {
      peek: () => inner.peek(),
      invalidate: () => inner.invalidate(),
      load: async () => {
        loads += 1;
        await sleep(opts.delayMs);
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          if (opts.throws === true) throw new Error('simulated provider crash');
          return fail('NETWORK', 'simulated provider outage', { retryable: true });
        }
        return inner.load();
      },
    },
  };
};

describe('general dataset warm-up (boot)', () => {
  let server: TestServer | null = null;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(async () => {
    process.off('unhandledRejection', onUnhandled);
    await server?.stop();
    server = null;
    expect(unhandled).toEqual([]);
  });

  const createHostedRoom = async (s: TestServer) => {
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
    return { host, hostPlayerId };
  };

  it('(a) starts warming at boot, so a SELECT_GAME after warm-up returns promptly (not after a cold build)', async () => {
    const { provider } = fixtureProvider();
    const scripted = scriptedLoader(createGeneralDatasetLoader(provider), { delayMs: 2_000 });
    server = await startTestServer({
      generalDatasetLoader: scripted.loader,
      warmup: { log: () => undefined },
    });

    // Triggered by boot itself, before any request touched the dataset.
    await sleep(100);
    expect(scripted.loads()).toBe(1);

    const { host, hostPlayerId } = await createHostedRoom(server);
    await server.warmup.done;

    const t0 = Date.now();
    const selected = host.state.waitFor((state) => state.selection?.moduleId === 'G6', 5_000);
    host.socket.emit('room:action', {
      type: 'SELECT_GAME',
      actorId: hostPlayerId,
      moduleId: 'G6',
      config: null,
    });
    await selected;
    expect(Date.now() - t0).toBeLessThan(800);
    expect(scripted.loads()).toBe(1);
    host.socket.close();
  }, 30_000);

  it('coalesces concurrent callers onto ONE in-flight build (warm-up + requests never double-fetch)', async () => {
    const { provider, listCompetitionsCalls } = fixtureProvider();
    const access = createGeneralDatasetAccess(createGeneralDatasetLoader(provider));
    const started = Date.now();
    const [warmed, a, b] = await Promise.all([access.warm(), access.get(), access.get()]);
    console.log(`[test] fixture-provider general dataset build took ${Date.now() - started}ms`);
    expect(warmed).toBe(true);
    expect(a.players.length).toBeGreaterThan(0);
    expect(b).toBe(a);
    expect(listCompetitionsCalls()).toBe(1);
  }, 30_000);

  it('(b) a failing warm-up is logged, does not crash or block /health, and the single retry recovers', async () => {
    const { provider } = fixtureProvider();
    const scripted = scriptedLoader(createGeneralDatasetLoader(provider), {
      delayMs: 400,
      failures: 1,
      throws: true,
    });
    const logs: string[] = [];
    server = await startTestServer({
      generalDatasetLoader: scripted.loader,
      warmup: { retryDelayMs: 300, log: (message) => logs.push(message) },
    });

    // The warm-up is mid-flight (400ms load) and /health must still answer immediately.
    const t0 = Date.now();
    const health = await jsonFetch(`${server.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(300);

    await server.warmup.done;
    expect(scripted.loads()).toBe(2); // first attempt threw, exactly one retry
    expect(logs.some((line) => line.startsWith('[warmup]') && line.includes('failed'))).toBe(true);
    expect(logs.some((line) => line.includes('retrying once'))).toBe(true);
    expect(logs.some((line) => line.includes('ready (retry)'))).toBe(true);

    const dataset: GeneralDataset = await server.ctx.generalDataset();
    expect(dataset.players.length).toBeGreaterThan(0);
  }, 30_000);

  it('(b) when both warm-up attempts fail the lazy path still works on the next request', async () => {
    const { provider } = fixtureProvider();
    const scripted = scriptedLoader(createGeneralDatasetLoader(provider), { delayMs: 10, failures: 2 });
    server = await startTestServer({
      generalDatasetLoader: scripted.loader,
      generalDatasetCooldownMs: 0,
      warmup: { retryDelayMs: 50, log: () => undefined },
    });
    await server.warmup.done;
    expect(scripted.loads()).toBe(2);
    const dataset = await server.ctx.generalDataset();
    expect(dataset.players.length).toBeGreaterThan(0);
    expect(scripted.loads()).toBe(3);
  }, 30_000);
});

describe('general dataset access: failures are not sticky and not repeated at full price', () => {
  it('(c) serves an empty dataset immediately during the cool-down, then retries the real load', async () => {
    const { provider } = fixtureProvider();
    const scripted = scriptedLoader(createGeneralDatasetLoader(provider), { delayMs: 0, failures: 1 });
    let now = 1_000;
    const access = createGeneralDatasetAccess(scripted.loader, {
      cooldownMs: 30_000,
      now: () => now,
      log: () => undefined,
    });

    const first = await access.get();
    expect(first.players).toHaveLength(0);
    expect(scripted.loads()).toBe(1);

    // Within the cool-down every call is instant and does NOT re-run the (tens of seconds) build.
    now += 5_000;
    expect((await access.get()).players).toHaveLength(0);
    expect((await access.get()).players).toHaveLength(0);
    expect(scripted.loads()).toBe(1);

    // After the cool-down the real load is retried and the process recovers (not stuck on empty).
    now += 30_000;
    const recovered = await access.get();
    expect(recovered.players.length).toBeGreaterThan(0);
    expect(scripted.loads()).toBe(2);
    expect(await access.get()).toBe(recovered);
    expect(scripted.loads()).toBe(2);
  }, 30_000);

  it('warm-up never throws even if the access layer does', async () => {
    const logs: string[] = [];
    const handle = startGeneralDatasetWarmup(
      { warm: () => Promise.reject(new Error('boom')) },
      { retryDelayMs: 10, log: (message) => logs.push(message) },
    );
    await handle.done;
    expect(logs.filter((line) => line.includes('threw'))).toHaveLength(2);
  });

  it('a successful load is reported with its duration', async () => {
    const logs: string[] = [];
    const handle = startGeneralDatasetWarmup(
      { warm: async () => true },
      { log: (message) => logs.push(message) },
    );
    await handle.done;
    expect(logs[0]).toMatch(/^\[warmup\] general dataset ready \(attempt 1\) in \d+ms$/);
  });
});
