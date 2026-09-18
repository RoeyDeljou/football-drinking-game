import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestServer } from './helpers.js';
import { jsonFetch, startTestServer } from './helpers.js';

describe('auth REST', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  it('registers, requires 18+ confirmation, logs in, refreshes, and logs out', async () => {
    const rejected = await jsonFetch(`${server.baseUrl}/auth/register`, {
      method: 'POST',
      body: JSON.stringify({
        email: 'under18@example.com',
        password: 'password123',
        displayName: 'Not Old Enough',
        ageConfirmed18: false,
      }),
    });
    expect(rejected.status).toBe(400);

    const register = await jsonFetch(`${server.baseUrl}/auth/register`, {
      method: 'POST',
      body: JSON.stringify({
        email: 'alice@example.com',
        password: 'password123',
        displayName: 'Alice',
        ageConfirmed18: true,
      }),
    });
    expect(register.status).toBe(201);
    const registerBody = register.body as {
      user: { id: string; email: string; ageConfirmed18: boolean };
      tokens: { accessToken: string; refreshToken: string };
      responsibleDrinkingNotice: { required18Plus: boolean; message: string };
    };
    expect(registerBody.user.email).toBe('alice@example.com');
    expect(registerBody.user.ageConfirmed18).toBe(true);
    expect(registerBody.responsibleDrinkingNotice.required18Plus).toBe(true);
    expect(registerBody.tokens.accessToken).toBeTruthy();

    const duplicate = await jsonFetch(`${server.baseUrl}/auth/register`, {
      method: 'POST',
      body: JSON.stringify({
        email: 'alice@example.com',
        password: 'password123',
        displayName: 'Alice Two',
        ageConfirmed18: true,
      }),
    });
    expect(duplicate.status).toBe(409);

    const badLogin = await jsonFetch(`${server.baseUrl}/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email: 'alice@example.com', password: 'wrong-password' }),
    });
    expect(badLogin.status).toBe(401);

    const login = await jsonFetch(`${server.baseUrl}/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email: 'alice@example.com', password: 'password123' }),
    });
    expect(login.status).toBe(200);
    const loginBody = login.body as { tokens: { accessToken: string; refreshToken: string } };

    const me = await jsonFetch(`${server.baseUrl}/auth/me`, {
      headers: { authorization: `Bearer ${loginBody.tokens.accessToken}` },
    });
    expect(me.status).toBe(200);
    expect((me.body as { user: { email: string } }).user.email).toBe('alice@example.com');

    const meUnauthenticated = await jsonFetch(`${server.baseUrl}/auth/me`);
    expect(meUnauthenticated.status).toBe(401);

    const refresh = await jsonFetch(`${server.baseUrl}/auth/refresh`, {
      method: 'POST',
      body: JSON.stringify({ refreshToken: loginBody.tokens.refreshToken }),
    });
    expect(refresh.status).toBe(200);
    const refreshBody = refresh.body as { tokens: { accessToken: string; refreshToken: string } };
    expect(refreshBody.tokens.refreshToken).not.toBe(loginBody.tokens.refreshToken);
    expect(refreshBody.tokens.accessToken).toBeTruthy();

    // The rotated (original) refresh token must now be rejected — single-use rotation.
    const reuse = await jsonFetch(`${server.baseUrl}/auth/refresh`, {
      method: 'POST',
      body: JSON.stringify({ refreshToken: loginBody.tokens.refreshToken }),
    });
    expect(reuse.status).toBe(401);

    const logout = await jsonFetch(`${server.baseUrl}/auth/logout`, {
      method: 'POST',
      body: JSON.stringify({ refreshToken: refreshBody.tokens.refreshToken }),
    });
    expect(logout.status).toBe(204);

    const refreshAfterLogout = await jsonFetch(`${server.baseUrl}/auth/refresh`, {
      method: 'POST',
      body: JSON.stringify({ refreshToken: refreshBody.tokens.refreshToken }),
    });
    expect(refreshAfterLogout.status).toBe(401);
  });
});
