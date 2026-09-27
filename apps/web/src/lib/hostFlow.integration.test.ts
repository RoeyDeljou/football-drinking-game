import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Integration-style coverage for the bug this change fixes: a signed-in user whose access token
 * expired while they sat on `/host` must still create a room *as themselves* (refreshed session,
 * `accessToken` sent, no `hostNickname` prompt) rather than being silently downgraded to guest
 * behaviour. This drives the real `getValidAuthSession` -> `createRoom` path (mocking only
 * `fetch`), mirroring exactly what `app/host/page.tsx`'s `onCreate` does, without needing a DOM
 * testing library that isn't part of this workspace's toolchain.
 */
const memory = new Map<string, string>();
const localStorageFake: Storage = {
  get length() {
    return memory.size;
  },
  clear: () => memory.clear(),
  getItem: (key: string) => memory.get(key) ?? null,
  key: (index: number) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key: string) => {
    memory.delete(key);
  },
  setItem: (key: string, value: string) => {
    memory.set(key, value);
  },
};
vi.stubGlobal('window', { localStorage: localStorageFake });

const base64url = (input: string): string =>
  Buffer.from(input, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const makeToken = (expSeconds: number): string => {
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ sub: 'user-1', exp: expSeconds }));
  return `${header}.${payload}.signature`;
};

import { createRoom } from './api';
import { getValidAuthSession } from './authSession';
import { saveAuth } from './storage';

describe('host flow with an access token that expired while the user was idle on /host', () => {
  beforeEach(() => {
    memory.clear();
  });

  it('refreshes the session and creates the room as the signed-in user, without a nickname prompt', async () => {
    const nowMs = 1_000_000_000_000;
    const nowSeconds = Math.floor(nowMs / 1000);
    // Access token "expired 20 minutes ago" relative to now.
    const staleAccessToken = makeToken(nowSeconds - 20 * 60);
    saveAuth({
      accessToken: staleAccessToken,
      refreshToken: 'refresh-token-1',
      displayName: 'Roey',
      email: 'roey@example.com',
      userId: 'user-1',
    });

    const freshAccessToken = makeToken(nowSeconds + 15 * 60);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) {
        return new Response(
          JSON.stringify({
            user: { id: 'user-1', email: 'roey@example.com', displayName: 'Roey' },
            tokens: { accessToken: freshAccessToken, refreshToken: 'refresh-token-2' },
            responsibleDrinkingNotice: { required18Plus: true, message: 'drink responsibly' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/rooms')) {
        // The whole point of the fix: the room-creation request must carry the refreshed bearer
        // token and must NOT include a hostNickname, because the server already knows who this is.
        const authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
        expect(authHeader).toBe(`Bearer ${freshAccessToken}`);
        const body: unknown = JSON.parse(String(init?.body ?? '{}'));
        expect(body).not.toHaveProperty('hostNickname');
        return new Response(
          JSON.stringify({
            roomId: 'room-1',
            pin: 'ABC123',
            hostPlayerId: 'player-1',
            roomToken: 'room-token-1',
            room: {
              roomId: 'room-1',
              pin: 'ABC123',
              phase: 'lobby',
              playerCount: 1,
              hostNickname: 'Roey',
              category: 'general',
              fixtureId: null,
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    // Mirrors app/host/page.tsx's onCreate: re-validate the session immediately before the call.
    const session = await getValidAuthSession(() => nowMs);
    expect(session).not.toBeNull();

    const hostNickname = ''; // the user never typed one — they are signed in, so this must not matter
    const result = await createRoom({
      category: 'general',
      ...(session === null ? { hostNickname } : {}),
      settings: { roundsPerSession: 8, minPlayersToStart: 1 },
      ...(session !== null ? { accessToken: session.accessToken } : {}),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.roomId).toBe('room-1');
    }
    // One call to refresh, one call to create the room — never falls back to an anonymous/guest path.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
