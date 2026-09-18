import { z } from 'zod';

/** The socket handshake's `auth` payload. Exactly one of the three join modes. */
export const guestJoinAuthSchema = z
  .object({
    mode: z.literal('guest'),
    pin: z.string().trim().transform((value) => value.toUpperCase()).pipe(z.string().length(6)),
    nickname: z.string().trim().min(1).max(24),
  })
  .strict();

export const userJoinAuthSchema = z
  .object({
    mode: z.literal('user'),
    pin: z.string().trim().transform((value) => value.toUpperCase()).pipe(z.string().length(6)),
    accessToken: z.string().min(1),
    nickname: z.string().trim().min(1).max(24).optional(),
  })
  .strict();

export const reconnectAuthSchema = z
  .object({
    mode: z.literal('reconnect'),
    roomToken: z.string().min(1),
  })
  .strict();

export const socketAuthSchema = z.discriminatedUnion('mode', [
  guestJoinAuthSchema,
  userJoinAuthSchema,
  reconnectAuthSchema,
]);

export type SocketAuth = z.infer<typeof socketAuthSchema>;

/** Actions a client may never originate through `room:action`, even though `clientActionSchema`
 * structurally accepts them — presence is bound by the connection lifecycle, not by client intent. */
export const GATEWAY_RESERVED_ACTION_TYPES = new Set([
  'PLAYER_JOIN',
  'PLAYER_LEAVE',
  'PLAYER_DISCONNECTED',
  'PLAYER_RECONNECTED',
]);
