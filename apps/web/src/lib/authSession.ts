/**
 * Single source of truth for "do we have a live, non-expired signed-in session right now?"
 *
 * The server issues short-lived access tokens (`JWT_ACCESS_TTL_SECONDS`, 15 minutes by default) plus
 * a longer-lived refresh token (see `apps/api/src/auth/routes.ts` and
 * `apps/api/src/identity/local-identity-provider.ts`). Screens used to call `loadAuth()` directly and
 * trust whatever was in `localStorage` — once the access token aged past 15 minutes, the server
 * started treating every request from it as anonymous (`optionalAuth` in `apps/api/src/rooms/routes.ts`)
 * while the client still believed it was signed in, producing confusing errors like "Enter a
 * nickname." on `/host` for an already-authenticated user.
 *
 * `getValidAuthSession` is the one place that transparently refreshes an expiring access token before
 * a caller uses it over the network, or gives up and clears auth so the caller falls back to
 * guest/signed-out behaviour instead of silently sending a token the server will reject as anonymous.
 * Concurrent callers (e.g. a lobby firing several authenticated requests at once) share one in-flight
 * refresh instead of each hitting `/auth/refresh` separately.
 */
import { refreshAccessToken, toStoredAuth } from './api';
import { clearAuth, loadAuth, saveAuth, type StoredAuth } from './storage';

/** Refresh this many seconds before the token's real expiry, to cover request latency. */
const REFRESH_MARGIN_SECONDS = 30;

/**
 * Decodes the `exp` claim (seconds since epoch) out of a JWT's payload segment without verifying the
 * signature — this is a client-side freshness check only; the server is always the source of truth
 * for whether a token is actually valid.
 */
const decodeJwtExpSeconds = (token: string): number | null => {
  const segments = token.split('.');
  if (segments.length !== 3) return null;
  const payloadSegment = segments[1];
  if (payloadSegment === undefined) return null;
  try {
    const normalized = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    const paddingNeeded = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + '='.repeat(paddingNeeded);
    const json =
      typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('utf-8');
    const payload: unknown = JSON.parse(json);
    if (payload !== null && typeof payload === 'object' && typeof (payload as { exp?: unknown }).exp === 'number') {
      return (payload as { exp: number }).exp;
    }
    return null;
  } catch {
    return null;
  }
};

const isExpiringSoon = (accessToken: string, nowMs: number): boolean => {
  const exp = decodeJwtExpSeconds(accessToken);
  // If the token isn't decodable at all, don't trust it — refresh (or fail closed) rather than send
  // a token whose freshness we can't verify.
  if (exp === null) return true;
  return exp * 1000 - nowMs <= REFRESH_MARGIN_SECONDS * 1000;
};

let inFlightRefresh: Promise<StoredAuth | null> | null = null;

/**
 * Error codes `POST /auth/refresh` returns (see `apps/api/src/auth/routes.ts`'s
 * `IDENTITY_ERROR_STATUS`) when the refresh token itself is the problem — as opposed to the server
 * being unreachable, erroring transiently (5xx), or some other unexpected failure. Only these codes
 * justify clearing a stored session; anything else (including "no code at all", which is what a
 * network failure or non-JSON error body produces) must leave the session alone so a cold start or a
 * brief network blip doesn't sign the user out of a still-valid 30-day refresh token.
 */
const REFRESH_TOKEN_INVALID_CODES: ReadonlySet<string> = new Set([
  'INVALID_REFRESH_TOKEN',
  'REFRESH_TOKEN_REUSED',
  'USER_NOT_FOUND',
]);

const performRefresh = async (refreshToken: string): Promise<StoredAuth | null> => {
  const result = await refreshAccessToken(refreshToken);
  if (!result.ok) {
    if (result.code !== undefined && REFRESH_TOKEN_INVALID_CODES.has(result.code)) {
      // The refresh token itself is invalid, expired, or reused — there is no way back into this
      // session. Clear it so the app treats the user as signed out instead of retrying forever.
      clearAuth();
    }
    // Otherwise this was a network failure, a 5xx, or some other transient/unexpected error — the
    // stored refresh token may still be perfectly good. Leave it in place and let the caller fall
    // back to signed-out behaviour for just this call; the next attempt gets a fresh chance.
    return null;
  }
  const updated = toStoredAuth(result.value);
  saveAuth(updated);
  return updated;
};

/**
 * Returns a `StoredAuth` whose access token is guaranteed fresh (refreshing it first if it's expired
 * or within `REFRESH_MARGIN_SECONDS` of expiring), or `null` if there is no stored session or the
 * refresh itself failed. Always await this — never `loadAuth()` directly — immediately before making
 * an authenticated request or rendering "signed in" state.
 */
export const getValidAuthSession = async (nowMs: () => number = Date.now): Promise<StoredAuth | null> => {
  const stored = loadAuth();
  if (stored === null) return null;
  if (!isExpiringSoon(stored.accessToken, nowMs())) return stored;

  if (inFlightRefresh === null) {
    inFlightRefresh = performRefresh(stored.refreshToken).finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
};

/** Exposed for unit tests only. */
export const __testing__ = { decodeJwtExpSeconds, isExpiringSoon };
