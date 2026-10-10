import { randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { asPlayerId, asRoomId, createRoom, MULBERRY32 } from '@fdg/game-core';
import type { CreateRoomInput, RoomState } from '@fdg/game-core';
import { optionalAuth } from '../auth/plugin.js';
import type { AppContext } from '../context.js';
import type { CompetitionId, FixtureStatus } from '@fdg/football-data';
import { asCompetitionId, asFixtureId, competitionConfigById, isLiveFixtureStatus } from '@fdg/football-data';
import { resolveFixtureStatus } from '../engine/fixture-status.js';
import { runGamedayPrefetch, runMatchdayPrefetch, runPoolPrefetch } from '../engine/data-context.js';
import { signRoomToken } from '../realtime/room-token.js';
import { generatePin } from './pin.js';
import { createRoomBodySchema, pinParamsSchema, roomIdParamsSchema } from './schemas.js';
import type { RoomMeta, RoomRecord, RoomStore } from './store.js';
import { poolFixtureIds, roomFixtureIds } from './store.js';

/**
 * Public room summary — deliberately excludes `hostPlayerId`. A `PlayerId` is a bare credential in
 * this system (anyone who knows it can sign a room token for it and take over as host, see
 * `realtime/room-token.ts`), so it must never appear in an unauthenticated response. Nothing a
 * lobby screen renders needs it: the host is identified to their own client via the `hostPlayerId`
 * returned once, directly, only from `POST /rooms` (to the account that just created the room), and
 * every other player learns who the host is only through `isHost` on the per-recipient socket
 * projection (`ProjectedPlayer.isHost`), never a raw id.
 */
const summarize = (state: RoomState, meta: RoomMeta, fixtureStatus: FixtureStatus | null) => ({
  roomId: state.id,
  pin: state.pin,
  phase: state.phase,
  playerCount: state.players.filter((player) => player.leftAt === null).length,
  hostNickname: state.players.find((player) => player.id === state.hostPlayerId)?.nickname ?? null,
  category: state.selection === null ? null : state.selection.moduleId,
  /** The single fixture of a one-fixture matchday room; `null` for a multi-fixture pool, gameday and general rooms. */
  fixtureId: meta.fixtureId,
  /**
   * Every fixture the room is tied to: `[fixtureId]` for a single-fixture room, the host's list (2..20, order kept)
   * for a pool, `[]` for gameday (its fixtures are whatever is live, see `currentFixture`) and general rooms.
   */
  fixtureIds: roomFixtureIds(meta),
  /**
   * The room's fixture status (`SCHEDULED`/`LIVE`/`HALF_TIME`/`EXTRA_TIME`/`PENALTIES`/`FINISHED`/`POSTPONED`/
   * `CANCELLED`) for a single-fixture matchday room; for a pool: `LIVE` if any fixture is live, `FINISHED` only when all
   * are finished, else the earliest unfinished fixture's status. `null` for general and gameday rooms, and whenever it
   * could not be determined within ~1.5s. See `engine/fixture-status.ts`.
   */
  fixtureStatus,
  /** Set only for a gameday room (see `RoomMeta`); `null` otherwise. */
  gamedayCompetitionId: meta.gamedayCompetitionId ?? null,
  /** Set only for a competition-scoped general room (see `RoomMeta`); `null` otherwise. */
  generalCompetitionId: meta.generalCompetitionId ?? null,
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

    // Gameday rooms are validated up front, before allocating a PIN or writing any row: a room with
    // nothing to rotate through is never worth creating, and this mirrors the "no live games" case the
    // web picker already handles for the single-fixture flow (`GET /competitions/:id/fixtures`).
    let gamedayCompetitionId: CompetitionId | null = null;
    if (parsed.data.category === 'matchday' && parsed.data.gameday === true) {
      const rawCompetitionId = parsed.data.competitionId;
      if (rawCompetitionId === undefined) {
        return reply
          .code(400)
          .send({ error: { code: 'INVALID_BODY', message: 'competitionId is required for a gameday room.' } });
      }
      const config = competitionConfigById(rawCompetitionId);
      if (config === null) {
        return reply.code(400).send({
          error: { code: 'UNKNOWN_COMPETITION', message: `${rawCompetitionId} is not a supported competition.` },
        });
      }
      const competitionId = asCompetitionId(config.id);
      let liveResult: Awaited<ReturnType<typeof ctx.footballData.listLiveFixtures>>;
      try {
        liveResult = await ctx.footballData.listLiveFixtures(competitionId);
      } catch (error) {
        console.error(`[rooms] provider threw checking live fixtures for ${competitionId}:`, error);
        return reply.code(503).send({
          error: { code: 'DATA_UNAVAILABLE', message: `Could not check live fixtures for ${config.name}.` },
        });
      }
      if (!liveResult.ok) {
        console.error(`[rooms] provider failed checking live fixtures for ${competitionId}:`, liveResult.error);
        return reply.code(503).send({
          error: { code: 'DATA_UNAVAILABLE', message: `Could not check live fixtures for ${config.name}.` },
        });
      }
      if (liveResult.value.length === 0) {
        return reply.code(400).send({
          error: {
            code: 'NO_LIVE_FIXTURES',
            message: `No live fixtures right now in ${config.name} — nothing to rotate through.`,
          },
        });
      }
      gamedayCompetitionId = competitionId;
    }

    // An explicit fixture list (`fixtureIds`): deduped (order kept), every id must exist and still be live or
    // upcoming. Validated before allocating a PIN or writing any row. One id behaves exactly like `fixtureId`.
    let selectedFixtureIds: readonly string[] | null = null;
    if (parsed.data.category === 'matchday' && parsed.data.fixtureIds !== undefined) {
      const unique = [...new Set(parsed.data.fixtureIds)];
      const looked: Array<{ id: string; status: FixtureStatus | null; failed: boolean }> = [];
      for (const id of unique) {
        try {
          const result = await ctx.footballData.getFixture(asFixtureId(id));
          if (!result.ok) {
            console.error(`[rooms] could not look up fixture ${id}:`, result.error);
            looked.push({ id, status: null, failed: true });
          }
          else looked.push({ id, status: result.value === null ? null : result.value.status, failed: false });
        } catch (error) {
          console.error(`[rooms] provider threw looking up fixture ${id}:`, error);
          looked.push({ id, status: null, failed: true });
        }
      }
      if (looked.some((entry) => entry.failed)) {
        return reply.code(503).send({
          error: { code: 'DATA_UNAVAILABLE', message: 'Could not check the selected fixtures right now.' },
        });
      }
      const unknown = looked.filter((entry) => entry.status === null).map((entry) => entry.id);
      if (unknown.length > 0) {
        return reply.code(400).send({
          error: { code: 'UNKNOWN_FIXTURE', message: `Unknown fixture(s): ${unknown.join(', ')}.`, fixtureIds: unknown },
        });
      }
      const unavailable = looked
        .filter((entry) => entry.status !== 'SCHEDULED' && !isLiveFixtureStatus(entry.status as FixtureStatus))
        .map((entry) => entry.id);
      if (unavailable.length > 0) {
        return reply.code(400).send({
          error: {
            code: 'FIXTURE_NOT_AVAILABLE',
            message: `Fixture(s) already finished, postponed or cancelled: ${unavailable.join(', ')}.`,
            fixtureIds: unavailable,
          },
        });
      }
      selectedFixtureIds = unique;
    }

    // A general room may optionally scope itself to one competition — validated up front, before
    // allocating a PIN or writing any row, same as the gameday check above.
    let generalCompetitionId: CompetitionId | null = null;
    if (parsed.data.category === 'general' && parsed.data.competitionId !== undefined) {
      const config = competitionConfigById(parsed.data.competitionId);
      if (config === null) {
        return reply.code(400).send({
          error: { code: 'UNKNOWN_COMPETITION', message: `${parsed.data.competitionId} is not a supported competition.` },
        });
      }
      generalCompetitionId = asCompetitionId(config.id);
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

    // One id (from either request shape) is a plain single-fixture room; 2+ ids from `fixtureIds` are a pool.
    const pool = selectedFixtureIds !== null && selectedFixtureIds.length > 1 ? selectedFixtureIds.map(asFixtureId) : null;
    const fixtureId =
      parsed.data.category !== 'matchday' || gamedayCompetitionId !== null || pool !== null
        ? null
        : (selectedFixtureIds?.[0] ?? parsed.data.fixtureId ?? null);
    const meta: RoomMeta = {
      fixtureId: fixtureId === null ? null : asFixtureId(fixtureId),
      fixtureIds: pool,
      gamedayCompetitionId,
      generalCompetitionId,
    };
    const record: RoomRecord = { state, meta };
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

    // Best-effort warm the matchday/gameday bundle so the game picker can grey out unplayable games
    // immediately; failure here is not fatal — SELECT_GAME will simply see no quality yet, and the
    // loading screen re-runs the prefetch (with progress) before the session starts regardless.
    const warmPool = poolFixtureIds(record.meta);
    if (warmPool !== null) {
      await runPoolPrefetch(ctx, roomId, warmPool).catch(() => null);
    } else if (record.meta.gamedayCompetitionId !== null && record.meta.gamedayCompetitionId !== undefined) {
      await runGamedayPrefetch(ctx, roomId, record.meta.gamedayCompetitionId).catch(() => null);
    } else if (record.meta.fixtureId !== null) {
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
      room: summarize(state, record.meta, await resolveFixtureStatus(ctx, record.meta)),
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
    return reply.send(summarize(record.state, record.meta, await resolveFixtureStatus(ctx, record.meta)));
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
    return reply.send(summarize(record.state, record.meta, await resolveFixtureStatus(ctx, record.meta)));
  });
};
