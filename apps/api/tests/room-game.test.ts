import type { ProjectedRoom, ProjectedRoundRevealed } from '@fdg/game-core';
import type { Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestServer } from './helpers.js';
import { connectAndTrack, jsonFetch, startTestServer, waitForEvent } from './helpers.js';

/** The room's default `roundsPerSession` (see `DEFAULT_ROOM_SETTINGS` in `@fdg/game-core`). */
const ROUNDS_PLANNED = 8;

describe('full room lifecycle over sockets', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  it('plays a complete 8-round G6 Trivia Rush session end to end, with no leak to either player', async () => {
    const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ category: 'general', hostNickname: 'Hosty' }),
    });
    expect(createRoom.status).toBe(201);
    const { pin, roomToken, roomId } = createRoom.body as { pin: string; roomToken: string; roomId: string };

    // The host player already exists from room creation — resume that identity via the room
    // token REST handed back, rather than joining a second time under the same nickname.
    const host = await connectAndTrack<ProjectedRoom>(server, { mode: 'reconnect', roomToken });
    expect(host.joined.isHost).toBe(true);
    const hostSocket = host.socket;
    const hostState = host.state;

    // The no-leak guarantee matters most for a non-host: track their own projection independently
    // of the host's, rather than only ever inspecting what the host happens to see.
    const guest = await connectAndTrack<ProjectedRoom>(server, { mode: 'guest', pin, nickname: 'Guesty' });
    expect(guest.joined.isHost).toBe(false);
    const guestSocket = guest.socket;
    const guestState = guest.state;

    // Both players are visible in the lobby.
    await hostState.waitFor((state) => state.players.length === 2);
    await guestState.waitFor((state) => state.players.length === 2);

    // Host selects G6 Trivia Rush (general, 1+ players, no fixture data required).
    hostSocket.emit('room:action', {
      type: 'SELECT_GAME',
      actorId: host.joined.playerId,
      moduleId: 'G6',
      config: null,
    });
    await hostState.waitFor((state) => state.selection?.moduleId === 'G6');

    // A non-host trying a host-only action is rejected.
    const forbidden = waitForEvent<{ code: string }>(guestSocket, 'room:error');
    guestSocket.emit('room:action', { type: 'START_LOADING', actorId: guest.joined.playerId, stepKeys: ['general'] });
    const forbiddenError = await forbidden;
    expect(forbiddenError.code).toBe('NOT_HOST');

    hostSocket.emit('room:action', {
      type: 'START_LOADING',
      actorId: host.joined.playerId,
      stepKeys: ['general'],
    });
    await hostState.waitFor(
      (state) => state.loading?.steps.every((step) => step.status === 'done') === true,
      15_000,
    );

    hostSocket.emit('room:action', { type: 'START_SESSION', actorId: host.joined.playerId });
    let playingState = await hostState.waitFor((state) => state.phase === 'playing', 15_000);
    let guestPlayingState = await guestState.waitFor((state) => state.phase === 'playing', 15_000);

    const seenRoundIds = new Set<string>();

    const assertPreReveal = (state: ProjectedRoom): void => {
      expect(state.round).not.toBeNull();
      expect(state.round?.visibility).toBe('pre-reveal');
      if (state.round?.visibility === 'pre-reveal') {
        // Structurally impossible to see a solution or rival submissions before reveal (see
        // ProjectedRoundPreReveal — those keys do not exist on this member of the union at all).
        expect('solution' in state.round).toBe(false);
        expect('submissions' in state.round).toBe(false);
        expect('outcome' in state.round).toBe(false);
      }
    };

    const submitAnswer = (socket: ClientSocket, playerId: string, roundId: string, optionId: string): void => {
      socket.emit('room:action', { type: 'SUBMIT_ANSWER', playerId, roundId, payload: { optionId } });
    };

    for (let roundNumber = 1; roundNumber <= ROUNDS_PLANNED; roundNumber += 1) {
      expect(playingState.phase).toBe('playing');
      assertPreReveal(playingState);
      // The guest's own live projection must be equally leak-free, not just the host's.
      expect(guestPlayingState.round?.id).toBe(playingState.round?.id);
      assertPreReveal(guestPlayingState);

      const roundId = playingState.round!.id;
      expect(seenRoundIds.has(roundId)).toBe(false);
      seenRoundIds.add(roundId);

      const publicPayload = playingState.round!.publicPayload as { options: { id: string }[] };
      const chosenOptionId = publicPayload.options[0]!.id;

      submitAnswer(hostSocket, host.joined.playerId, roundId, chosenOptionId);
      submitAnswer(guestSocket, guest.joined.playerId, roundId, chosenOptionId);

      const revealedHost = await hostState.waitFor((state) => state.round?.status === 'resolved', 15_000);
      const revealedGuest = await guestState.waitFor((state) => state.round?.status === 'resolved', 15_000);

      for (const revealed of [revealedHost, revealedGuest]) {
        expect(revealed.round?.visibility).toBe('revealed');
        if (revealed.round?.visibility === 'revealed') {
          const round = revealed.round as ProjectedRoundRevealed;
          expect(round.solution).not.toBeNull();
          expect(round.submissions.length).toBe(2);
        }
      }

      // roundReveal -> intermission. On the final round this is also where the engine marks the
      // session finished (see `reduceRoom`'s ADVANCE case) — no second ADVANCE follows it.
      hostSocket.emit('room:action', { type: 'ADVANCE', actorId: host.joined.playerId });
      await hostState.waitFor((state) => state.phase === 'intermission', 15_000);
      await guestState.waitFor((state) => state.phase === 'intermission', 15_000);

      if (roundNumber < ROUNDS_PLANNED) {
        // intermission -> playing, next round.
        hostSocket.emit('room:action', { type: 'ADVANCE', actorId: host.joined.playerId });
        playingState = await hostState.waitFor(
          (state) => state.phase === 'playing' && state.round?.id !== roundId,
          15_000,
        );
        guestPlayingState = await guestState.waitFor(
          (state) => state.phase === 'playing' && state.round?.id !== roundId,
          15_000,
        );
      }
    }

    expect(seenRoundIds.size).toBe(ROUNDS_PLANNED);

    const sessionRow = await server.ctx.prisma.gameSession.findFirst({ where: { roomId } });
    expect(sessionRow).not.toBeNull();
    expect(sessionRow?.finishedAt).not.toBeNull();

    const roundResults = await server.ctx.prisma.roundResult.findMany({
      where: { gameSessionId: sessionRow!.id },
    });
    expect(roundResults.length).toBe(ROUNDS_PLANNED);
    expect(new Set(roundResults.map((row) => row.id)).size).toBe(ROUNDS_PLANNED);

    hostSocket.emit('room:action', { type: 'FINISH_ROOM', actorId: host.joined.playerId });
    const finished = await hostState.waitFor((state) => state.phase === 'finished', 15_000);
    expect(finished.phase).toBe('finished');

    const roomRow = await server.ctx.prisma.room.findUnique({ where: { id: roomId } });
    expect(roomRow?.status).toBe('finished');
    expect(roomRow?.finishedAt).not.toBeNull();

    hostSocket.close();
    guestSocket.close();
  }, 60_000);
});
