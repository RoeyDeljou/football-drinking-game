import { z } from 'zod';
import { roomSettingsPatchSchema } from '@fdg/game-core';

/**
 * A matchday room is either tied to one specific fixture (`fixtureId`, unchanged) or, for "gameday
 * mode", to a whole competition whose currently-live fixtures rotate round to round
 * (`gameday: true` + `competitionId`) — never both. `general` rooms use neither.
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
