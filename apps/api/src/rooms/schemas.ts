import { z } from 'zod';
import { roomSettingsPatchSchema } from '@fdg/game-core';

/**
 * A matchday room is either tied to one specific fixture (`fixtureId`, unchanged) or, for "gameday
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
    gameday: z.literal(true).optional(),
    competitionId: z.string().min(1).max(64).optional(),
    /** Required when the caller has no bearer token; ignored (server uses the account name) otherwise. */
    hostNickname: z.string().trim().min(1).max(24).optional(),
    settings: roomSettingsPatchSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.category !== 'matchday' || value.gameday === true || value.fixtureId !== undefined,
    {
      message: 'fixtureId is required for a single-fixture matchday room',
      path: ['fixtureId'],
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
