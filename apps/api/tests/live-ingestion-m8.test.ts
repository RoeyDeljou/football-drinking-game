/**
 * Phase 5: M8 Stat Duel end to end through the API on the replay provider (recorded PSG 6-1 Slovan,
 * 401915445). Four players pick blind, the ingestion loop delivers MATCH_EVENTS then MATCH_STATS on an
 * injected clock, and the bracket settles on the first stats snapshot after the whistle. Dembele (2G+2A)
 * is champion on goal involvements whatever the seeding.
 */
import { FixtureProvider, createNodeDataSource } from '@fdg/football-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveScheduler } from '../src/live/ingestion.js';
import type { TestServer } from './helpers.js';
import { connectAndTrack, jsonFetch, startTestServer } from './helpers.js';

const FIXTURE_ID = '401915445';
const DEMBELE = '229744';
const FERRAN = '265869';
const CAMARA = '310419';
const RUIZ = '214596';
const PICK_WINDOW_MS = 10_000;

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
  return { scheduler, advance, pending: () => timers.size };
};

interface RoomView {
  readonly phase: string;
  readonly selection: { moduleId: string } | null;
  readonly loading: { steps: readonly { status: string }[] } | null;
  readonly players: readonly { id: string }[];
  readonly round: {
    id: string;
    status: string;
    publicPayload: { options: readonly { footballerId: string }[]; whistle: boolean };
  } | null;
}

describe('M8 Stat Duel through the API (replay provider)', () => {
  let server: TestServer;
  let provider: FixtureProvider;
  const fake = createFakeScheduler();

  beforeAll(async () => {
    provider = new FixtureProvider({
      dataSource: createNodeDataSource(),
      replay: { fixtureId: FIXTURE_ID, autoStart: false, startMinute: 0 },
    });
    await provider.ready();
    server = await startTestServer({
      footballData: provider,
      liveScheduler: fake.scheduler,
      liveIngestion: { liveIntervalMs: 15_000, preKickoffIntervalMs: 15_000, jitterRatio: 0 },
    });
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  it('settles the bracket at full time with Dembele as champion; repeated polls do not re-settle', async () => {
    const ingestion = server.ctx.liveIngestion!;
    const idle = (): Promise<void> => ingestion.idle();
    const replay = provider.matchReplay()!;

    const created = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ category: 'matchday', fixtureId: FIXTURE_ID, hostNickname: 'Host', settings: { minPlayersToStart: 2 } }),
    });
    expect(created.status).toBe(201);
    const { roomToken, roomId } = created.body as { roomToken: string; roomId: string };
    const host = await connectAndTrack<RoomView>(server, { mode: 'reconnect', roomToken });
    const guests = [];
    for (const nickname of ['Ferran', 'Camara', 'Ruiz']) {
      guests.push(await connectAndTrack<RoomView>(server, { mode: 'guest', pin: host.joined.pin, nickname }));
    }
    await host.state.waitFor((s) => s.players.length === 4, 10_000);

    const hostId = host.joined.playerId;
    host.socket.emit('room:action', {
      type: 'SELECT_GAME',
      actorId: hostId,
      moduleId: 'M8',
      config: { pickWindowMs: PICK_WINDOW_MS, duelSips: 2, stats: ['GOAL_INVOLVEMENTS'] },
    });
    await host.state.waitFor((s) => s.selection?.moduleId === 'M8', 15_000);
    host.socket.emit('room:action', { type: 'START_LOADING', actorId: hostId, stepKeys: ['fixture', 'lineups', 'squads', 'stats'] });
    await host.state.waitFor((s) => s.loading?.steps.every((step) => step.status === 'done') === true, 30_000);
    host.socket.emit('room:action', { type: 'START_SESSION', actorId: hostId });
    const playing = await host.state.waitFor((s) => s.round?.status === 'open', 15_000);
    const roundId = playing.round!.id;
    const options = playing.round!.publicPayload.options.map((o) => o.footballerId);
    for (const id of [DEMBELE, FERRAN, CAMARA, RUIZ]) expect(options).toContain(id);

    // The loop watches the fixture for this stats+events module.
    expect(ingestion.watchedFixtureIds()).toEqual([FIXTURE_ID]);

    const picks: Array<[typeof host, string]> = [
      [host, DEMBELE],
      [guests[0]!, FERRAN],
      [guests[1]!, CAMARA],
      [guests[2]!, RUIZ],
    ];
    for (const [client, footballerId] of picks) {
      client.socket.emit('room:action', {
        type: 'SUBMIT_ANSWER',
        playerId: client.joined.playerId,
        roundId,
        payload: { footballerId },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));

    const roundRecord = async () => (await server.ctx.roomStore.load(roomId as never))!.state.sessions[0]!.rounds[0]!;

    // First poll (kickoff): baseline snapshot received while picks are still open.
    await fake.advance(15_000, idle);
    expect((await roundRecord()).status).toBe('open');
    // Let the pick window close (the engine clock is real time), then play the match out.
    await new Promise((resolve) => setTimeout(resolve, PICK_WINDOW_MS + 1500));
    replay.advanceTo(60);
    await fake.advance(15_000, idle);
    expect((await roundRecord()).status).toBe('open'); // mid-match: nothing settles before the whistle

    // Unchanged snapshots (the provider re-stamps updatedAt each poll) cause no save and no broadcast.
    const store = server.ctx.roomStore;
    const originalSave = store.save.bind(store);
    let saves = 0;
    store.save = async (record) => {
      saves += 1;
      return originalSave(record);
    };
    let broadcasts = 0;
    host.socket.on('room:state', () => {
      broadcasts += 1;
    });
    for (let i = 0; i < 3; i += 1) await fake.advance(15_000, idle);
    store.save = originalSave;
    expect(saves).toBe(0);
    expect(broadcasts).toBe(0);
    replay.advanceTo(replay.status().finalMinute);
    await fake.advance(15_000, idle);

    const final = await host.state.waitFor((s) => s.round?.status === 'resolved', 15_000);
    expect(final.round!.publicPayload.whistle).toBe(true);
    const summary = (await roundRecord()).outcome?.summary as {
      status: string;
      endedBy: string | null;
      championId: string | null;
      duels: unknown[];
    };
    expect(summary).toMatchObject({ status: 'settled', endedBy: 'FULL_TIME', championId: hostId });
    expect(summary.duels).toHaveLength(3);

    const record = await server.ctx.roomStore.load(roomId as never);
    const lost = record!.state.penalties.filter((entry) => entry.reason === 'DUEL_LOST');
    expect(lost).toHaveLength(3);
    expect(lost.some((entry) => entry.recipientId === hostId)).toBe(false);

    // Loop released; more polls change nothing.
    await idle();
    expect(ingestion.watchedFixtureIds()).toEqual([]);
    expect(fake.pending()).toBe(0);
    const penaltiesBefore = record!.state.penalties.length;
    await fake.advance(60_000, idle);
    expect((await server.ctx.roomStore.load(roomId as never))!.state.penalties.length).toBe(penaltiesBefore);

    host.socket.close();
    for (const guest of guests) guest.socket.close();
  }, 120_000);

  it('a client cannot send MATCH_STATS', async () => {
    const created = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ category: 'matchday', fixtureId: FIXTURE_ID, hostNickname: 'H2', settings: { minPlayersToStart: 1 } }),
    });
    const { roomToken } = created.body as { roomToken: string };
    const host = await connectAndTrack<RoomView>(server, { mode: 'reconnect', roomToken });
    const errors: Array<{ code: string }> = [];
    host.socket.on('room:error', (e: { code: string }) => errors.push(e));
    host.socket.emit('room:action', { type: 'MATCH_STATS', fixtureId: FIXTURE_ID, asOf: new Date().toISOString(), playerStats: [], teamStats: [] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(errors.map((e) => e.code)).toEqual(['INVALID_PAYLOAD']);
    host.socket.close();
  }, 30_000);

  it('the API accepts M4 Your Man (selectable, loads, opens a round) and watches its fixture', async () => {
    provider.matchReplay()!.reset(); // the previous test played the match to full time; rounds refuse a finished fixture
    const created = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ category: 'matchday', fixtureId: FIXTURE_ID, hostNickname: 'H4', settings: { minPlayersToStart: 1 } }),
    });
    const { roomToken } = created.body as { roomToken: string };
    const host = await connectAndTrack<RoomView>(server, { mode: 'reconnect', roomToken });
    const hostId = host.joined.playerId;
    host.socket.emit('room:action', { type: 'SELECT_GAME', actorId: hostId, moduleId: 'M4', config: null });
    await host.state.waitFor((s) => s.selection?.moduleId === 'M4', 15_000);
    host.socket.emit('room:action', { type: 'START_LOADING', actorId: hostId, stepKeys: ['fixture', 'lineups', 'squads', 'stats'] });
    await host.state.waitFor((s) => s.loading?.steps.every((step) => step.status === 'done') === true, 30_000);
    host.socket.emit('room:action', { type: 'START_SESSION', actorId: hostId });
    const playing = await host.state.waitFor((s) => s.round !== null, 15_000);
    expect(playing.round).not.toBeNull();
    expect(server.ctx.liveIngestion!.watchedFixtureIds()).toContain(FIXTURE_ID);
    host.socket.close();
  }, 60_000);
});
