import { createHash, randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { AccessTokenClaims } from './types.js';

export interface TokenConfig {
  readonly accessSecret: Uint8Array;
  readonly refreshSecret: Uint8Array;
  readonly accessTtlSeconds: number;
  readonly refreshTtlSeconds: number;
}

export const buildTokenConfig = (input: {
  readonly accessSecret: string;
  readonly refreshSecret: string;
  readonly accessTtlSeconds: number;
  readonly refreshTtlSeconds: number;
}): TokenConfig => ({
  accessSecret: new TextEncoder().encode(input.accessSecret),
  refreshSecret: new TextEncoder().encode(input.refreshSecret),
  accessTtlSeconds: input.accessTtlSeconds,
  refreshTtlSeconds: input.refreshTtlSeconds,
});

export const signAccessToken = async (
  claims: AccessTokenClaims,
  config: TokenConfig,
): Promise<{ token: string; expiresAt: Date }> => {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.accessTtlSeconds;
  const token = await new SignJWT({ email: claims.email, displayName: claims.displayName })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(config.accessSecret);
  return { token, expiresAt: new Date(exp * 1000) };
};

export const verifyAccessToken = async (
  token: string,
  config: TokenConfig,
): Promise<AccessTokenClaims | null> => {
  try {
    const { payload } = await jwtVerify(token, config.accessSecret);
    if (typeof payload.sub !== 'string') return null;
    const email = typeof payload.email === 'string' ? payload.email : null;
    const displayName = typeof payload.displayName === 'string' ? payload.displayName : null;
    if (email === null || displayName === null) return null;
    return { sub: payload.sub, email, displayName };
  } catch {
    return null;
  }
};

/** Opaque refresh token: a random id + a random secret, `id.secret`. Only the hash is stored. */
export const generateRefreshTokenValue = (): { value: string; hash: string } => {
  const id = randomUUID();
  const secret = randomUUID();
  const value = `${id}.${secret}`;
  return { value, hash: hashRefreshToken(value) };
};

export const hashRefreshToken = (value: string): string => createHash('sha256').update(value).digest('hex');
