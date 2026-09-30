/**
 * Live-ingestion side effects against a real server: (1) an unchanged MATCH_EVENTS batch causes zero
 * store saves, zero broadcasts and zero persistence writes; (2) a FINISHED fixture whose feed never
 * published a FULL_TIME (so the data layer synthesizes one) still resolves the M1 round.
 */
import { FixtureProvider, createNodeDataSource, guaranteeFullTime, syntheticFullTimeId } from '@fdg/football-data';
import type { FixtureId } from '@fdg/football-data';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Results from '../src/persistence/results.js';
import type { LiveScheduler } from '../src/live/ingestion.js';
import type { TestServer } from './helpers.js';
import { connectAndTrack, jsonFetch, startTestServer } from './helpers.js';

const persistCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/persistence/results.js', async (importOriginal) => {
  const original = await importOriginal<typeof Results>();
  return {
    ...original,
    persistEngineEvents: (...args: Parameters<typeof original.persistEngineEvents>) => {
      persistCalls.count += 1;
      return original.persistEngineEvents(...args);
    },
  };
});

const FIXTURE_ID = '401915445';

const createFakeScheduler = () => {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const scheduler: LiveScheduler = {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const advance = async (ms: number, idle: () => Promise<void>): Promise<void> => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
      await idle();
    }
    now = target;
  };
  return { scheduler, advance };
};

interface RoomView {
  readonly phase: string;
  readonly selection: { moduleId: string } | null;
  readonly loading: { steps: readonly { status: string }[] } | null;
  readonly round: {
    id: string;
    status: string;
    publicPayload: { markets: readonly { id: string; options: readonly { id: string }[] }[]; counters: { fullTime: boolean } };
  } | null;
}

const M1_CONFIG = {
  markets: ['MATCH_RESULT', 'BTTS', 'OVER_UNDER_GOALS'],
  goalsLine: 2.5,
  cornersLine: 9.5,
  cardsLine: 3.5,
  scorerOptionCount: 5,
  slipWindowMs: 3_600_000,
  sipsPerLostMarket: 1,
  worstSlipSips: 3,
  perfectSlipSips: 2,
  noAnswerSips: 4,
};

const startRoom = async (server: TestServer, moduleId: string, config: unknown) => {
  const created = await jsonFetch(`${server.baseUrl}/rooms`, {
    method: 'POST',
    body: JSON.stringify({ category: 'matchday', fixtureId: FIXTURE_ID, hostNickname: 'Hosty', settings: { minPlayersToStart: 1 } }),
  });
  expect(created.status).toBe(201);
  const { roomToken, roomId } = created.body as { roomToken: string; roomId: string };
  const host = await connectAndTrack<RoomView>(server, { mode: 'reconnect', roomToken });
  const playerId = host.joined.playerId;
  host.socket.emit('room:action', { type: 'SELECT_GAME', actorId: playerId, moduleId, config });
  await host.state.waitFor((s) => s.selection?.moduleId === moduleId, 15_000);
  host.socket.emit('room:action', { type: 'START_LOADING', actorId: playerId, stepKeys: ['fixture', 'lineups', 'squads', 'stats'] });
  await host.state.waitFor((s) => s.loading?.steps.every((step) => step.status === 'done') === true, 30_000);
  host.socket.emit('room:action', { type: 'START_SESSION', actorId: playerId });
  await host.state.waitFor((s) => s.round?.status === 'open', 15_000);
  return { host, roomId };
};

const startM1Room = async (server: TestServer) => {
  const created = await jsonFetch(`${server.baseUrl}/rooms`, {
    method: 'POST',
    body: JSON.stringify({ category: 'matchday', fixtureId: FIXTURE_ID, hostNickname: 'Hosty', settings: { minPlayersToStart: 1 } }),
  });
  expect(created.status).toBe(201);
  const { roomToken, roomId } = created.body as { roomToken: string; roomId: string };
  const host = await connectAndTrack<RoomView>(server, { mode: 'reconnect', roomToken });
  const playerId = host.joined.playerId;
  host.socket.emit('room:action', { type: 'SELECT_GAME', actorId: playerId, moduleId: 'M1', config: M1_CONFIG });
  await host.state.waitFor((s) => s.selection?.moduleId === 'M1', 15_000);
  host.socket.emit('room:action', { type: 'START_LOADING', actorId: playerId, stepKeys: ['fixture', 'lineups', 'squads', 'stats'] });
  await host.state.waitFor((s) => s.loading?.steps.every((step) => step.status === 'done') === true, 30_000);
  host.socket.emit('room:action', { type: 'START_SESSION', actorId: playerId });
  const playing = await host.state.waitFor((s) => s.round?.status === 'open', 15_000);
  const round = playing.round!;
  host.socket.emit('room:action', {
    type: 'SUBMIT_ANSWER',
    playerId,
    roundId: round.id,
    payload: { picks: round.publicPayload.markets.map((m) => ({ marketId: m.id, optionId: m.options[0]!.id })) },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { host, roomId };
};

describe('live ingestion side effects', () => {
  let server: TestServer;
  let provider: FixtureProvider;
  let liveCalls = 0;
  let fullTimeMode: 'real' | 'synthetic' | 'withheld' | 'empty' = 'real';
  const fake = createFakeScheduler();

  beforeAll(async () => {
    provider = new FixtureProvider({
      dataSource: createNodeDataSource(),
      replay: { fixtureId: FIXTURE_ID, autoStart: false, startMinute: 0 },
    });
    await provider.ready();
    const original = provider.getLiveMatchState.bind(provider);
    provider.getLiveMatchState = async (id: FixtureId) => {
      liveCalls += 1;
      const result = await original(id);
      if (fullTimeMode === 'real' || !result.ok || result.value === null) return result;
      // A feed that flipped to FINISHED but never published a final-whistle play: the data layer synthesizes one.
      if (fullTimeMode === 'empty') return { ...result, value: { ...result.value, events: [] } };
      const events = result.value.events.filter((event) => event.type !== 'FULL_TIME');
      const stripped = { ...result.value, events };
      return { ...result, value: fullTimeMode === 'synthetic' ? guaranteeFullTime(stripped) : stripped };
    };
    server = await startTestServer({
      footballData: provider,
      liveScheduler: fake.scheduler,
      liveIngestion: { liveIntervalMs: 15_000, preKickoffIntervalMs: 15_000, jitterRatio: 0 },
    });
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  it('an unchanged batch causes zero store saves, zero broadcasts and zero persistence writes', async () => {
    const ingestion = server.ctx.liveIngestion!;
    const idle = (): Promise<void> => ingestion.idle();
    const replay = provider.matchReplay()!;
    const { host, roomId } = await startM1Room(server);

    replay.advanceTo(30);
    await fake.advance(15_000, idle);
    expect(host.state.latest()?.round?.publicPayload.counters).toBeDefined();

    let saves = 0;
    const store = server.ctx.roomStore;
    const originalSave = store.save.bind(store);
    store.save = async (record) => {
      saves += 1;
      return originalSave(record);
    };
    let broadcasts = 0;
    host.socket.on('room:state', () => {
      broadcasts += 1;
    });
    const persistBefore = persistCalls.count;
    const callsBefore = liveCalls;
    const payloadBefore = (await store.load(roomId as never))!.state.sessions[0]!.rounds[0]!.publicPayload;

    for (let i = 0; i < 4; i += 1) await fake.advance(15_000, idle);

    expect(liveCalls - callsBefore).toBe(4); // the polls really happened...
    expect(saves).toBe(0); // ...and delivered the same events again
    expect(broadcasts).toBe(0);
    expect(persistCalls.count).toBe(persistBefore);
    expect((await store.load(roomId as never))!.state.sessions[0]!.rounds[0]!.publicPayload).toEqual(payloadBefore);

    store.save = originalSave;
    host.socket.close();
    replay.reset();
  }, 60_000);

  it('a FINISHED fixture carrying only the synthetic FULL_TIME resolves the M1 round', async () => {
    const ingestion = server.ctx.liveIngestion!;
    const idle = (): Promise<void> => ingestion.idle();
    const replay = provider.matchReplay()!;
    fullTimeMode = 'synthetic';
    const { host, roomId } = await startM1Room(server);

    replay.advanceTo(replay.status().finalMinute);
    expect(replay.fixture().status).toBe('FINISHED');
    await fake.advance(15_000, idle);
    const final = await host.state.waitFor((s) => s.round?.status === 'resolved', 15_000);
    expect(final.round!.publicPayload.counters.fullTime).toBe(true);

    const record = await server.ctx.roomStore.load(roomId as never);
    const round = record!.state.sessions[0]!.rounds[0]!;
    expect(round.observedEventIds).toContain(syntheticFullTimeId(FIXTURE_ID as FixtureId));
    fullTimeMode = 'real';
    host.socket.close();
  }, 60_000);

  it('FINISHED with FULL_TIME withheld keeps polling; the round resolves when FULL_TIME lands on a later poll', async () => {
    const ingestion = server.ctx.liveIngestion!;
    const idle = (): Promise<void> => ingestion.idle();
    const replay = provider.matchReplay()!;
    replay.reset();
    fullTimeMode = 'withheld';
    const { host, roomId } = await startM1Room(server);

    replay.advanceTo(replay.status().finalMinute);
    expect(replay.fixture().status).toBe('FINISHED');
    await fake.advance(15_000, idle);
    await fake.advance(15_000, idle);
    const record = await server.ctx.roomStore.load(roomId as never);
    expect(record!.state.sessions.at(-1)!.rounds[0]!.status).toBe('open'); // no full time yet: nothing resolves
    expect(ingestion.watchedFixtureIds()).toEqual([FIXTURE_ID]); // ...and the loop is still watching

    fullTimeMode = 'real';
    await fake.advance(15_000, idle);
    const final = await host.state.waitFor((s) => s.round?.status === 'resolved', 15_000);
    expect(final.round!.publicPayload.counters.fullTime).toBe(true);
    await idle();
    expect(ingestion.watchedFixtureIds()).toEqual([]);
    host.socket.close();
  }, 60_000);

  it('a since-round-open round (M7) opened while the feed has no events still gets its baseline, without churn', async () => {
    const ingestion = server.ctx.liveIngestion!;
    const idle = (): Promise<void> => ingestion.idle();
    const replay = provider.matchReplay()!;
    replay.reset();
    replay.advanceTo(0);
    const { host, roomId } = await startRoom(server, 'M7', null); // prefetch sees real data (hasLiveEvents)
    fullTimeMode = 'empty'; // ...then the feed goes quiet before the first poll (fake timers: none has fired yet)
    const store = server.ctx.roomStore;
    const window = async () => (await store.load(roomId as never))!.state.sessions.at(-1)!.rounds.at(-1)!.liveWindow;
    expect(await window()).toMatchObject({ baselineSource: null });

    await fake.advance(15_000, idle); // first poll: empty list, delivered once as the baseline
    expect(await window()).toMatchObject({ baselineSource: 'first-batch', openedAt: null });

    let saves = 0;
    const originalSave = store.save.bind(store);
    store.save = async (record) => {
      saves += 1;
      return originalSave(record);
    };
    let broadcasts = 0;
    host.socket.on('room:state', () => {
      broadcasts += 1;
    });
    const persistBefore = persistCalls.count;
    const callsBefore = liveCalls;
    for (let i = 0; i < 3; i += 1) await fake.advance(15_000, idle);
    expect(liveCalls - callsBefore).toBe(3);
    expect(saves).toBe(0);
    expect(broadcasts).toBe(0);
    expect(persistCalls.count).toBe(persistBefore);

    store.save = originalSave;
    fullTimeMode = 'real';
    host.socket.close();
  }, 60_000);
});
