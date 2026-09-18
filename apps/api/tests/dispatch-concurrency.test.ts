/**
 * Regression for the QA-reported race: two concurrent `dispatchAction` calls for the same room,
 * each starting from their own `load()`, could interleave load -> reduce -> save so that the
 * second `save()` silently overwrote the first dispatch's effect (reproduced directly: two
 * concurrent `SUBMIT_ANSWER`s lost one of the two submissions). `dispatchAction` now owns the
 * whole round trip and serializes every call for a given room through one queue — this test drives
 * `dispatchAction` directly (bypassing the socket transport entirely) to prove the fix at the
 * layer QA actually broke, not just "the two players happened not to race over the network".
 */

import type { ProjectedRoom, RoomAction } from '@fdg/game-core';
import { asPlayerId, asRoomId, asRoundId } from '@fdg/game-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchAction } from '../src/engine/dispatch.js';
import type { TestServer } from './helpers.js';
import { connectAndTrack, jsonFetch, startTestServer } from './helpers.js';

describe('dispatchAction concurrency', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  it('never drops a submission when two dispatches for the same room race', async () => {
    const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ category: 'general', hostNickname: 'Hosty' }),
    });
    const { pin, roomToken, roomId } = createRoom.body as { pin: string; roomToken: string; roomId: string };

    const host = await connectAndTrack<ProjectedRoom>(server, { mode: 'reconnect', roomToken });
    const guest = await connectAndTrack<ProjectedRoom>(server, { mode: 'guest', pin, nickname: 'Guesty' });
    await host.state.waitFor((state) => state.players.length === 2);

    host.socket.emit('room:action', { type: 'SELECT_GAME', actorId: host.joined.playerId, moduleId: 'G6', config: null });
    await host.state.waitFor((state) => state.selection?.moduleId === 'G6');
    host.socket.emit('room:action', { type: 'START_LOADING', actorId: host.joined.playerId, stepKeys: ['general'] });
    await host.state.waitFor((state) => state.loading?.steps.every((s) => s.status === 'done') === true, 15_000);
    host.socket.emit('room:action', { type: 'START_SESSION', actorId: host.joined.playerId });
    const playing = await host.state.waitFor((state) => state.phase === 'playing', 15_000);

    const roundId = playing.round!.id;
    const publicPayload = playing.round!.publicPayload as { options: { id: string }[] };
    const optionId = publicPayload.options[0]!.id;

    const brandedRoomId = asRoomId(roomId);
    const brandedRoundId = asRoundId(roundId);
    const submitFor = (playerId: string): RoomAction => ({
      type: 'SUBMIT_ANSWER',
      playerId: asPlayerId(playerId),
      roundId: brandedRoundId,
      payload: { optionId },
    });

    // Fire both dispatches truly concurrently — no `await` between them — exactly the scenario
    // that lost a submission before `dispatchAction` serialized per room.
    const [outcomeA, outcomeB] = await Promise.all([
      dispatchAction(server.ctx, brandedRoomId, submitFor(host.joined.playerId)),
      dispatchAction(server.ctx, brandedRoomId, submitFor(guest.joined.playerId)),
    ]);

    expect(outcomeA).not.toBeNull();
    expect(outcomeB).not.toBeNull();
    expect(outcomeA?.rejection).toBeNull();
    expect(outcomeB?.rejection).toBeNull();

    const finalRecord = await server.ctx.roomStore.load(brandedRoomId);
    const finalRound = finalRecord?.state.sessions.at(-1)?.rounds.find((round) => round.id === roundId);
    expect(finalRound).toBeDefined();
    expect(finalRound?.submissions.length).toBe(2);
    const submitterIds = new Set<string>(finalRound?.submissions.map((submission) => submission.playerId));
    expect(submitterIds.has(host.joined.playerId)).toBe(true);
    expect(submitterIds.has(guest.joined.playerId)).toBe(true);

    host.socket.close();
    guest.socket.close();
  }, 30_000);
});
