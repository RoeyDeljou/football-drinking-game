/**
 * Regression for a QA-flagged silent failure: the gateway used to swallow a failed `RoomPlayer`
 * upsert with `.catch(() => undefined)` — a joined player could end up missing from the database
 * with zero log output to explain why. It now logs the error (and still lets the realtime join
 * succeed, since the engine — not this row — is the source of truth for who is in the room).
 */

import { asPlayerId, asRoomId, createRoom, MULBERRY32 } from '@fdg/game-core';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestServer } from './helpers.js';
import { connectAndTrack, startTestServer } from './helpers.js';

describe('gateway RoomPlayer persistence failures are logged, not swallowed', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('logs (and does not throw) when a RoomPlayer row cannot be persisted', async () => {
    // A room that exists in the realtime `RoomStore` but was never written to Prisma (`Room` table)
    // — joining it will hit a foreign-key failure on the `RoomPlayer` upsert.
    const roomId = asRoomId(randomUUID());
    const hostPlayerId = asPlayerId(randomUUID());
    const pin = `ORPH${Math.floor(Math.random() * 10)}`.slice(0, 6).padEnd(6, 'X');
    const state = createRoom({
      roomId,
      pin,
      hostPlayerId,
      hostNickname: 'Ghost Host',
      hostIsGuest: true,
      now: Date.now(),
      rngState: MULBERRY32.initialState(1),
    });
    await server.ctx.roomStore.save({ state, meta: { fixtureId: null } });

    const guest = await connectAndTrack(server, { mode: 'guest', pin, nickname: 'Guesty' });
    expect(guest.joined.roomId).toBe(roomId);

    expect(errorSpy).toHaveBeenCalled();
    const loggedSomethingRelevant = errorSpy.mock.calls.some((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('RoomPlayer')),
    );
    expect(loggedSomethingRelevant).toBe(true);

    guest.socket.close();
  }, 30_000);
});
