import type { ProjectedRoom } from '@fdg/game-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestServer } from './helpers.js';
import { connectAndTrack, connectSocket, jsonFetch, startTestServer } from './helpers.js';

describe('reconnect', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  it('restores a disconnected guest into their room and current phase', async () => {
    const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ category: 'general', hostNickname: 'Hosty' }),
    });
    const { pin, roomToken: hostRoomToken } = createRoom.body as { pin: string; roomToken: string };
    const host = await connectAndTrack<ProjectedRoom>(server, { mode: 'reconnect', roomToken: hostRoomToken });
    const hostSocket = host.socket;
    const hostState = host.state;

    const guest = await connectAndTrack<ProjectedRoom>(server, { mode: 'guest', pin, nickname: 'Guesty' });
    const guestJoined = guest.joined;
    await hostState.waitFor((state) => state.players.length === 2);
    expect(hostState.latest()?.players.find((p) => p.id === guestJoined.playerId)?.connected).toBe(true);

    // Simulate a dropped connection (not a voluntary leave).
    guest.socket.close();
    await hostState.waitFor(
      (state) => state.players.find((p) => p.id === guestJoined.playerId)?.connected === false,
      10_000,
    );

    // Resume with the room token the guest received on first join.
    const resumed = await connectAndTrack<ProjectedRoom>(server, {
      mode: 'reconnect',
      roomToken: guestJoined.roomToken,
    });
    expect(resumed.joined.playerId).toBe(guestJoined.playerId);
    expect(resumed.joined.roomId).toBe(host.joined.roomId);

    await hostState.waitFor(
      (state) => state.players.find((p) => p.id === guestJoined.playerId)?.connected === true,
      10_000,
    );

    // An invalid/expired room token is refused.
    await expect(connectSocket(server, { mode: 'reconnect', roomToken: 'not-a-real-token' })).rejects.toBeTruthy();

    hostSocket.close();
    resumed.socket.close();
  }, 30_000);
});
