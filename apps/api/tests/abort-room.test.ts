/**
 * Host-triggered `ABORT_ROOM` — the exact flow the web app's "Delete room" button drives. Confirms
 * the three guarantees a broken implementation here would violate silently: (1) the room's phase
 * actually flips to `aborted` in the store and is pushed to every connected player, (2) a brand new
 * PIN join attempted after that point is rejected with a typed error rather than joining a dead
 * room, and (3) a stray `GET /rooms/:roomId` right after abort (the web still briefly polls this)
 * does not crash — it just reflects the terminal phase.
 *
 * The join-rejection itself is not new gateway logic: `reduceRoom` already rejects every non-`TICK`
 * action against a terminal-phase room with `ROOM_TERMINAL` (packages/game-core/src/reducer.ts,
 * the `isTerminal` guard right before the action switch), and the gateway's socket-auth handshake
 * (`apps/api/src/realtime/gateway.ts`, `authenticate`) already surfaces that rejection as a
 * `connect_error` for both a fresh guest join and a `roomToken` reconnect. This test exists to prove
 * that end-to-end over real sockets, not to add a fix.
 */

import type { ProjectedRoom } from '@fdg/game-core';
import { asRoomId } from '@fdg/game-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestServer } from './helpers.js';
import { connectAndTrack, connectSocket, jsonFetch, startTestServer } from './helpers.js';

describe('ABORT_ROOM (host "delete room")', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  it('flips the room to aborted, broadcasts it to every connected player, and locks the room down', async () => {
    const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ category: 'general', hostNickname: 'Hosty', settings: { minPlayersToStart: 1 } }),
    });
    expect(createRoom.status).toBe(201);
    const { roomToken, roomId, pin, hostPlayerId } = createRoom.body as {
      roomToken: string;
      roomId: string;
      pin: string;
      hostPlayerId: string;
    };

    const host = await connectAndTrack<ProjectedRoom>(server, { mode: 'reconnect', roomToken });
    const guest = await connectAndTrack<ProjectedRoom>(server, { mode: 'guest', pin, nickname: 'Guesty' });
    expect(host.joined.isHost).toBe(true);
    expect(guest.joined.isHost).toBe(false);

    await host.state.waitFor((state) => state.players.length === 2);

    host.socket.emit('room:action', { type: 'ABORT_ROOM', actorId: hostPlayerId, reason: 'HOST_ABORTED' });

    const [hostAborted, guestAborted] = await Promise.all([
      host.state.waitFor((state) => state.phase === 'aborted'),
      guest.state.waitFor((state) => state.phase === 'aborted'),
    ]);
    expect(hostAborted.phase).toBe('aborted');
    expect(guestAborted.phase).toBe('aborted');

    // Store is the source of truth: confirm it independent of the broadcast.
    const stored = await server.ctx.roomStore.load(asRoomId(roomId));
    expect(stored?.state.phase).toBe('aborted');

    // A brand new guest PIN join against the now-aborted room must be rejected, not silently
    // succeed into a dead room and not hang as an unhandled rejection.
    await expect(connectSocket(server, { mode: 'guest', pin, nickname: 'TooLate' })).rejects.toMatchObject({
      message: 'ROOM_TERMINAL',
    });

    // A stray REST poll right after abort (the web briefly polls this post-abort) must not crash —
    // it should just reflect the terminal phase.
    const polled = await jsonFetch(`${server.baseUrl}/rooms/${roomId}`);
    expect(polled.status).toBe(200);
    expect((polled.body as { phase: string }).phase).toBe('aborted');

    const pinLookup = await jsonFetch(`${server.baseUrl}/rooms/pin/${pin}`);
    expect(pinLookup.status).toBe(200);
    expect((pinLookup.body as { phase: string }).phase).toBe('aborted');

    host.socket.close();
    guest.socket.close();
  }, 30_000);

  it('rejects a reconnect attempt (stored roomToken) against an already-aborted room', async () => {
    const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ category: 'general', hostNickname: 'Hosty2', settings: { minPlayersToStart: 1 } }),
    });
    const { roomToken, hostPlayerId } = createRoom.body as { roomToken: string; hostPlayerId: string };

    const host = await connectAndTrack<ProjectedRoom>(server, { mode: 'reconnect', roomToken });
    host.socket.emit('room:action', { type: 'ABORT_ROOM', actorId: hostPlayerId, reason: 'HOST_ABORTED' });
    await host.state.waitFor((state) => state.phase === 'aborted');
    host.socket.close();

    // A fresh reconnect (e.g. the client's persisted roomToken, used after a refresh/relaunch)
    // must be rejected cleanly, not hang and not throw an unhandled rejection.
    await expect(connectSocket(server, { mode: 'reconnect', roomToken })).rejects.toMatchObject({
      message: 'ROOM_TERMINAL',
    });
  }, 30_000);
});
