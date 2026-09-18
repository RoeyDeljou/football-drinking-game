/**
 * Regression for a QA-flagged persistence gap: `FINISH_ROOM` (and `ABORT_ROOM`) close out the
 * active session's `finishedAt` inside the engine's own state, but only ever emit
 * `ROOM_FINISHED`/`ROOM_ABORTED` — never a separate `SESSION_FINISHED` event. Before the fix,
 * `persistence/results.ts` only stamped `GameSession.finishedAt` in the `SESSION_FINISHED` handler,
 * so a session closed out by ending the room (rather than by playing its last round) kept
 * `finishedAt: null` in the database forever, even though the room itself was terminal.
 */

import type { ProjectedRoom } from '@fdg/game-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestServer } from './helpers.js';
import { connectAndTrack, jsonFetch, startTestServer } from './helpers.js';

describe('FINISH_ROOM closes out the active session in the database', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  it('stamps GameSession.finishedAt even when the room is finished mid-session', async () => {
    const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ category: 'general', hostNickname: 'Hosty', settings: { minPlayersToStart: 1 } }),
    });
    const { roomToken, roomId } = createRoom.body as { roomToken: string; roomId: string };

    const host = await connectAndTrack<ProjectedRoom>(server, { mode: 'reconnect', roomToken });
    const hostSocket = host.socket;
    const hostState = host.state;

    hostSocket.emit('room:action', { type: 'SELECT_GAME', actorId: host.joined.playerId, moduleId: 'G6', config: null });
    await hostState.waitFor((state) => state.selection?.moduleId === 'G6');
    hostSocket.emit('room:action', { type: 'START_LOADING', actorId: host.joined.playerId, stepKeys: ['general'] });
    await hostState.waitFor((state) => state.loading?.steps.every((s) => s.status === 'done') === true, 15_000);
    hostSocket.emit('room:action', { type: 'START_SESSION', actorId: host.joined.playerId });
    const playing = await hostState.waitFor((state) => state.phase === 'playing', 15_000);
    expect(playing.session).not.toBeNull();

    // End the room *without* ever finishing the 8-round session — round 1 of 8 is still open.
    hostSocket.emit('room:action', { type: 'FINISH_ROOM', actorId: host.joined.playerId });
    await hostState.waitFor((state) => state.phase === 'finished', 15_000);

    const sessionRow = await server.ctx.prisma.gameSession.findFirst({ where: { roomId } });
    expect(sessionRow).not.toBeNull();
    expect(sessionRow?.finishedAt).not.toBeNull();

    hostSocket.close();
  }, 30_000);
});
