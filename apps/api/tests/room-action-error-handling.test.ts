import type { ProjectedRoom } from '@fdg/game-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import type { TestServer } from './helpers.js';
import { connectAndTrack, jsonFetch, startTestServer, waitForEvent } from './helpers.js';

/**
 * Regression test for the production bug: "SELECT_GAME silently does nothing — no room:state, no
 * room:error, nothing". The trigger in production is any transient failure inside the
 * load -> reduce -> save round trip `dispatchAction` runs (a Postgres hiccup, a cold connection
 * pool on Render's free tier, a football-data fetch error, etc.) — but the *bug* is that
 * `apps/api/src/realtime/gateway.ts`'s `room:action`/`room:leave`/`disconnect` handlers, and the
 * `io.use` auth middleware's `reconnect` branch, never catch a thrown/rejected `dispatchAction`.
 * An exception there becomes an unhandled promise rejection instead of a `room:error` — the client
 * is left in total silence with no way to know its action was lost. This test forces exactly that
 * failure (a `RoomStore.save` rejection mid-dispatch) and asserts the client still gets *something*
 * back, instead of silence.
 */
describe('room:action error handling', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  it('emits room:error instead of silently dropping the action when the dispatch round trip throws', async () => {
    const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({
        category: 'general',
        hostNickname: 'Hosty',
        settings: { minPlayersToStart: 1 },
      }),
    });
    expect(createRoom.status).toBe(201);
    const { roomToken, hostPlayerId } = createRoom.body as { roomToken: string; hostPlayerId: string };

    const host = await connectAndTrack<ProjectedRoom>(server, { mode: 'reconnect', roomToken });
    expect(host.joined.isHost).toBe(true);

    // Force exactly one failure inside the same load -> reduce -> save round trip dispatchAction
    // runs for every action, the way a transient Postgres/Redis hiccup would in production.
    const originalSave = server.ctx.roomStore.save.bind(server.ctx.roomStore);
    let failedOnce = false;
    server.ctx.roomStore.save = async (record) => {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error('simulated transient store failure');
      }
      return originalSave(record);
    };

    const errorOrState = Promise.race([
      host.state.waitFor((state) => state.selection?.moduleId === 'G6', 5_000).then((state) => ({
        kind: 'state' as const,
        state,
      })),
      waitForEvent<{ code: string }>(host.socket, 'room:error').then((error) => ({
        kind: 'error' as const,
        error,
      })),
    ]);

    host.socket.emit('room:action', {
      type: 'SELECT_GAME',
      actorId: hostPlayerId,
      moduleId: 'G6',
      config: null,
    });

    // The failing dispatch must not vanish into silence: the client gets a room:error for it.
    const result = await errorOrState;
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.error.code).toBe('INTERNAL_ERROR');

    // The room is not wedged afterwards — a retried action succeeds normally.
    const retried = host.state.waitFor((state) => state.selection?.moduleId === 'G6', 5_000);
    host.socket.emit('room:action', {
      type: 'SELECT_GAME',
      actorId: hostPlayerId,
      moduleId: 'G6',
      config: null,
    });
    const retriedState = await retried;
    expect(retriedState.selection?.moduleId).toBe('G6');

    host.socket.close();
  }, 30_000);

  it('emits room:error when the real production trigger fires: ctx.generalDataset() throwing', async () => {
    // RoomStore.save can never actually throw today (InMemoryRoomStore is a plain Map) — the test
    // above is a forward-looking simulation of the future Redis-backed store. This is the trigger QA
    // used to independently reproduce the original bug against a real deployment: a data-layer
    // hiccup surfacing from apps/api/src/engine/data-context.ts's `ctx.generalDataset()` call,
    // reached from `buildEngineDeps` on every dispatch once a room has a 'general' selection —
    // including the very SELECT_GAME dispatch that sets it.
    const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({
        category: 'general',
        hostNickname: 'Hosty2',
        settings: { minPlayersToStart: 1 },
      }),
    });
    expect(createRoom.status).toBe(201);
    const { roomToken, hostPlayerId } = createRoom.body as { roomToken: string; hostPlayerId: string };

    const host = await connectAndTrack<ProjectedRoom>(server, { mode: 'reconnect', roomToken });
    expect(host.joined.isHost).toBe(true);

    const mutableCtx = server.ctx as { generalDataset: AppContext['generalDataset'] };
    const originalGeneralDataset = mutableCtx.generalDataset.bind(server.ctx);
    let failedOnce = false;
    mutableCtx.generalDataset = async () => {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error('simulated data-layer failure');
      }
      return originalGeneralDataset();
    };

    const errorOrState = Promise.race([
      host.state.waitFor((state) => state.selection?.moduleId === 'G6', 5_000).then((state) => ({
        kind: 'state' as const,
        state,
      })),
      waitForEvent<{ code: string }>(host.socket, 'room:error').then((error) => ({
        kind: 'error' as const,
        error,
      })),
    ]);

    host.socket.emit('room:action', {
      type: 'SELECT_GAME',
      actorId: hostPlayerId,
      moduleId: 'G6',
      config: null,
    });

    const result = await errorOrState;
    expect(result.kind).toBe('error');

    const retried = host.state.waitFor((state) => state.selection?.moduleId === 'G6', 5_000);
    host.socket.emit('room:action', {
      type: 'SELECT_GAME',
      actorId: hostPlayerId,
      moduleId: 'G6',
      config: null,
    });
    expect((await retried).selection?.moduleId).toBe('G6');

    host.socket.close();
  }, 30_000);
});
