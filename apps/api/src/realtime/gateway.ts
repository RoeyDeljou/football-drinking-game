/**
 * The Socket.IO gateway: join by PIN (guest or user) or resume with a room token, lobby presence,
 * host controls, submitting answers, and reconnect — all funneled through `dispatchAction` so the
 * engine is the only place game rules ever run.
 */

import { randomUUID } from 'node:crypto';
import type { PlayerId, RoomAction, RoomId } from '@fdg/game-core';
import { asPlayerId, parseClientAction } from '@fdg/game-core';
import type { Server, Socket } from 'socket.io';
import type { AppContext } from '../context.js';
import { dispatchAction, projectRoom } from '../engine/dispatch.js';
import type { RoomRecord } from '../rooms/store.js';
import { runLoadingPipeline } from './loading.js';
import { signRoomToken, verifyRoomToken } from './room-token.js';
import { GATEWAY_RESERVED_ACTION_TYPES, socketAuthSchema } from './schemas.js';

interface SocketIdentity {
  readonly roomId: RoomId;
  readonly playerId: PlayerId;
  readonly nickname: string;
  readonly isGuest: boolean;
  readonly userId: string | null;
}

declare module 'socket.io' {
  interface Socket {
    fdg?: SocketIdentity;
  }
}

/** Every action a client is allowed to originate (after `GATEWAY_RESERVED_ACTION_TYPES` is
 * filtered out) carries either `actorId` (host-only actions) or `playerId` (`SUBMIT_ANSWER`) —
 * the only two identity fields the gateway ever needs to bind to the authenticated socket. */
const actorOf = (action: RoomAction): PlayerId | null => {
  switch (action.type) {
    case 'TRANSFER_HOST':
    case 'KICK_PLAYER':
    case 'UPDATE_SETTINGS':
    case 'SELECT_GAME':
    case 'START_LOADING':
    case 'START_SESSION':
    case 'ADVANCE':
    case 'END_SESSION':
    case 'FINISH_ROOM':
    case 'LOCK_ROUND':
    case 'REVEAL_ROUND':
    case 'ABORT_ROOM':
      return action.actorId;
    case 'SUBMIT_ANSWER':
      return action.playerId;
    default:
      return null;
  }
};

export interface RealtimeGateway {
  close(): void;
}

export const createRealtimeGateway = (io: Server, ctx: AppContext): RealtimeGateway => {
  /** roomId -> playerId -> socket ids, so a reconnect/second tab is handled gracefully. */
  const presence = new Map<RoomId, Map<PlayerId, Set<string>>>();

  const trackSocket = (roomId: RoomId, playerId: PlayerId, socketId: string): void => {
    let byPlayer = presence.get(roomId);
    if (byPlayer === undefined) {
      byPlayer = new Map();
      presence.set(roomId, byPlayer);
    }
    let sockets = byPlayer.get(playerId);
    if (sockets === undefined) {
      sockets = new Set();
      byPlayer.set(playerId, sockets);
    }
    sockets.add(socketId);
  };

  const untrackSocket = (roomId: RoomId, playerId: PlayerId, socketId: string): boolean => {
    const byPlayer = presence.get(roomId);
    const sockets = byPlayer?.get(playerId);
    if (sockets === undefined) return true;
    sockets.delete(socketId);
    const empty = sockets.size === 0;
    if (empty) byPlayer?.delete(playerId);
    return empty;
  };

  /** Every currently-tracked socket id for a player, so a kick can force-disconnect them. */
  const socketIdsFor = (roomId: RoomId, playerId: PlayerId): readonly string[] => {
    const sockets = presence.get(roomId)?.get(playerId);
    return sockets === undefined ? [] : [...sockets];
  };

  const broadcastFromRecord = (record: RoomRecord): void => {
    const { projections } = projectRoom(record);
    const byPlayer = presence.get(record.state.id);
    if (byPlayer === undefined) return;
    for (const [playerId, socketIds] of byPlayer.entries()) {
      const projection = projections.get(playerId);
      if (projection === undefined) continue;
      for (const socketId of socketIds) {
        io.to(socketId).emit('room:state', projection);
      }
    }
  };

  io.use((socket, next) => {
    void (async (): Promise<void> => {
      const parsedAuth = socketAuthSchema.safeParse(socket.handshake.auth);
      if (!parsedAuth.success) {
        next(new Error('INVALID_AUTH'));
        return;
      }
      const auth = parsedAuth.data;

      if (auth.mode === 'reconnect') {
        const claims = await verifyRoomToken(auth.roomToken, ctx.roomTokenSecret);
        if (claims === null) {
          next(new Error('INVALID_ROOM_TOKEN'));
          return;
        }
        const outcome = await dispatchAction(ctx, claims.roomId, {
          type: 'PLAYER_RECONNECTED',
          playerId: claims.playerId,
        });
        if (outcome === null) {
          next(new Error('ROOM_NOT_FOUND'));
          return;
        }
        if (outcome.rejection !== null) {
          next(new Error(outcome.rejection.code));
          return;
        }
        socket.fdg = {
          roomId: claims.roomId,
          playerId: claims.playerId,
          nickname: claims.nickname,
          isGuest: claims.isGuest,
          userId: claims.userId,
        };
        next();
        return;
      }

      const existingRoom = await ctx.roomStore.findByPin(auth.pin);
      if (existingRoom === null) {
        next(new Error('ROOM_NOT_FOUND'));
        return;
      }
      const roomId = existingRoom.state.id;

      let nickname: string;
      let isGuest: boolean;
      let userId: string | null;
      if (auth.mode === 'user') {
        const claims = await ctx.identity.verifyAccessToken(auth.accessToken);
        if (claims === null) {
          next(new Error('UNAUTHENTICATED'));
          return;
        }
        nickname = auth.nickname ?? claims.displayName;
        isGuest = false;
        userId = claims.sub;
      } else {
        nickname = auth.nickname;
        isGuest = true;
        userId = null;
      }

      const playerId = asPlayerId(randomUUID());
      const outcome = await dispatchAction(ctx, roomId, { type: 'PLAYER_JOIN', playerId, nickname, isGuest });
      if (outcome === null) {
        next(new Error('ROOM_NOT_FOUND'));
        return;
      }
      if (outcome.rejection !== null) {
        next(new Error(outcome.rejection.code));
        return;
      }

      try {
        await ctx.prisma.roomPlayer.upsert({
          where: { roomId_engagementPlayerId: { roomId, engagementPlayerId: playerId } },
          create: { roomId, engagementPlayerId: playerId, nickname, isGuest, userId },
          update: { nickname, isGuest, userId },
        });
      } catch (error) {
        // The realtime join already succeeded (the engine is the source of truth for the room);
        // losing this row only degrades post-hoc stats/history, so it must not fail the join — but
        // it must not vanish silently either, or a joined player can end up missing from the DB
        // with nothing in any log to explain why.
        console.error(`[gateway] failed to persist RoomPlayer for room=${roomId} player=${playerId}:`, error);
      }

      socket.fdg = { roomId, playerId, nickname, isGuest, userId };
      next();
    })();
  });

  io.on('connection', (socket: Socket) => {
    const identity = socket.fdg;
    if (identity === undefined) {
      socket.disconnect(true);
      return;
    }

    void socket.join(identity.roomId);
    trackSocket(identity.roomId, identity.playerId, socket.id);

    void (async (): Promise<void> => {
      const record = await ctx.roomStore.load(identity.roomId);
      if (record === null) return;
      const roomToken = await signRoomToken(
        {
          roomId: identity.roomId,
          playerId: identity.playerId,
          nickname: identity.nickname,
          isGuest: identity.isGuest,
          userId: identity.userId,
        },
        ctx.roomTokenSecret,
      );
      socket.emit('room:joined', {
        roomId: identity.roomId,
        pin: record.state.pin,
        playerId: identity.playerId,
        isHost: record.state.hostPlayerId === identity.playerId,
        roomToken,
      });
      broadcastFromRecord(record);
    })();

    socket.on('room:action', (rawPayload: unknown) => {
      void (async (): Promise<void> => {
        const current = socket.fdg;
        if (current === undefined) return;

        const parsed = parseClientAction(rawPayload);
        if (!parsed.ok) {
          socket.emit('room:error', { code: 'INVALID_PAYLOAD', detail: parsed.issues.join('; ') });
          return;
        }
        if (GATEWAY_RESERVED_ACTION_TYPES.has(parsed.action.type)) {
          socket.emit('room:error', { code: 'FORBIDDEN', detail: 'This action is server-managed.' });
          return;
        }
        const actor = actorOf(parsed.action);
        if (actor !== null && actor !== current.playerId) {
          socket.emit('room:error', { code: 'FORBIDDEN', detail: 'Cannot act on behalf of another player.' });
          return;
        }

        const outcome = await dispatchAction(ctx, current.roomId, parsed.action);
        if (outcome === null) {
          socket.emit('room:error', { code: 'ROOM_NOT_FOUND', detail: null });
          return;
        }
        if (outcome.rejection !== null) {
          socket.emit('room:error', {
            code: outcome.rejection.code,
            detail: outcome.rejection.detail,
            submissionCode: outcome.rejection.submissionCode,
          });
          return;
        }
        broadcastFromRecord(outcome.record);

        if (parsed.action.type === 'START_LOADING') {
          void runLoadingPipeline(ctx, current.roomId, broadcastFromRecord);
        }
        if (parsed.action.type === 'KICK_PLAYER') {
          const targetId = parsed.action.targetPlayerId;
          for (const socketId of socketIdsFor(current.roomId, targetId)) {
            io.sockets.sockets.get(socketId)?.disconnect(true);
          }
        }
      })();
    });

    socket.on('room:leave', () => {
      void (async (): Promise<void> => {
        const current = socket.fdg;
        if (current === undefined) return;
        const outcome = await dispatchAction(ctx, current.roomId, { type: 'PLAYER_LEAVE', playerId: current.playerId });
        untrackSocket(current.roomId, current.playerId, socket.id);
        if (outcome !== null && outcome.rejection === null) broadcastFromRecord(outcome.record);
        void socket.leave(current.roomId);
      })();
    });

    socket.on('disconnect', () => {
      void (async (): Promise<void> => {
        const current = socket.fdg;
        if (current === undefined) return;
        const wasLastSocket = untrackSocket(current.roomId, current.playerId, socket.id);
        if (!wasLastSocket) return;
        const outcome = await dispatchAction(ctx, current.roomId, {
          type: 'PLAYER_DISCONNECTED',
          playerId: current.playerId,
        });
        if (outcome !== null && outcome.rejection === null) broadcastFromRecord(outcome.record);
      })();
    });
  });

  const tickInterval = setInterval(() => {
    void (async (): Promise<void> => {
      const ids = await ctx.roomStore.listIds();
      for (const roomId of ids) {
        const record = await ctx.roomStore.load(roomId);
        if (record === null || record.state.phase !== 'playing') continue;
        const outcome = await dispatchAction(ctx, roomId, { type: 'TICK' });
        if (outcome !== null && outcome.changed) broadcastFromRecord(outcome.record);
      }
    })();
  }, 1000);
  tickInterval.unref?.();

  return {
    close: () => {
      clearInterval(tickInterval);
    },
  };
};
