import type { ProjectedRoom } from '@fdg/game-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestServer } from './helpers.js';
import { connectAndTrack, jsonFetch, startTestServer, waitForEvent } from './helpers.js';

/**
 * Exact repro from the production bug report: create a room, connect+resume once, disconnect that
 * socket, wait, reconnect with the same room token, then send a host action.
 *
 * This is NOT a regression guard for the fix in room-action-error-handling.test.ts /
 * tick-loop-error-handling.test.ts / loading-pipeline-error-handling.test.ts — it passes identically
 * with or without that fix, on both the pre-fix and post-fix gateway.ts, against a real Postgres
 * instance. It exists to disprove the theory (from the original bug report) that the
 * disconnect/reconnect sequence itself races the presence map or the per-room dispatch queue: it
 * doesn't, at least not deterministically, and this end-to-end coverage is worth keeping regardless
 * as the only test that actually exercises disconnect -> reconnect -> act over real sockets. The
 * real root cause — unguarded fire-and-forget async work swallowing exceptions as unhandled
 * rejections instead of surfacing them to the client — is what the other three tests guard.
 */
describe('reconnect then act (production repro)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  it('responds to a room:action sent right after a disconnect/reconnect cycle', async () => {
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

    const first = await connectAndTrack<ProjectedRoom>(server, { mode: 'reconnect', roomToken });
    expect(first.joined.isHost).toBe(true);
    const tokenAfterFirst = first.joined.roomToken;

    first.socket.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 500));

    const second = await connectAndTrack<ProjectedRoom>(server, {
      mode: 'reconnect',
      roomToken: tokenAfterFirst,
    });
    expect(second.joined.playerId).toBe(hostPlayerId);

    const nextState = second.state.waitFor((state) => state.selection?.moduleId === 'G6', 5_000);
    const errorOrState = Promise.race([
      nextState.then((state) => ({ kind: 'state' as const, state })),
      waitForEvent<{ code: string }>(second.socket, 'room:error').then((error) => ({
        kind: 'error' as const,
        error,
      })),
    ]);

    second.socket.emit('room:action', {
      type: 'SELECT_GAME',
      actorId: hostPlayerId,
      moduleId: 'G6',
      config: null,
    });

    const result = await errorOrState;
    expect(result.kind).toBe('state');
    if (result.kind === 'state') {
      expect(result.state.selection?.moduleId).toBe('G6');
    }

    second.socket.close();
  }, 30_000);
});
