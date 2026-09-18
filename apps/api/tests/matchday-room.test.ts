import type { ProjectedRoom } from '@fdg/game-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestServer } from './helpers.js';
import { connectAndTrack, jsonFetch, startTestServer } from './helpers.js';

/** The recorded PSG 6-1 Slovan Bratislava (UEFA Champions League) timeline shipped with
 * @fdg/football-data — see packages/football-data/README.md. */
const REPLAYABLE_FIXTURE_ID = '401915445';

describe('matchday room (fixture provider)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  it('prefetches real fixture data, generates an M3 Shirt Number round, and resolves a real submission', async () => {
    const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({
        category: 'matchday',
        fixtureId: REPLAYABLE_FIXTURE_ID,
        hostNickname: 'Hosty',
        settings: { minPlayersToStart: 1 },
      }),
    });
    expect(createRoom.status).toBe(201);
    const { roomToken } = createRoom.body as { roomToken: string };

    const host = await connectAndTrack<ProjectedRoom>(server, { mode: 'reconnect', roomToken });
    const hostSocket = host.socket;
    const hostState = host.state;

    hostSocket.emit('room:action', {
      type: 'SELECT_GAME',
      actorId: host.joined.playerId,
      moduleId: 'M3',
      config: null,
    });
    const selected = await hostState.waitFor((state) => state.selection?.moduleId === 'M3', 15_000);
    expect(selected.selection?.moduleId).toBe('M3');

    hostSocket.emit('room:action', {
      type: 'START_LOADING',
      actorId: host.joined.playerId,
      stepKeys: ['fixture', 'lineups', 'squads', 'stats'],
    });
    // Every step must genuinely succeed — a 'failed' step passing this assertion would hide a real
    // prefetch failure (a `status === 'done' || 'failed'` check, which the room-game gate flagged,
    // would let a totally broken fetch look like a pass).
    const loaded = await hostState.waitFor(
      (state) => state.loading?.steps.every((step) => step.status === 'done' || step.status === 'failed') === true,
      30_000,
    );
    for (const step of loaded.loading?.steps ?? []) {
      expect(step.status).toBe('done');
    }

    hostSocket.emit('room:action', { type: 'START_SESSION', actorId: host.joined.playerId });
    const playing = await hostState.waitFor((state) => state.phase === 'playing', 15_000);
    expect(playing.round).not.toBeNull();
    expect(playing.round?.moduleId).toBe('M3');
    expect(playing.round?.visibility).toBe('pre-reveal');

    const roundId = playing.round!.id;
    hostSocket.emit('room:action', {
      type: 'SUBMIT_ANSWER',
      playerId: host.joined.playerId,
      roundId,
      payload: { guess: 7 },
    });

    // Solo room: the one submission satisfies `everyoneSubmitted`, auto-locking and revealing.
    const revealed = await hostState.waitFor((state) => state.round?.status === 'resolved', 15_000);
    expect(revealed.round?.visibility).toBe('revealed');
    if (revealed.round?.visibility === 'revealed') {
      expect(revealed.round.solution).not.toBeNull();
      expect(revealed.round.submissions.length).toBe(1);
    }

    hostSocket.close();
  }, 60_000);
});
