/**
 * Thin REST client. Every call returns a tagged result instead of throwing, so screens can render a
 * real error state instead of an unhandled rejection.
 */

import { API_BASE_URL } from './config';
import type { StoredAuth } from './storage';

export type ApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

const request = async <T>(
  path: string,
  init: RequestInit & { readonly accessToken?: string } = {},
): Promise<ApiResult<T>> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.accessToken !== undefined) headers.Authorization = `Bearer ${init.accessToken}`;
  if (init.headers !== undefined) Object.assign(headers, init.headers);

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
    const text = await response.text();
    const body: unknown = text.length === 0 ? null : JSON.parse(text);
    if (!response.ok) {
      const message =
        body !== null && typeof body === 'object' && 'error' in body
          ? String((body as { error: { message?: string; code?: string } }).error.message ??
              (body as { error: { message?: string; code?: string } }).error.code ??
              'Request failed')
          : `Request failed (${response.status})`;
      return { ok: false, message };
    }
    return { ok: true, value: body as T };
  } catch {
    return { ok: false, message: 'Could not reach the server. Check your connection and try again.' };
  }
};

/* ---------------------------------- rooms ---------------------------------- */

export interface CreateRoomResponse {
  readonly roomId: string;
  readonly pin: string;
  readonly hostPlayerId: string;
  readonly roomToken: string;
  readonly room: RoomSummary;
}

export interface RoomSummary {
  readonly roomId: string;
  readonly pin: string;
  readonly phase: string;
  readonly playerCount: number;
  readonly hostNickname: string | null;
  readonly category: string | null;
  readonly fixtureId: string | null;
}

export const createRoom = (input: {
  readonly category: 'matchday' | 'general';
  readonly fixtureId?: string;
  readonly hostNickname?: string;
  readonly settings?: Record<string, unknown>;
  readonly accessToken?: string;
}): Promise<ApiResult<CreateRoomResponse>> => {
  const body: Record<string, unknown> = { category: input.category };
  if (input.fixtureId !== undefined) body.fixtureId = input.fixtureId;
  if (input.hostNickname !== undefined) body.hostNickname = input.hostNickname;
  if (input.settings !== undefined) body.settings = input.settings;
  const init: RequestInit & { accessToken?: string } = { method: 'POST', body: JSON.stringify(body) };
  if (input.accessToken !== undefined) init.accessToken = input.accessToken;
  return request<CreateRoomResponse>('/rooms', init);
};

export const fetchRoomByPin = (pin: string): Promise<ApiResult<RoomSummary>> =>
  request<RoomSummary>(`/rooms/pin/${encodeURIComponent(pin)}`);

export const fetchRoomById = (roomId: string): Promise<ApiResult<RoomSummary>> =>
  request<RoomSummary>(`/rooms/${encodeURIComponent(roomId)}`);

/* ---------------------------------- auth ---------------------------------- */

export interface AuthSessionResponse {
  readonly user: { readonly id: string; readonly email: string; readonly displayName: string };
  readonly tokens: {
    readonly accessToken: string;
    readonly refreshToken: string;
  };
  readonly responsibleDrinkingNotice: { readonly required18Plus: true; readonly message: string };
}

export const register = (input: {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly ageConfirmed18: true;
}): Promise<ApiResult<AuthSessionResponse>> =>
  request<AuthSessionResponse>('/auth/register', { method: 'POST', body: JSON.stringify(input) });

export const login = (input: { readonly email: string; readonly password: string }): Promise<
  ApiResult<AuthSessionResponse>
> => request<AuthSessionResponse>('/auth/login', { method: 'POST', body: JSON.stringify(input) });

export const toStoredAuth = (session: AuthSessionResponse): StoredAuth => ({
  accessToken: session.tokens.accessToken,
  refreshToken: session.tokens.refreshToken,
  displayName: session.user.displayName,
  email: session.user.email,
  userId: session.user.id,
});

/* ---------------------------------- friends ---------------------------------- */

export interface PublicUser {
  readonly id: string;
  readonly displayName: string;
  readonly email?: string;
}

export const searchUsers = (q: string, accessToken: string): Promise<ApiResult<{ users: readonly PublicUser[] }>> =>
  request(`/users/search?q=${encodeURIComponent(q)}`, { accessToken });

export const listFriends = (accessToken: string): Promise<ApiResult<{ friends: readonly PublicUser[] }>> =>
  request('/friends', { accessToken });

export interface FriendRequestEntry {
  readonly requestId: string;
  readonly user: PublicUser;
}

export const listFriendRequests = (
  accessToken: string,
): Promise<ApiResult<{ incoming: readonly FriendRequestEntry[]; outgoing: readonly FriendRequestEntry[] }>> =>
  request('/friends/requests', { accessToken });

export const sendFriendRequest = (targetUserId: string, accessToken: string): Promise<ApiResult<{ requestId: string }>> =>
  request('/friends/requests', { method: 'POST', body: JSON.stringify({ targetUserId }), accessToken });

export const respondFriendRequest = (
  requestId: string,
  action: 'accept' | 'decline',
  accessToken: string,
): Promise<ApiResult<{ ok: true }>> =>
  request(`/friends/requests/${encodeURIComponent(requestId)}/${action}`, { method: 'POST', accessToken });

export const inviteFriendToRoom = (
  friendUserId: string,
  roomPin: string,
  accessToken: string,
): Promise<ApiResult<{ roomId: string; pin: string; joinUrl: string }>> =>
  request('/friends/invite', {
    method: 'POST',
    body: JSON.stringify({ friendUserId, roomPin }),
    accessToken,
  });
