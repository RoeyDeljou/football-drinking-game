import { z } from 'zod';
import { roomSettingsPatchSchema } from '@fdg/game-core';

/**
 * A matchday room is tied to one fixture (`fixtureId`), to an explicit list of 1..20 fixtures (`fixtureIds`; one id =
 * single-fixture room, more = a rotation pool across them, any competitions) or, for "gameday
 * mode", to a whole competition whose currently-live fixtures rotate round to round
 * (`gameday: true` + `competitionId`) — never both. A `general` room uses neither of those, but may
 * itself optionally carry `competitionId` to scope every general game in the room to that one
 * competition instead of the combined dataset (see `RoomMeta.generalCompetitionId`); omitting it
 * keeps today's combined-dataset behaviour unchanged. The same `competitionId` field is reused for
 * both meanings — they are mutually exclusive by `category`, never ambiguous for a given request.
 */
export const createRoomBodySchema = z
  .object({
    category: z.enum(['matchday', 'general']),
    fixtureId: z.string().min(1).max(64).optional(),
    /** 1..20 fixtures (any competitions). One id = a single-fixture room; more = a rotation pool. */
    fixtureIds: z.array(z.string().min(1).max(64)).min(1).max(20).optional(),
    gameday: z.literal(true).optional(),
    competitionId: z.string().min(1).max(64).optional(),
    /** Required when the caller has no bearer token; ignored (server uses the account name) otherwise. */
    hostNickname: z.string().trim().min(1).max(24).optional(),
    settings: roomSettingsPatchSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.category !== 'matchday' ||
      value.gameday === true ||
      value.fixtureId !== undefined ||
      value.fixtureIds !== undefined,
    {
      message: 'fixtureId or fixtureIds is required for a matchday room',
      path: ['fixtureIds'],
    },
  )
  .refine((value) => value.gameday !== true || value.competitionId !== undefined, {
    message: 'competitionId is required for a gameday room',
    path: ['competitionId'],
  })
  .refine((value) => value.gameday !== true || value.fixtureId === undefined, {
    message: 'fixtureId and gameday are mutually exclusive',
    path: ['fixtureId'],
  })
  .refine((value) => value.category === 'general' || value.gameday === true || value.competitionId === undefined, {
    message: 'competitionId is only accepted for a general room or a gameday matchday room',
    path: ['competitionId'],
  })
  .refine((value) => value.fixtureIds === undefined || (value.fixtureId === undefined && value.gameday === undefined), {
    message: 'fixtureIds cannot be combined with fixtureId or gameday',
    path: ['fixtureIds'],
  })
  .refine((value) => value.category !== 'general' || value.fixtureIds === undefined, {
    message: 'fixtureIds does not apply to a general room',
    path: ['fixtureIds'],
  })
  .refine((value) => value.category !== 'general' || value.fixtureId === undefined, {
    message: 'fixtureId does not apply to a general room',
    path: ['fixtureId'],
  })
  .refine((value) => value.category !== 'general' || value.gameday === undefined, {
    message: 'gameday does not apply to a general room',
    path: ['gameday'],
  });

export const pinParamsSchema = z.object({
  pin: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().length(6)),
});

export const roomIdParamsSchema = z.object({
  roomId: z.string().min(1),
});
