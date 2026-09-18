import { randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { asPlayerId, asRoomId, createRoom, MULBERRY32 } from '@fdg/game-core';
import type { CreateRoomInput, RoomState } from '@fdg/game-core';
import { optionalAuth } from '../auth/plugin.js';
import type { AppContext } from '../context.js';
import { asFixtureId } from '@fdg/football-data';
import { runMatchdayPrefetch } from '../engine/data-context.js';
import { signRoomToken } from '../realtime/room-token.js';
import { generatePin } from './pin.js';
import { createRoomBodySchema, pinParamsSchema, roomIdParamsSchema } from './schemas.js';
import type { RoomRecord, RoomStore } from './store.js';

/**
 * Public room summary — deliberately excludes `hostPlayerId`. A `PlayerId` is a bare credential in
 * this system (anyone who knows it can sign a room token for it and take over as host, see
 * `realtime/room-token.ts`), so it must never appear in an unauthenticated response. Nothing a
 * lobby screen renders needs it: the host is identified to their own client via the `hostPlayerId`
 * returned once, directly, only from `POST /rooms` (to the account that just created the room), and
 * every other player learns who the host is only through `isHost` on the per-recipient socket
 * projection (`ProjectedPlayer.isHost`), never a raw id.
 */
const summarize = (state: RoomState, fixtureId: string | null) => ({
  roomId: state.id,
  pin: state.pin,
  phase: state.phase,
  playerCount: state.players.filter((player) => player.leftAt === null).length,
  hostNickname: state.players.find((player) => player.id === state.hostPlayerId)?.nickname ?? null,
  category: state.selection === null ? null : state.selection.moduleId,
  fixtureId,
});

const generateUniquePin = async (store: RoomStore): Promise<string> => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = generatePin();
    const existing = await store.findByPin(candidate);
    if (existing === null) return candidate;
  }
  throw new Error('Could not allocate a unique room PIN after 25 attempts');
};

export const registerRoomRoutes = (app: FastifyInstance, ctx: AppContext): void => {
  app.post('/rooms', { preHandler: optionalAuth(ctx) }, async (request, reply) => {
    const parsed = createRoomBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: parsed.error.message } });
    }
    const authUser = request.authUser;
    const hostNickname = authUser?.displayName ?? parsed.data.hostNickname;
    if (hostNickname === undefined) {
      return reply
        .code(400)
        .send({ error: { code: 'NICKNAME_REQUIRED', message: 'hostNickname is required for a guest host.' } });
    }

    const roomId = asRoomId(randomUUID());
    const hostPlayerId = asPlayerId(randomUUID());
    const pin = await generateUniquePin(ctx.roomStore);
    const seed = randomInt(0, 0xffffffff);

    const createInput: CreateRoomInput = {
      roomId,
      pin,
      hostPlayerId,
      hostNickname,
      hostIsGuest: authUser === undefined,
      now: Date.now(),
      rngState: MULBERRY32.initialState(seed),
      ...(parsed.data.settings === undefined ? {} : { settings: parsed.data.settings }),
    };
    const state = createRoom(createInput);

    const fixtureId = parsed.data.category === 'matchday' ? (parsed.data.fixtureId ?? null) : null;
    const record: RoomRecord = { state, meta: { fixtureId: fixtureId === null ? null : asFixtureId(fixtureId) } };
    await ctx.roomStore.save(record);

    await ctx.prisma.room.create({
      data: {
        id: roomId,
        pin,
        hostUserId: authUser?.sub ?? null,
        status: state.phase,
      },
    });
    await ctx.prisma.roomPlayer.create({
      data: {
        roomId,
        engagementPlayerId: hostPlayerId,
        userId: authUser?.sub ?? null,
        nickname: hostNickname,
        isGuest: authUser === undefined,
      },
    });

    // Best-effort warm the matchday bundle so the game picker can grey out unplayable games
    // immediately; failure here is not fatal — SELECT_GAME will simply see no quality yet, and the
    // loading screen re-runs the prefetch (with progress) before the session starts regardless.
    if (record.meta.fixtureId !== null) {
      await runMatchdayPrefetch(ctx, roomId, record.meta.fixtureId).catch(() => null);
    }

    const roomToken = await signRoomToken(
      { roomId, playerId: hostPlayerId, nickname: hostNickname, isGuest: authUser === undefined, userId: authUser?.sub ?? null },
      ctx.roomTokenSecret,
    );

    return reply.code(201).send({
      roomId,
      pin,
      hostPlayerId,
      roomToken,
      room: summarize(state, record.meta.fixtureId),
    });
  });

  app.get('/rooms/pin/:pin', async (request, reply) => {
    const parsed = pinParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_PARAMS', message: parsed.error.message } });
    }
    const record = await ctx.roomStore.findByPin(parsed.data.pin);
    if (record === null) {
      return reply.code(404).send({ error: { code: 'ROOM_NOT_FOUND', message: 'No room with that PIN.' } });
    }
    return reply.send(summarize(record.state, record.meta.fixtureId));
  });

  app.get('/rooms/:roomId', async (request, reply) => {
    const parsed = roomIdParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_PARAMS', message: parsed.error.message } });
    }
    const record = await ctx.roomStore.load(asRoomId(parsed.data.roomId));
    if (record === null) {
      return reply.code(404).send({ error: { code: 'ROOM_NOT_FOUND', message: 'No such room.' } });
    }
    return reply.send(summarize(record.state, record.meta.fixtureId));
  });
};
