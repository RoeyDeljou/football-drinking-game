/**
 * Everything this app persists in `localStorage`: the auth session (for signed-in users) and the
 * active room's reconnect token (so a dropped connection or a page refresh mid-game can resume
 * instead of dead-ending the player). Guests are first-class: none of this requires an account.
 */

export interface StoredAuth {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly displayName: string;
  readonly email: string;
  readonly userId: string;
}

export interface StoredRoom {
  readonly roomId: string;
  readonly pin: string;
  readonly playerId: string;
  readonly roomToken: string;
  readonly isHost: boolean;
}

const AUTH_KEY = 'fdg:auth';
const ROOM_KEY = 'fdg:room';

const readJson = <T>(key: string): T | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const writeJson = (key: string, value: unknown): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, JSON.stringify(value));
};

const clearKey = (key: string): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(key);
};

export const loadAuth = (): StoredAuth | null => readJson<StoredAuth>(AUTH_KEY);
export const saveAuth = (auth: StoredAuth): void => writeJson(AUTH_KEY, auth);
export const clearAuth = (): void => clearKey(AUTH_KEY);

export const loadRoom = (): StoredRoom | null => readJson<StoredRoom>(ROOM_KEY);
export const saveRoom = (room: StoredRoom): void => writeJson(ROOM_KEY, room);
export const clearRoom = (): void => clearKey(ROOM_KEY);
