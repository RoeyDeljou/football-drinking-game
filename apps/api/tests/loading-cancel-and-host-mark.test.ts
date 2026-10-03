/**
 * CANCEL_LOADING (gateway binding + abandoned-run isolation) and HOST_MARK (host vs guest, broadcast, persistence).
 */
import { FixtureProvider, createNodeDataSource } from '@fdg/football-data';
import type { FixtureId } from '@fdg/football-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestServer } from './helpers.js';
import { connectAndTrack, jsonFetch, startTestServer } from './helpers.js';

const FIXTURE_ID = '401915445';
const STEPS = ['fixture', 'lineups', 'squads', 'stats'];

interface RoomView {
  readonly phase: string;
  readonly selection: { moduleId: string } | null;
  readonly loading: { failedReason: string | null; steps: readonly { key: string; status: string }[] } | null;
  readonly round: { id: string; status: string } | null;
  readonly players: readonly { id: string; sips?: number }[];
}

const stepStatus = (s: RoomView, key: string): string | undefined => s.loading?.steps.find((step) => step.key === key)?.status;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const createRoom = async (server: TestServer) => {
  const created = await jsonFetch(`${server.baseUrl}/rooms`, {
    method: 'POST',
    body: JSON.stringify({ category: 'matchday', fixtureId: FIXTURE_ID, hostNickname: 'Host', settings: { minPlayersToStart: 1 } }),
  });
  expect(created.status).toBe(201);
  return created.body as { roomId: string; roomToken: string; pin: string };
};

describe('CANCEL_LOADING and HOST_MARK through the gateway', () => {
  let server: TestServer;
  let provider: FixtureProvider;
  /** Per-call gates for getLineups, consumed in order once `gating` is on. */
  let gating = false;
  let fixtureFail = false;
  const gates: Array<Promise<void>> = [];

  beforeAll(async () => {
    provider = new FixtureProvider({
      dataSource: createNodeDataSource(),
      replay: { fixtureId: FIXTURE_ID, autoStart: false, startMinute: 0 },
    });
    await provider.ready();
    const original = provider.getLineups.bind(provider);
    const originalFixture = provider.getFixture.bind(provider);
    provider.getFixture = async (id: FixtureId) => {
      if (fixtureFail) return { ok: false, error: { kind: 'UPSTREAM', message: 'fixture down', retryable: true }, notes: [] } as never;
      return originalFixture(id);
    };
    provider.getLineups = async (id: FixtureId) => {
      const gate = gating ? gates.shift() : undefined;
      if (gate !== undefined) await gate;
      return original(id);
    };
    server = await startTestServer({ footballData: provider, disableLiveIngestion: true });
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  it('cancel mid-loading, pick another game and load it cleanly: the abandoned run applies nothing', async () => {
    const room = await createRoom(server);
    const host = await connectAndTrack<RoomView>(server, { mode: 'reconnect', roomToken: room.roomToken });
    const hostId = host.joined.playerId;
    const errors: string[] = [];
    host.socket.on('room:error', (e: { code: string }) => errors.push(e.code));

    let release1: () => void = () => undefined;
    let release2: () => void = () => undefined;
    gates.push(new Promise<void>((resolve) => (release1 = resolve)), new Promise<void>((resolve) => (release2 = resolve)));
    gating = true;

    host.socket.emit('room:action', { type: 'SELECT_GAME', actorId: hostId, moduleId: 'M3', config: null });
    await host.state.waitFor((s) => s.selection?.moduleId === 'M3', 15_000);
    host.socket.emit('room:action', { type: 'START_LOADING', actorId: hostId, stepKeys: STEPS });
    await host.state.waitFor((s) => s.phase === 'loading' && stepStatus(s, 'lineups') === 'active', 15_000);

    // Cancel: back to the lobby, selection and loading cleared.
    host.socket.emit('room:action', { type: 'CANCEL_LOADING', actorId: hostId });
    const lobby = await host.state.waitFor((s) => s.phase === 'lobby', 15_000);
    expect(lobby.loading).toBeNull();
    expect(lobby.selection).toBeNull();

    // Pick another game and load it; its lineups call is held on gate 2.
    host.socket.emit('room:action', { type: 'SELECT_GAME', actorId: hostId, moduleId: 'M2', config: null });
    await host.state.waitFor((s) => s.selection?.moduleId === 'M2', 15_000);
    host.socket.emit('room:action', { type: 'START_LOADING', actorId: hostId, stepKeys: STEPS });
    await host.state.waitFor((s) => s.phase === 'loading' && stepStatus(s, 'lineups') === 'active', 15_000);

    // Let the ABANDONED run finish: its progress ('lineups' done, ...) must NOT land in the new run.
    release1();
    await sleep(500);
    expect(stepStatus(host.state.latest()!, 'lineups')).toBe('active');
    expect(host.state.latest()!.loading?.failedReason).toBeNull();

    // The new run completes on its own.
    release2();
    const loaded = await host.state.waitFor((s) => s.loading?.steps.every((step) => step.status === 'done') === true, 15_000);
    expect(loaded.selection?.moduleId).toBe('M2');
    expect(errors.filter((code) => code !== 'WRONG_PHASE')).toEqual([]);
    gating = false;
    host.socket.close();
  }, 60_000);

  it('cancel works from a failed loading (LOADING_FAILED), after which the same game loads cleanly', async () => {
    const room = await createRoom(server);
    const host = await connectAndTrack<RoomView>(server, { mode: 'reconnect', roomToken: room.roomToken });
    const hostId = host.joined.playerId;

    fixtureFail = true;
    host.socket.emit('room:action', { type: 'SELECT_GAME', actorId: hostId, moduleId: 'M3', config: null });
    await host.state.waitFor((s) => s.selection?.moduleId === 'M3', 15_000);
    host.socket.emit('room:action', { type: 'START_LOADING', actorId: hostId, stepKeys: STEPS });
    const failed = await host.state.waitFor((s) => s.loading?.failedReason !== null && s.loading?.failedReason !== undefined, 15_000);
    expect(failed.phase).toBe('loading');

    host.socket.emit('room:action', { type: 'CANCEL_LOADING', actorId: hostId });
    await host.state.waitFor((s) => s.phase === 'lobby', 15_000);

    fixtureFail = false;
    host.socket.emit('room:action', { type: 'SELECT_GAME', actorId: hostId, moduleId: 'M3', config: null });
    await host.state.waitFor((s) => s.selection?.moduleId === 'M3', 15_000);
    host.socket.emit('room:action', { type: 'START_LOADING', actorId: hostId, stepKeys: STEPS });
    const ok = await host.state.waitFor((s) => s.loading?.steps.every((step) => step.status === 'done') === true, 15_000);
    expect(ok.loading?.failedReason).toBeNull();
    host.socket.close();
  }, 60_000);

  it('CANCEL_LOADING is host-only: a guest is refused, and a spoofed actorId is rejected at the gateway', async () => {
    const room = await createRoom(server);
    const host = await connectAndTrack<RoomView>(server, { mode: 'reconnect', roomToken: room.roomToken });
    const guest = await connectAndTrack<RoomView>(server, { mode: 'guest', pin: room.pin, nickname: 'Guest' });
    const hostId = host.joined.playerId;
    const guestErrors: Array<{ code: string }> = [];
    guest.socket.on('room:error', (e: { code: string }) => guestErrors.push(e));
    host.socket.emit('room:action', { type: 'SELECT_GAME', actorId: hostId, moduleId: 'M3', config: null });
    await host.state.waitFor((s) => s.selection?.moduleId === 'M3', 15_000);
    host.socket.emit('room:action', { type: 'START_LOADING', actorId: hostId, stepKeys: STEPS });
    await host.state.waitFor((s) => s.phase === 'loading', 15_000);

    guest.socket.emit('room:action', { type: 'CANCEL_LOADING', actorId: guest.joined.playerId });
    guest.socket.emit('room:action', { type: 'CANCEL_LOADING', actorId: hostId }); // impersonation
    await sleep(400);
    expect(guestErrors.map((e) => e.code).sort()).toEqual(['FORBIDDEN', 'NOT_HOST']);
    expect(host.state.latest()!.phase === 'loading' || host.state.latest()!.phase === 'lobby').toBe(true);
    host.socket.close();
    guest.socket.close();
  }, 60_000);

  it('HOST_MARK: a guest is refused; the host ticking house cells charges penalties that broadcast and persist', async () => {
    provider.matchReplay()!.reset();
    const room = await createRoom(server);
    const host = await connectAndTrack<RoomView>(server, { mode: 'reconnect', roomToken: room.roomToken });
    const guest = await connectAndTrack<RoomView>(server, { mode: 'guest', pin: room.pin, nickname: 'Guest' });
    const hostId = host.joined.playerId;
    const guestErrors: Array<{ code: string }> = [];
    guest.socket.on('room:error', (e: { code: string }) => guestErrors.push(e));
    const houseCells = ['Mourinho rant', 'VAR drama', 'Pundit says "unlucky"', 'Keeper time-wasting', 'Crowd boos', 'Fan on pitch', 'Hairdryer', 'Dive', 'Shirt pull'];
    host.socket.emit('room:action', {
      type: 'SELECT_GAME',
      actorId: hostId,
      moduleId: 'M6',
      config: { size: 3, lineSips: 2, fullHouseSips: 6, houseCells, housePerCard: 9 },
    });
    await host.state.waitFor((s) => s.selection?.moduleId === 'M6', 15_000);
    host.socket.emit('room:action', { type: 'START_LOADING', actorId: hostId, stepKeys: STEPS });
    await host.state.waitFor((s) => s.loading?.steps.every((step) => step.status === 'done') === true, 30_000);
    host.socket.emit('room:action', { type: 'START_SESSION', actorId: hostId });
    const playing = await host.state.waitFor((s) => s.round?.status === 'open', 15_000);
    const roundId = playing.round!.id;

    // Guest cannot mark.
    guest.socket.emit('room:action', { type: 'HOST_MARK', actorId: guest.joined.playerId, roundId, key: 'house:0' });
    await sleep(300);
    expect(guestErrors.map((e) => e.code)).toEqual(['NOT_HOST']);

    // Spoofed actorId never reaches the engine.
    guest.socket.emit('room:action', { type: 'HOST_MARK', actorId: hostId, roundId, key: 'house:0' });
    await sleep(300);
    expect(guestErrors.map((e) => e.code).sort()).toEqual(['FORBIDDEN', 'NOT_HOST']);

    // Host ticks every house cell: lines then the full house charge the table.
    let guestBroadcasts = 0;
    guest.socket.on('room:state', () => {
      guestBroadcasts += 1;
    });
    for (let i = 0; i < 9; i += 1) {
      host.socket.emit('room:action', { type: 'HOST_MARK', actorId: hostId, roundId, key: `house:${String(i)}` });
      await sleep(80);
    }
    await host.state.waitFor((s) => s.round?.status !== 'open', 15_000);
    expect(guestBroadcasts).toBeGreaterThan(0); // marks were broadcast to the other player

    const record = await server.ctx.roomStore.load(room.roomId as never);
    const charged = record!.state.penalties.filter((entry) => entry.reason === 'BINGO_LINE' || entry.reason === 'BINGO_FULL_HOUSE');
    expect(charged.length).toBeGreaterThan(0);
    // Persisted like any dispatch: the resolved round was written to Postgres.
    const rows = await server.ctx.prisma.roundResult.count();
    expect(rows).toBeGreaterThan(0);

    host.socket.close();
    guest.socket.close();
  }, 60_000);
});
