/**
 * Thin REST client. Every call returns a tagged result instead of throwing, so screens can render a
 * real error state instead of an unhandled rejection.
 */

import { API_BASE_URL } from './config';

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly message: string;
      /**
       * The server's `error.code` (e.g. `NO_LIVE_FIXTURES`), when the server actually responded
       * with a structured error body. `undefined` for a network failure (fetch threw, no response at
       * all) — callers that need to distinguish "the server told us this is invalid" from "we
       * couldn't reach it" must check this, not just `ok`.
       */
      readonly code?: string;
      /** The HTTP status, when a response was actually received (absent on a network failure). */
      readonly status?: number;
    };

const request = async <T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.headers !== undefined) Object.assign(headers, init.headers);

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
    const text = await response.text();
    const body: unknown = text.length === 0 ? null : JSON.parse(text);
    if (!response.ok) {
      const errorBody =
        body !== null && typeof body === 'object' && 'error' in body
          ? (body as { error: { message?: string; code?: string } }).error
          : undefined;
      const message = errorBody !== undefined ? String(errorBody.message ?? errorBody.code ?? 'Request failed') : `Request failed (${response.status})`;
      return { ok: false, message, code: errorBody?.code, status: response.status };
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
  /** Set only for a gameday room (rounds rotating across a competition's live fixtures); `null`
   * otherwise, including for single-fixture matchday rooms. */
  readonly gamedayCompetitionId: string | null;
  /** The matchday fixture's status (SCHEDULED, LIVE, FINISHED, POSTPONED ...); `null` for general rooms. */
  readonly fixtureStatus?: string | null;
}

export const createRoom = (input: {
  readonly category: 'matchday' | 'general';
  readonly fixtureId?: string;
  /** Mutually exclusive with `fixtureId` — see `apps/api/src/rooms/schemas.ts`. */
  readonly gameday?: boolean;
  readonly competitionId?: string;
  readonly hostNickname?: string;
  readonly settings?: Record<string, unknown>;
}): Promise<ApiResult<CreateRoomResponse>> => {
  const body: Record<string, unknown> = { category: input.category };
  if (input.fixtureId !== undefined) body.fixtureId = input.fixtureId;
  if (input.gameday === true) body.gameday = true;
  if (input.competitionId !== undefined) body.competitionId = input.competitionId;
  if (input.hostNickname !== undefined) body.hostNickname = input.hostNickname;
  if (input.settings !== undefined) body.settings = input.settings;
  return request<CreateRoomResponse>('/rooms', { method: 'POST', body: JSON.stringify(body) });
};

export const fetchRoomByPin = (pin: string): Promise<ApiResult<RoomSummary>> =>
  request<RoomSummary>(`/rooms/pin/${encodeURIComponent(pin)}`);

export const fetchRoomById = (roomId: string): Promise<ApiResult<RoomSummary>> =>
  request<RoomSummary>(`/rooms/${encodeURIComponent(roomId)}`);

/* ------------------------------- competitions ------------------------------- */

export interface Competition {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly country: string;
  readonly logoUrl: string | null;
  readonly currentSeason: string;
}

export type FixtureStatus =
  | 'SCHEDULED'
  | 'LIVE'
  | 'HALF_TIME'
  | 'EXTRA_TIME'
  | 'PENALTIES'
  | 'FINISHED'
  | 'POSTPONED'
  | 'CANCELLED';

export interface FixtureTeamSummary {
  readonly name: string;
  readonly crestUrl: string | null;
}

export interface FixtureSummary {
  readonly fixtureId: string;
  readonly kickoff: string;
  readonly status: FixtureStatus;
  readonly minute: number | null;
  readonly competitionId: string;
  readonly homeTeam: FixtureTeamSummary;
  readonly awayTeam: FixtureTeamSummary;
}

export const listCompetitions = (): Promise<ApiResult<{ competitions: readonly Competition[] }>> =>
  request('/competitions');

export const listCompetitionFixtures = (
  competitionId: string,
  window?: 'live' | 'upcoming',
): Promise<ApiResult<{ fixtures: readonly FixtureSummary[] }>> =>
  request(
    `/competitions/${encodeURIComponent(competitionId)}/fixtures${window !== undefined ? `?window=${window}` : ''}`,
  );

/**
 * Sign-in/registration and friends are not part of this app's own web UI — every user here is a
 * guest (pick a nickname, host or join). The `IdentityProvider`/friends REST endpoints stay live on
 * `apps/api` as a seam for a future hub integration to supply an already-authenticated session and a
 * populated friends list; this client simply has no reason to call them right now.
 */
