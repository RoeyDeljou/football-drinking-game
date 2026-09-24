/**
 * Regression coverage for the Phase 3 QA gate's D1 finding: hardcoded default secrets would have
 * let anyone who knows a room's 6-character PIN forge a room token for the host's `PlayerId` and
 * take the room over — and separately, forge a JWT to impersonate any user against `GET /auth/me`.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { asPlayerId, asRoomId } from '@fdg/game-core';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';
import { signRoomToken } from '../src/realtime/room-token.js';
import type { TestServer } from './helpers.js';
import { connectSocket, jsonFetch, startTestServer } from './helpers.js';

/** Read straight from the real `.env.example` so this test can never drift from what the file
 * actually ships — it fails the moment someone edits the file to a placeholder the blocklist in
 * `env.ts` doesn't know about, instead of silently testing a stale copy of the old values. */
const readEnvExamplePlaceholders = (): Record<string, string> => {
  const path = fileURLToPath(new URL('../.env.example', import.meta.url));
  const content = readFileSync(path, 'utf-8');
  const placeholders: Record<string, string> = {};
  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'ROOM_TOKEN_SECRET']) {
    const match = new RegExp(`^${key}="([^"]*)"`, 'm').exec(content);
    if (match?.[1] !== undefined) placeholders[key] = match[1];
  }
  return placeholders;
};

describe('production secret validation (env.ts)', () => {
  const baseProdEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://user:password@localhost:5432/prod?schema=public',
    CORS_ORIGIN: 'https://example.com',
  };

  it('refuses to boot in production with no secrets set at all', () => {
    expect(() => loadEnv(baseProdEnv)).toThrow();
  });

  it('refuses to boot in production with secrets that are too short', () => {
    expect(() =>
      loadEnv({
        ...baseProdEnv,
        JWT_ACCESS_SECRET: 'too-short',
        JWT_REFRESH_SECRET: 'too-short',
        ROOM_TOKEN_SECRET: 'too-short',
      }),
    ).toThrow();
  });

  it('refuses to boot in production when secrets are the known development literals', () => {
    expect(() =>
      loadEnv({
        ...baseProdEnv,
        JWT_ACCESS_SECRET: 'dev-access-secret-change-me-please-32chars',
        JWT_REFRESH_SECRET: 'dev-refresh-secret-change-me-please-32chars',
        ROOM_TOKEN_SECRET: 'dev-room-token-secret-change-me-32chars',
      }),
    ).toThrow();
  });

  it('refuses to boot in production with the exact placeholder values shipped in .env.example', () => {
    const placeholders = readEnvExamplePlaceholders();
    // Sanity check the extraction itself found something — an empty object would make the
    // assertion below vacuously pass and silently stop testing anything.
    expect(Object.keys(placeholders).sort()).toEqual(
      ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'ROOM_TOKEN_SECRET'].sort(),
    );
    expect(() => loadEnv({ ...baseProdEnv, ...placeholders })).toThrow();
  });

  it('boots in production with three distinct, sufficiently long real secrets', () => {
    const env = loadEnv({
      ...baseProdEnv,
      JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
      JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
      ROOM_TOKEN_SECRET: randomBytes(32).toString('hex'),
    });
    expect(env.NODE_ENV).toBe('production');
  });

  it('outside production, fills in a fresh random secret per call when unset (never a fixed literal)', () => {
    const a = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'file:./a.db' });
    const b = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'file:./b.db' });
    expect(a.JWT_ACCESS_SECRET).not.toBe('dev-access-secret-change-me-please-32chars');
    expect(a.JWT_ACCESS_SECRET.length).toBeGreaterThanOrEqual(32);
    // Two independent boots must not coincidentally share a secret.
    expect(a.JWT_ACCESS_SECRET).not.toBe(b.JWT_ACCESS_SECRET);
    expect(a.ROOM_TOKEN_SECRET).not.toBe(a.JWT_ACCESS_SECRET);
  });
});

describe('PIN-to-host-takeover chain is closed', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  it('GET /rooms/pin/:pin never returns hostPlayerId', async () => {
    const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ category: 'general', hostNickname: 'Hosty' }),
    });
    expect(createRoom.status).toBe(201);
    const { pin } = createRoom.body as { pin: string };

    const summary = await jsonFetch(`${server.baseUrl}/rooms/pin/${pin}`);
    expect(summary.status).toBe(200);
    const body = summary.body as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain('hostPlayerId');
    expect(JSON.stringify(body)).not.toContain('hostPlayerId');
  });

  it('GET /rooms/:roomId never returns hostPlayerId either', async () => {
    const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ category: 'general', hostNickname: 'Hosty' }),
    });
    const { roomId } = createRoom.body as { roomId: string };

    const summary = await jsonFetch(`${server.baseUrl}/rooms/${roomId}`);
    expect(summary.status).toBe(200);
    const body = summary.body as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain('hostPlayerId');
  });

  it('a room token forged with a guessed/wrong secret is rejected even when the real hostPlayerId is known', async () => {
    const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ category: 'general', hostNickname: 'Hosty' }),
    });
    const { roomId, hostPlayerId } = createRoom.body as { roomId: string; hostPlayerId: string };
    expect(hostPlayerId).toBeTruthy();

    // Step 1 of the exploit: discover hostPlayerId. In the real attack this came from the (now
    // fixed) PIN-lookup leak; here we already have it from the creation response, which is fine —
    // the point of this test is that knowing the id alone is no longer enough.
    // Step 2: forge a room token for that id using an attacker-guessed secret instead of the
    // server's real (random, unknown-to-the-attacker) `ROOM_TOKEN_SECRET`.
    const forgedToken = await signRoomToken(
      {
        roomId: asRoomId(roomId),
        playerId: asPlayerId(hostPlayerId),
        nickname: 'Attacker',
        isGuest: true,
        userId: null,
      },
      new TextEncoder().encode('attacker-guessed-secret-that-is-also-32-chars-long'),
    );

    // Step 3: attempt full host takeover via the forged token.
    await expect(connectSocket(server, { mode: 'reconnect', roomToken: forgedToken })).rejects.toBeTruthy();
  });

  it('a forged access token (wrong secret) cannot impersonate a user via GET /auth/me', async () => {
    const register = await jsonFetch(`${server.baseUrl}/auth/register`, {
      method: 'POST',
      body: JSON.stringify({
        email: 'victim@example.com',
        password: 'password123',
        displayName: 'Victim',
        ageConfirmed18: true,
      }),
    });
    expect(register.status).toBe(201);
    const { user } = register.body as { user: { id: string; email: string } };

    // Forge an access token for the victim's real user id, signed with a guessed secret instead of
    // the server's real `JWT_ACCESS_SECRET`.
    const forgedAccessToken = await new SignJWT({ email: user.email, displayName: 'Victim' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('attacker-guessed-secret-that-is-also-32-chars-long'));

    const me = await jsonFetch(`${server.baseUrl}/auth/me`, {
      headers: { authorization: `Bearer ${forgedAccessToken}` },
    });
    expect(me.status).toBe(401);
  });
});
