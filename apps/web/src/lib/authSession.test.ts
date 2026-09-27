import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `authSession.ts` reads/writes through `lib/storage.ts`, which itself gates every operation behind
 * `typeof window === 'undefined'`. There is no DOM in this suite's `node` test environment, so we
 * stand up a minimal `window.localStorage` fake for the duration of these tests — this exercises the
 * real `storage.ts` read/write path rather than mocking it away.
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

/** Builds a syntactically-valid (unsigned) JWT with a controllable `exp` claim, in seconds. */
const makeToken = (expSeconds: number): string => {
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ sub: 'user-1', exp: expSeconds }));
  return `${header}.${payload}.signature`;
};

const STORED_AUTH_BASE = {
  displayName: 'Roey',
  email: 'roey@example.com',
  userId: 'user-1',
};

import type { ApiResult, AuthSessionResponse } from './api';
import { refreshAccessToken } from './api';
import { getValidAuthSession } from './authSession';
import { clearAuth, loadAuth, saveAuth } from './storage';

vi.mock('./api', () => ({
  refreshAccessToken: vi.fn(),
  toStoredAuth: (session: { user: { id: string; email: string; displayName: string }; tokens: { accessToken: string; refreshToken: string } }) => ({
    accessToken: session.tokens.accessToken,
    refreshToken: session.tokens.refreshToken,
    displayName: session.user.displayName,
    email: session.user.email,
    userId: session.user.id,
  }),
}));

const mockedRefresh = vi.mocked(refreshAccessToken);

describe('getValidAuthSession', () => {
  beforeEach(() => {
    memory.clear();
    mockedRefresh.mockReset();
  });

  it('returns null when there is no stored session', async () => {
    expect(await getValidAuthSession()).toBeNull();
    expect(mockedRefresh).not.toHaveBeenCalled();
  });

  it('returns the stored session as-is when the access token is not near expiry', async () => {
    const now = 1_000_000_000_000; // ms
    const nowSeconds = Math.floor(now / 1000);
    const accessToken = makeToken(nowSeconds + 60 * 60); // expires in 1 hour
    saveAuth({ ...STORED_AUTH_BASE, accessToken, refreshToken: 'refresh-1' });

    const result = await getValidAuthSession(() => now);

    expect(result?.accessToken).toBe(accessToken);
    expect(mockedRefresh).not.toHaveBeenCalled();
  });

  it('transparently refreshes an expired access token and persists the result', async () => {
    const now = 1_000_000_000_000;
    const nowSeconds = Math.floor(now / 1000);
    const expiredAccessToken = makeToken(nowSeconds - 60); // expired 1 minute ago
    saveAuth({ ...STORED_AUTH_BASE, accessToken: expiredAccessToken, refreshToken: 'refresh-1' });

    const freshAccessToken = makeToken(nowSeconds + 60 * 60);
    mockedRefresh.mockResolvedValue({
      ok: true,
      value: {
        user: { id: 'user-1', email: 'roey@example.com', displayName: 'Roey' },
        tokens: { accessToken: freshAccessToken, refreshToken: 'refresh-2' },
        responsibleDrinkingNotice: { required18Plus: true, message: 'drink responsibly' },
      },
    });

    const result = await getValidAuthSession(() => now);

    expect(mockedRefresh).toHaveBeenCalledTimes(1);
    expect(mockedRefresh).toHaveBeenCalledWith('refresh-1');
    expect(result?.accessToken).toBe(freshAccessToken);
    expect(loadAuth()?.accessToken).toBe(freshAccessToken);
    expect(loadAuth()?.refreshToken).toBe('refresh-2');
  });

  it('clears auth and returns null when the server says the refresh token is invalid', async () => {
    const now = 1_000_000_000_000;
    const nowSeconds = Math.floor(now / 1000);
    const expiredAccessToken = makeToken(nowSeconds - 60);
    saveAuth({ ...STORED_AUTH_BASE, accessToken: expiredAccessToken, refreshToken: 'refresh-1' });

    mockedRefresh.mockResolvedValue({
      ok: false,
      message: 'Refresh token is unknown.',
      code: 'INVALID_REFRESH_TOKEN',
      status: 401,
    });

    const result = await getValidAuthSession(() => now);

    expect(result).toBeNull();
    expect(loadAuth()).toBeNull();
  });

  it('clears auth and returns null when the refresh token was reused (rotation replay)', async () => {
    const now = 1_000_000_000_000;
    const nowSeconds = Math.floor(now / 1000);
    const expiredAccessToken = makeToken(nowSeconds - 60);
    saveAuth({ ...STORED_AUTH_BASE, accessToken: expiredAccessToken, refreshToken: 'refresh-1' });

    mockedRefresh.mockResolvedValue({
      ok: false,
      message: 'Refresh token was already used.',
      code: 'REFRESH_TOKEN_REUSED',
      status: 401,
    });

    const result = await getValidAuthSession(() => now);

    expect(result).toBeNull();
    expect(loadAuth()).toBeNull();
  });

  it('does NOT clear auth when refresh fails with a network error (no response at all)', async () => {
    const now = 1_000_000_000_000;
    const nowSeconds = Math.floor(now / 1000);
    const expiredAccessToken = makeToken(nowSeconds - 60);
    saveAuth({ ...STORED_AUTH_BASE, accessToken: expiredAccessToken, refreshToken: 'refresh-1' });

    // Mirrors what `request()` in `api.ts` returns when `fetch` throws: no `code`, no `status`.
    mockedRefresh.mockResolvedValue({
      ok: false,
      message: 'Could not reach the server. Check your connection and try again.',
    });

    const result = await getValidAuthSession(() => now);

    expect(result).toBeNull();
    // The stored session must survive — the refresh token itself was never judged invalid.
    expect(loadAuth()?.refreshToken).toBe('refresh-1');
    expect(loadAuth()?.accessToken).toBe(expiredAccessToken);
  });

  it('does NOT clear auth when refresh fails with a 5xx server error', async () => {
    const now = 1_000_000_000_000;
    const nowSeconds = Math.floor(now / 1000);
    const expiredAccessToken = makeToken(nowSeconds - 60);
    saveAuth({ ...STORED_AUTH_BASE, accessToken: expiredAccessToken, refreshToken: 'refresh-1' });

    mockedRefresh.mockResolvedValue({
      ok: false,
      message: 'Request failed (503)',
      status: 503,
    });

    const result = await getValidAuthSession(() => now);

    expect(result).toBeNull();
    expect(loadAuth()?.refreshToken).toBe('refresh-1');
    expect(loadAuth()?.accessToken).toBe(expiredAccessToken);
  });

  it('coalesces concurrent callers into a single refresh request', async () => {
    const now = 1_000_000_000_000;
    const nowSeconds = Math.floor(now / 1000);
    const expiredAccessToken = makeToken(nowSeconds - 60);
    saveAuth({ ...STORED_AUTH_BASE, accessToken: expiredAccessToken, refreshToken: 'refresh-1' });

    const freshAccessToken = makeToken(nowSeconds + 60 * 60);
    // A mutable container (rather than a reassigned `let`) so TypeScript's control-flow narrowing
    // does not lose track of the closure assignment made inside the mocked promise executor.
    const refreshGate: { resolve: ((value: ApiResult<AuthSessionResponse>) => void) | null } = { resolve: null };
    mockedRefresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          refreshGate.resolve = resolve;
        }),
    );

    const callA = getValidAuthSession(() => now);
    const callB = getValidAuthSession(() => now);
    const callC = getValidAuthSession(() => now);

    // Let the microtask queue settle so all three calls have reached the refresh gate.
    await Promise.resolve();
    await Promise.resolve();
    expect(refreshGate.resolve).not.toBeNull();
    refreshGate.resolve?.({
      ok: true,
      value: {
        user: { id: 'user-1', email: 'roey@example.com', displayName: 'Roey' },
        tokens: { accessToken: freshAccessToken, refreshToken: 'refresh-2' },
        responsibleDrinkingNotice: { required18Plus: true, message: 'drink responsibly' },
      },
    });

    const [resultA, resultB, resultC] = await Promise.all([callA, callB, callC]);

    expect(mockedRefresh).toHaveBeenCalledTimes(1);
    expect(resultA?.accessToken).toBe(freshAccessToken);
    expect(resultB?.accessToken).toBe(freshAccessToken);
    expect(resultC?.accessToken).toBe(freshAccessToken);
  });

  it('treats a token with no decodable exp claim as expiring, forcing a refresh', async () => {
    const now = 1_000_000_000_000;
    saveAuth({ ...STORED_AUTH_BASE, accessToken: 'not-a-jwt', refreshToken: 'refresh-1' });
    mockedRefresh.mockResolvedValue({ ok: false, message: 'invalid' });

    const result = await getValidAuthSession(() => now);

    expect(mockedRefresh).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });
});

describe('cleanup', () => {
  it('clearAuth leaves no session behind', () => {
    saveAuth({ ...STORED_AUTH_BASE, accessToken: 'a', refreshToken: 'b' });
    clearAuth();
    expect(loadAuth()).toBeNull();
  });
});
