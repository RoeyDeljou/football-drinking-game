import type { ProjectedRoom } from '@fdg/game-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestServer } from './helpers.js';
import { connectAndTrack, jsonFetch, startTestServer } from './helpers.js';

/**
 * Regression test for the most serious variant of the silent-failure bug: `createRealtimeGateway`'s
 * 1-second tick loop (apps/api/src/realtime/gateway.ts) previously wrapped its
 * `roomStore.listIds()` / `roomStore.load()` / `dispatchAction(TICK)` round trip in a bare, unawaited
 * `void (async () => {...})()`, with no caller to catch a rejection. A transient failure there — the
 * exact same class this whole pass guards against everywhere else — became an unhandled promise
 * rejection on a `setInterval` callback. Node's *default* behavior for an unhandled rejection is to
 * terminate the process; production installs no `process.on('unhandledRejection', ...)` handler of
 * its own (see the defense-in-depth one added to apps/api/src/index.ts as part of this same fix), so
 * one transient data-layer hiccup in a single room's tick would have crashed the whole server —
 * wiping every live room for every player currently in the app, since `RoomStore` is in-memory. This
 * forces exactly that failure and asserts: (1) it never escapes as an unhandled rejection, and (2)
 * the server keeps serving every other room/action normally afterward — nothing is wedged.
 */
describe('tick loop error handling', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  it('never lets a tick-loop failure become an unhandled rejection, and keeps ticking other rooms', async () => {
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

    // The tick loop calls `roomStore.listIds()` unconditionally every second, before it ever looks
    // at any individual room's phase — this is the same failure surface a transient store/DB hiccup
    // (or, with a future Redis-backed RoomStore, a real network blip) would hit in production.
    const originalListIds = server.ctx.roomStore.listIds.bind(server.ctx.roomStore);
    let failedOnce = false;
    server.ctx.roomStore.listIds = async () => {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error('simulated transient store failure');
      }
      return originalListIds();
    };

    let unhandledRejection: unknown = null;
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejection = reason;
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      // Give the 1-second tick interval time to fire at least twice: once hitting the injected
      // failure, once succeeding again afterward.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    expect(failedOnce).toBe(true);
    expect(unhandledRejection).toBeNull();

    // The server is not wedged: a completely ordinary action still gets a completely ordinary
    // response afterward.
    const selected = host.state.waitFor((state) => state.selection?.moduleId === 'G6', 5_000);
    host.socket.emit('room:action', {
      type: 'SELECT_GAME',
      actorId: hostPlayerId,
      moduleId: 'G6',
      config: null,
    });
    const selectedState = await selected;
    expect(selectedState.selection?.moduleId).toBe('G6');

    host.socket.close();
  }, 30_000);
});
