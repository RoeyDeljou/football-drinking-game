import { z } from 'zod';
import { roomSettingsPatchSchema } from '@fdg/game-core';

export const createRoomBodySchema = z
  .object({
    category: z.enum(['matchday', 'general']),
    fixtureId: z.string().min(1).max(64).optional(),
    /** Required when the caller has no bearer token; ignored (server uses the account name) otherwise. */
    hostNickname: z.string().trim().min(1).max(24).optional(),
    settings: roomSettingsPatchSchema.optional(),
  })
  .strict()
  .refine((value) => value.category !== 'matchday' || value.fixtureId !== undefined, {
    message: 'fixtureId is required for a matchday room',
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
