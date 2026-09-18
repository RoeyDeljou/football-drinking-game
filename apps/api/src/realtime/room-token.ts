/**
 * Room membership tokens. Minted once a socket successfully joins a room (as a guest or a
 * registered user) and handed back to the client to store; presenting a valid one on a later
 * connection is how reconnect works without re-running the join flow (see `gateway.ts`).
 */

import { jwtVerify, SignJWT } from 'jose';
import type { PlayerId, RoomId } from '@fdg/game-core';
import { asPlayerId, asRoomId } from '@fdg/game-core';

export interface RoomTokenClaims {
  readonly roomId: RoomId;
  readonly playerId: PlayerId;
  readonly nickname: string;
  readonly isGuest: boolean;
  readonly userId: string | null;
}

const ISSUER = 'fdg-room';
const AUDIENCE = 'fdg-room-member';

export const signRoomToken = async (claims: RoomTokenClaims, secret: Uint8Array): Promise<string> =>
  new SignJWT({
    roomId: claims.roomId,
    nickname: claims.nickname,
    isGuest: claims.isGuest,
    userId: claims.userId,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.playerId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    // Room tokens outlive a session comfortably (12h) — long enough to survive a phone lock /
    // brief network drop, short enough that a stale one is not a long-lived credential.
    .setExpirationTime('12h')
    .sign(secret);

export const verifyRoomToken = async (token: string, secret: Uint8Array): Promise<RoomTokenClaims | null> => {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, audience: AUDIENCE });
    if (typeof payload.sub !== 'string') return null;
    const roomId = typeof payload.roomId === 'string' ? payload.roomId : null;
    const nickname = typeof payload.nickname === 'string' ? payload.nickname : null;
    const isGuest = typeof payload.isGuest === 'boolean' ? payload.isGuest : null;
    const userId = payload.userId === null || typeof payload.userId === 'string' ? (payload.userId ?? null) : null;
    if (roomId === null || nickname === null || isGuest === null) return null;
    return {
      roomId: asRoomId(roomId),
      playerId: asPlayerId(payload.sub),
      nickname,
      isGuest,
      userId,
    };
  } catch {
    return null;
  }
};
