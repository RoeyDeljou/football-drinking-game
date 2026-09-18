import { z } from 'zod';

export const registerBodySchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(8).max(200),
    displayName: z.string().trim().min(1).max(40),
    ageConfirmed18: z.literal(true, {
      errorMap: () => ({ message: 'You must confirm you are 18 or older.' }),
    }),
  })
  .strict();

export const loginBodySchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(1).max(200),
  })
  .strict();

export const refreshBodySchema = z
  .object({
    refreshToken: z.string().min(1),
  })
  .strict();

export const logoutBodySchema = refreshBodySchema;

export type RegisterBody = z.infer<typeof registerBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type RefreshBody = z.infer<typeof refreshBodySchema>;
