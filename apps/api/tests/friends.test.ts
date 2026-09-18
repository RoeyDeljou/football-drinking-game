import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestServer } from './helpers.js';
import { jsonFetch, startTestServer } from './helpers.js';

interface RegisterResult {
  user: { id: string; displayName: string };
  tokens: { accessToken: string };
}

describe('friends REST', () => {
  let server: TestServer;
  let alice: RegisterResult;
  let bob: RegisterResult;

  beforeAll(async () => {
    server = await startTestServer();
    const registerA = await jsonFetch(`${server.baseUrl}/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ email: 'a@example.com', password: 'password123', displayName: 'Alice', ageConfirmed18: true }),
    });
    alice = registerA.body as RegisterResult;
    const registerB = await jsonFetch(`${server.baseUrl}/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ email: 'b@example.com', password: 'password123', displayName: 'Bob', ageConfirmed18: true }),
    });
    bob = registerB.body as RegisterResult;
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

  it('search never returns email and does not match on email substrings', async () => {
    const byDisplayName = await jsonFetch(`${server.baseUrl}/users/search?q=Bob`, {
      headers: authHeader(alice.tokens.accessToken),
    });
    expect(byDisplayName.status).toBe(200);
    const byDisplayNameBody = byDisplayName.body as { users: Record<string, unknown>[] };
    expect(byDisplayNameBody.users.some((u) => u['id'] === bob.user.id)).toBe(true);
    // No result — for any query — may carry an email field at all.
    for (const user of byDisplayNameBody.users) {
      expect(Object.keys(user)).not.toContain('email');
    }

    // Searching by (part of) bob's email must not find him: email is not a search field.
    const byEmail = await jsonFetch(`${server.baseUrl}/users/search?q=b@example`, {
      headers: authHeader(alice.tokens.accessToken),
    });
    expect(byEmail.status).toBe(200);
    const byEmailBody = byEmail.body as { users: { id: string }[] };
    expect(byEmailBody.users.some((u) => u.id === bob.user.id)).toBe(false);
  });

  it('searches, sends, accepts, lists, invites, and removes a friend', async () => {
    const search = await jsonFetch(`${server.baseUrl}/users/search?q=Bob`, {
      headers: authHeader(alice.tokens.accessToken),
    });
    expect(search.status).toBe(200);
    const searchBody = search.body as { users: { id: string; displayName: string }[] };
    expect(searchBody.users.some((u) => u.id === bob.user.id)).toBe(true);

    const send = await jsonFetch(`${server.baseUrl}/friends/requests`, {
      method: 'POST',
      headers: authHeader(alice.tokens.accessToken),
      body: JSON.stringify({ targetUserId: bob.user.id }),
    });
    expect(send.status).toBe(201);
    const requestId = (send.body as { requestId: string }).requestId;

    const duplicateRequest = await jsonFetch(`${server.baseUrl}/friends/requests`, {
      method: 'POST',
      headers: authHeader(alice.tokens.accessToken),
      body: JSON.stringify({ targetUserId: bob.user.id }),
    });
    expect(duplicateRequest.status).toBe(409);

    const incoming = await jsonFetch(`${server.baseUrl}/friends/requests`, {
      headers: authHeader(bob.tokens.accessToken),
    });
    const incomingBody = incoming.body as { incoming: { requestId: string }[] };
    expect(incomingBody.incoming.some((r) => r.requestId === requestId)).toBe(true);

    const accept = await jsonFetch(`${server.baseUrl}/friends/requests/${requestId}/accept`, {
      method: 'POST',
      headers: authHeader(bob.tokens.accessToken),
    });
    expect(accept.status).toBe(200);

    const aliceFriends = await jsonFetch(`${server.baseUrl}/friends`, { headers: authHeader(alice.tokens.accessToken) });
    const aliceFriendsBody = aliceFriends.body as { friends: { id: string }[] };
    expect(aliceFriendsBody.friends.some((f) => f.id === bob.user.id)).toBe(true);

    const bobFriends = await jsonFetch(`${server.baseUrl}/friends`, { headers: authHeader(bob.tokens.accessToken) });
    const bobFriendsBody = bobFriends.body as { friends: { id: string }[] };
    expect(bobFriendsBody.friends.some((f) => f.id === alice.user.id)).toBe(true);

    const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      headers: authHeader(alice.tokens.accessToken),
      body: JSON.stringify({ category: 'general' }),
    });
    expect(createRoom.status).toBe(201);
    const pin = (createRoom.body as { pin: string }).pin;

    const invite = await jsonFetch(`${server.baseUrl}/friends/invite`, {
      method: 'POST',
      headers: authHeader(alice.tokens.accessToken),
      body: JSON.stringify({ friendUserId: bob.user.id, roomPin: pin }),
    });
    expect(invite.status).toBe(200);
    expect((invite.body as { pin: string }).pin).toBe(pin);

    const remove = await jsonFetch(`${server.baseUrl}/friends/${bob.user.id}`, {
      method: 'DELETE',
      headers: authHeader(alice.tokens.accessToken),
    });
    expect(remove.status).toBe(204);

    const aliceFriendsAfter = await jsonFetch(`${server.baseUrl}/friends`, { headers: authHeader(alice.tokens.accessToken) });
    const aliceFriendsAfterBody = aliceFriendsAfter.body as { friends: { id: string }[] };
    expect(aliceFriendsAfterBody.friends.some((f) => f.id === bob.user.id)).toBe(false);
  });
});
