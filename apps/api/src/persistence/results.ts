/**
 * Durable writes. Realtime room state stays in `RoomStore`; this module is the only place that
 * turns engine events into Postgres/SQLite rows — game sessions, round results and cumulative
 * player stats, all written once a round/session/room genuinely finishes.
 */

import type { EngineEvent, RoomState, SessionState } from '@fdg/game-core';
import { activeSession, currentRound } from '@fdg/game-core';
import type { PrismaClient } from '../db/client.js';

const findSessionByRoundId = (room: RoomState, roundId: string): SessionState | undefined =>
  room.sessions.find((session) => session.rounds.some((round) => round.id === roundId));

/** Call after every accepted dispatch with the *resulting* room state and the events it produced. */
export const persistEngineEvents = async (
  prisma: PrismaClient,
  room: RoomState,
  events: readonly EngineEvent[],
): Promise<void> => {
  for (const event of events) {
    switch (event.type) {
      case 'SESSION_STARTED': {
        const session = activeSession(room);
        if (session === undefined) break;
        await prisma.gameSession.upsert({
          where: { id: event.sessionId },
          create: {
            id: event.sessionId,
            roomId: room.id,
            moduleId: session.moduleId,
            category: session.category,
            roundsPlanned: session.roundsPlanned,
            startedAt: new Date(session.startedAt),
          },
          update: {},
        });
        break;
      }

      case 'ROUND_REVEALED': {
        const session = findSessionByRoundId(room, event.roundId);
        const round = currentRound(room);
        if (session === undefined || round === undefined || round.id !== event.roundId) break;
        await prisma.roundResult.upsert({
          where: { id: round.id },
          create: {
            id: round.id,
            gameSessionId: session.id,
            roundIndex: round.index,
            moduleId: round.moduleId,
            engineRoundId: round.id,
            outcome: JSON.parse(JSON.stringify(round.outcome ?? null)) as object,
          },
          update: {
            outcome: JSON.parse(JSON.stringify(round.outcome ?? null)) as object,
          },
        });
        break;
      }

      case 'SESSION_FINISHED': {
        const session = room.sessions.find((entry) => entry.id === event.sessionId);
        await prisma.gameSession.updateMany({
          where: { id: event.sessionId },
          data: { finishedAt: session?.finishedAt === null || session?.finishedAt === undefined
            ? new Date()
            : new Date(session.finishedAt) },
        });
        break;
      }

      case 'ROOM_FINISHED':
      case 'ROOM_ABORTED': {
        await prisma.room.updateMany({
          where: { id: room.id },
          data: { status: room.phase, finishedAt: new Date(room.updatedAt) },
        });
        // FINISH_ROOM (and ABORT_ROOM) close out the active session's `finishedAt` inside the
        // engine's own state — see `reduceRoom`'s FINISH_ROOM/ABORT_ROOM cases — but emit only
        // ROOM_FINISHED/ROOM_ABORTED, never a separate SESSION_FINISHED event. Without this, a
        // session ended by closing the room (rather than by playing out its last round) would keep
        // `GameSession.finishedAt` null forever, even though the room itself is terminal.
        await closeOutFinishedSessions(prisma, room);
        await syncRoomPlayers(prisma, room);
        await syncPlayerStats(prisma, room);
        break;
      }

      default:
        break;
    }
  }
};

/** Stamp `finishedAt` on any session the engine now considers finished but whose `GameSession` row
 * is still open — covers the case where the session ended as a side effect of the room closing. */
const closeOutFinishedSessions = async (prisma: PrismaClient, room: RoomState): Promise<void> => {
  for (const session of room.sessions) {
    if (session.finishedAt === null) continue;
    await prisma.gameSession.updateMany({
      where: { id: session.id, finishedAt: null },
      data: { finishedAt: new Date(session.finishedAt) },
    });
  }
};

/** Snapshot every player's final score/sips into `RoomPlayer` once the room ends. */
const syncRoomPlayers = async (prisma: PrismaClient, room: RoomState): Promise<void> => {
  for (const player of room.players) {
    await prisma.roomPlayer.updateMany({
      where: { roomId: room.id, engagementPlayerId: player.id },
      data: {
        finalScore: player.score,
        finalSips: player.sips,
        ...(player.leftAt === null ? {} : { leftAt: new Date(player.leftAt) }),
      },
    });
  }
};

/** Roll a finished room's numbers into each registered player's cumulative `PlayerStat`. */
const syncPlayerStats = async (prisma: PrismaClient, room: RoomState): Promise<void> => {
  const roomPlayers = await prisma.roomPlayer.findMany({
    where: { roomId: room.id, userId: { not: null } },
  });
  const roundsPlayed = room.sessions.reduce((total, session) => total + session.rounds.length, 0);

  for (const roomPlayer of roomPlayers) {
    if (roomPlayer.userId === null) continue;
    const player = room.players.find((entry) => entry.id === roomPlayer.engagementPlayerId);
    if (player === undefined) continue;

    await prisma.playerStat.upsert({
      where: { userId: roomPlayer.userId },
      create: {
        userId: roomPlayer.userId,
        roomsPlayed: 1,
        roundsPlayed,
        totalScore: player.score,
        totalSips: player.sips,
        correctAnswers: player.correctAnswers,
        roundsWon: player.roundsWon,
      },
      update: {
        roomsPlayed: { increment: 1 },
        roundsPlayed: { increment: roundsPlayed },
        totalScore: { increment: player.score },
        totalSips: { increment: player.sips },
        correctAnswers: { increment: player.correctAnswers },
        roundsWon: { increment: player.roundsWon },
      },
    });
  }
};
