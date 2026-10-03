/**
 * `fixtureStatus` on the room summary (REST) and in the per-recipient socket payload, so the web can hide
 * live-only games once the match is over.
 */
import { FixtureProvider, createNodeDataSource } from '@fdg/football-data';
import type { FixtureId } from '@fdg/football-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveScheduler } from '../src/live/ingestion.js';
import type { TestServer } from './helpers.js';
import { connectAndTrack, jsonFetch, startTestServer } from './helpers.js';

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
  readonly fixtureStatus: string | null;
  readonly round: { id: string; status: string; publicPayload: { markets: readonly { id: string; options: readonly { id: string }[] }[] } } | null;
}

const createMatchdayRoom = async (server: TestServer, body: Record<string, unknown> = { fixtureId: FIXTURE_ID }) => {
  const created = await jsonFetch(`${server.baseUrl}/rooms`, {
    method: 'POST',
    body: JSON.stringify({ category: 'matchday', hostNickname: 'Host', settings: { minPlayersToStart: 1 }, ...body }),
  });
  return created;
};

describe('fixtureStatus on the room summary and socket payload', () => {
  let server: TestServer;
  let provider: FixtureProvider;
  let getFixtureCalls = 0;
  const fake = createFakeScheduler();

  beforeAll(async () => {
    provider = new FixtureProvider({
      dataSource: createNodeDataSource(),
      replay: { fixtureId: FIXTURE_ID, autoStart: false, startMinute: 0 },
    });
    await provider.ready();
    const original = provider.getFixture.bind(provider);
    provider.getFixture = async (id: FixtureId) => {
      getFixtureCalls += 1;
      return original(id);
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

  it('REST: status from one cached provider lookup for a finished fixture, on both endpoints; null for general rooms', async () => {
    const replay = provider.matchReplay()!;
    replay.advanceTo(replay.status().finalMinute);
    const created = await createMatchdayRoom(server);
    expect(created.status).toBe(201);
    const room = created.body as { roomId: string; pin: string; room: { fixtureStatus: string | null } };
    const callsAfterCreate = getFixtureCalls;
    const byId = await jsonFetch(`${server.baseUrl}/rooms/${room.roomId}`);
    const byPin = await jsonFetch(`${server.baseUrl}/rooms/pin/${room.pin}`);
    expect((byId.body as { fixtureStatus: string | null }).fixtureStatus).toBe('FINISHED');
    expect((byPin.body as { fixtureStatus: string | null }).fixtureStatus).toBe('FINISHED');
    expect(room.room.fixtureStatus).toBe('FINISHED');
    expect(getFixtureCalls).toBe(callsAfterCreate); // both GETs hit the short memo: no further provider lookups

    const general = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ category: 'general', hostNickname: 'Gen' }),
    });
    expect((general.body as { room: { fixtureStatus: string | null } }).room.fixtureStatus).toBeNull();
    replay.reset();
  }, 30_000);

  it('socket: the broadcast payload carries fixtureStatus and re-broadcasts when it changes (LIVE -> FINISHED)', async () => {
    const ingestion = server.ctx.liveIngestion!;
    const idle = (): Promise<void> => ingestion.idle();
    const replay = provider.matchReplay()!;
    replay.reset();
    const created = await createMatchdayRoom(server);
    const { roomToken } = created.body as { roomToken: string };
    const host = await connectAndTrack<RoomView>(server, { mode: 'reconnect', roomToken });
    const hostId = host.joined.playerId;
    host.socket.emit('room:action', { type: 'SELECT_GAME', actorId: hostId, moduleId: 'M1', config: null });
    await host.state.waitFor((s) => s.selection?.moduleId === 'M1', 15_000);
    host.socket.emit('room:action', { type: 'START_LOADING', actorId: hostId, stepKeys: ['fixture', 'lineups', 'squads', 'stats'] });
    await host.state.waitFor((s) => s.loading?.steps.every((step) => step.status === 'done') === true, 30_000);
    host.socket.emit('room:action', { type: 'START_SESSION', actorId: hostId });
    const playing = await host.state.waitFor((s) => s.round?.status === 'open', 15_000);
    expect(playing.fixtureStatus).toBe('LIVE'); // cache-only source: the prefetched bundle (replay at kickoff)

    await fake.advance(15_000, idle); // first poll observes LIVE
    replay.advanceTo(replay.status().finalMinute);
    await fake.advance(15_000, idle); // poll observes FINISHED: the room is re-broadcast with it
    const finished = await host.state.waitFor((s) => s.fixtureStatus === 'FINISHED', 15_000);
    expect(finished.fixtureStatus).toBe('FINISHED');
    host.socket.close();
  }, 60_000);
});

describe('fixtureStatus never blocks on a slow upstream', () => {
  let server: TestServer;

  beforeAll(async () => {
    const base = new FixtureProvider({ dataSource: createNodeDataSource() });
    await base.ready();
    const original = base.getFixture.bind(base);
    let calls = 0;
    // The first call is the room's own prefetch; every later one (the status lookup) never resolves.
    base.getFixture = (id: FixtureId) => (++calls === 1 ? original(id) : new Promise(() => undefined));
    server = await startTestServer({ footballData: base, disableLiveIngestion: true });
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  it('times out to null within ~1.5s', async () => {
    const created = await createMatchdayRoom(server);
    expect(created.status).toBe(201);
    expect((created.body as { room: { fixtureStatus: string | null } }).room.fixtureStatus).toBeNull();
    const { roomId } = created.body as { roomId: string };
    const started = Date.now();
    const response = await jsonFetch(`${server.baseUrl}/rooms/${roomId}`);
    expect(Date.now() - started).toBeLessThan(4000);
    expect((response.body as { fixtureStatus: string | null }).fixtureStatus).toBeNull();
  }, 30_000);
});
