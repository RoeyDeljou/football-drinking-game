import { z } from 'zod';

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(80),
});

export const sendRequestBodySchema = z
  .object({
    targetUserId: z.string().min(1),
  })
  .strict();

export const friendshipIdParamsSchema = z.object({
  requestId: z.string().min(1),
});

export const removeFriendParamsSchema = z.object({
  friendUserId: z.string().min(1),
});

export const inviteBodySchema = z
  .object({
    friendUserId: z.string().min(1),
    roomPin: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().length(6)),
  })
  .strict();
