/**
 * The full action union.
 *
 * Two families:
 *  - **client actions** arrive from a phone over the socket and must be validated with
 *    `parseClientAction` before they reach the reducer. Every client action names a real player:
 *    there is no nullable actor anywhere in this family, so a phone can never impersonate the system.
 *  - **system actions** (`SYSTEM_ACTION_TYPES`) are raised by the server itself — loading progress,
 *    the live event feed, clock ticks, deadline locks, and server-side aborts. None of them can be
 *    produced by `parseClientAction`; the server must never forward a client payload as one.
 *
 * The server is still responsible for binding identity: a socket may only send actions whose
 * `playerId`/`actorId` is the player authenticated on that socket.
 */

import type { MatchEvent } from '@fdg/football-data';
import { z } from 'zod';
import type { GameModuleId, PlayerId, RoundId } from './ids.js';
import { asGameModuleId, asPlayerId, asRoundId } from './ids.js';
import type { AbortReason, LoadingStepStatus, RoomSettingsPatch } from './state.js';
import { roomSettingsPatchSchema } from './state.js';

export interface PlayerJoinAction {
  readonly type: 'PLAYER_JOIN';
  readonly playerId: PlayerId;
  readonly nickname: string;
  readonly isGuest: boolean;
}

export interface PlayerLeaveAction {
  readonly type: 'PLAYER_LEAVE';
  readonly playerId: PlayerId;
}

export interface PlayerDisconnectedAction {
  readonly type: 'PLAYER_DISCONNECTED';
  readonly playerId: PlayerId;
}

export interface PlayerReconnectedAction {
  readonly type: 'PLAYER_RECONNECTED';
  readonly playerId: PlayerId;
}

export interface TransferHostAction {
  readonly type: 'TRANSFER_HOST';
  readonly actorId: PlayerId;
  readonly targetPlayerId: PlayerId;
}

export interface KickPlayerAction {
  readonly type: 'KICK_PLAYER';
  readonly actorId: PlayerId;
  readonly targetPlayerId: PlayerId;
}

export interface UpdateSettingsAction {
  readonly type: 'UPDATE_SETTINGS';
  readonly actorId: PlayerId;
  readonly patch: RoomSettingsPatch;
}

export interface SelectGameAction {
  readonly type: 'SELECT_GAME';
  readonly actorId: PlayerId;
  readonly moduleId: GameModuleId;
  /** Raw config; the reducer validates it with the module's `configSchema`. */
  readonly config: unknown;
}

export interface StartLoadingAction {
  readonly type: 'START_LOADING';
  readonly actorId: PlayerId;
  readonly stepKeys: readonly string[];
}

export interface LoadingProgressAction {
  readonly type: 'LOADING_PROGRESS';
  readonly stepKey: string;
  readonly status: LoadingStepStatus;
  readonly detail: string | null;
}

export interface LoadingFailedAction {
  readonly type: 'LOADING_FAILED';
  readonly reason: string;
}

export interface StartSessionAction {
  readonly type: 'START_SESSION';
  readonly actorId: PlayerId;
}

export interface SubmitAnswerAction {
  readonly type: 'SUBMIT_ANSWER';
  readonly playerId: PlayerId;
  readonly roundId: RoundId;
  /** Unvalidated; the module's `validateSubmission` decides. */
  readonly payload: unknown;
}

/** The host closes answers early. Host-only. */
export interface LockRoundAction {
  readonly type: 'LOCK_ROUND';
  readonly actorId: PlayerId;
}

/** The host reveals the round now. Host-only. */
export interface RevealRoundAction {
  readonly type: 'REVEAL_ROUND';
  readonly actorId: PlayerId;
}

/** Server-only: close answers because a server-side timer decided so. */
export interface SystemLockRoundAction {
  readonly type: 'SYSTEM_LOCK_ROUND';
}

/** Server-only: reveal the round (e.g. an auto-advance timer). */
export interface SystemRevealRoundAction {
  readonly type: 'SYSTEM_REVEAL_ROUND';
}

/** Host-driven progression: reveal → intermission → next round, or → finished. */
export interface AdvanceAction {
  readonly type: 'ADVANCE';
  readonly actorId: PlayerId;
}

export interface EndSessionAction {
  readonly type: 'END_SESSION';
  readonly actorId: PlayerId;
}

export interface FinishRoomAction {
  readonly type: 'FINISH_ROOM';
  readonly actorId: PlayerId;
}

/** The host abandons the room. Host-only. */
export interface AbortRoomAction {
  readonly type: 'ABORT_ROOM';
  readonly actorId: PlayerId;
  readonly reason: AbortReason;
}

/** Server-only: abort for an operational reason (idle timeout, data outage, shutdown). */
export interface SystemAbortRoomAction {
  readonly type: 'SYSTEM_ABORT_ROOM';
  readonly reason: AbortReason;
}

/** Live feed. De-duplicated by `MatchEvent.id` inside the reducer, so repeated polls are safe. */
export interface MatchEventsAction {
  readonly type: 'MATCH_EVENTS';
  readonly events: readonly MatchEvent[];
}

/** Lets the engine close an expired answer window without the host touching anything. */
export interface TickAction {
  readonly type: 'TICK';
}

export type RoomAction =
  | PlayerJoinAction
  | PlayerLeaveAction
  | PlayerDisconnectedAction
  | PlayerReconnectedAction
  | TransferHostAction
  | KickPlayerAction
  | UpdateSettingsAction
  | SelectGameAction
  | StartLoadingAction
  | LoadingProgressAction
  | LoadingFailedAction
  | StartSessionAction
  | SubmitAnswerAction
  | LockRoundAction
  | RevealRoundAction
  | AdvanceAction
  | EndSessionAction
  | FinishRoomAction
  | AbortRoomAction
  | SystemLockRoundAction
  | SystemRevealRoundAction
  | SystemAbortRoomAction
  | MatchEventsAction
  | TickAction;

export type RoomActionType = RoomAction['type'];

/** Actions only the host may dispatch. The reducer enforces this; the server should too. */
export const HOST_ONLY_ACTIONS: readonly RoomActionType[] = [
  'TRANSFER_HOST',
  'KICK_PLAYER',
  'UPDATE_SETTINGS',
  'SELECT_GAME',
  'START_LOADING',
  'START_SESSION',
  'ADVANCE',
  'END_SESSION',
  'FINISH_ROOM',
  'LOCK_ROUND',
  'REVEAL_ROUND',
  'ABORT_ROOM',
];

export const isHostOnlyAction = (type: RoomActionType): boolean => HOST_ONLY_ACTIONS.includes(type);

/**
 * Actions only the server may originate. `parseClientAction` can never return one of these, and the
 * transport must never build one from client input.
 */
export const SYSTEM_ACTION_TYPES: readonly RoomActionType[] = [
  'LOADING_PROGRESS',
  'LOADING_FAILED',
  'MATCH_EVENTS',
  'TICK',
  'SYSTEM_LOCK_ROUND',
  'SYSTEM_REVEAL_ROUND',
  'SYSTEM_ABORT_ROOM',
];

export const isSystemAction = (type: RoomActionType): boolean => SYSTEM_ACTION_TYPES.includes(type);

/* ------------------------------- validation ------------------------------- */

const playerId = z.string().min(1).max(64).transform(asPlayerId);
const nickname = z.string().min(1).max(24);
const abortReason = z.enum([
  'HOST_ABORTED',
  'HOST_LEFT',
  'ALL_PLAYERS_LEFT',
  'DATA_UNAVAILABLE',
  'TIMED_OUT',
]);

/**
 * Every action a client is allowed to originate. System actions are deliberately absent, and every
 * actor field is a required, non-null player id: a phone may never inject match events, fake loading
 * progress, or act as the system.
 */
export const clientActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('PLAYER_JOIN'),
      playerId,
      nickname,
      isGuest: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal('PLAYER_LEAVE'), playerId }).strict(),
  z.object({ type: z.literal('PLAYER_DISCONNECTED'), playerId }).strict(),
  z.object({ type: z.literal('PLAYER_RECONNECTED'), playerId }).strict(),
  z
    .object({
      type: z.literal('TRANSFER_HOST'),
      actorId: playerId,
      targetPlayerId: playerId,
    })
    .strict(),
  z.object({ type: z.literal('KICK_PLAYER'), actorId: playerId, targetPlayerId: playerId }).strict(),
  z
    .object({
      type: z.literal('UPDATE_SETTINGS'),
      actorId: playerId,
      patch: roomSettingsPatchSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('SELECT_GAME'),
      actorId: playerId,
      moduleId: z.string().min(1).max(64).transform(asGameModuleId),
      config: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal('START_LOADING'),
      actorId: playerId,
      stepKeys: z.array(z.string().min(1).max(64)).max(16),
    })
    .strict(),
  z.object({ type: z.literal('START_SESSION'), actorId: playerId }).strict(),
  z
    .object({
      type: z.literal('SUBMIT_ANSWER'),
      playerId,
      roundId: z.string().min(1).max(64).transform(asRoundId),
      payload: z.unknown(),
    })
    .strict(),
  z.object({ type: z.literal('LOCK_ROUND'), actorId: playerId }).strict(),
  z.object({ type: z.literal('REVEAL_ROUND'), actorId: playerId }).strict(),
  z.object({ type: z.literal('ADVANCE'), actorId: playerId }).strict(),
  z.object({ type: z.literal('END_SESSION'), actorId: playerId }).strict(),
  z.object({ type: z.literal('FINISH_ROOM'), actorId: playerId }).strict(),
  z.object({ type: z.literal('ABORT_ROOM'), actorId: playerId, reason: abortReason }).strict(),
]);

export type ClientAction = z.infer<typeof clientActionSchema>;

export type ParseClientActionResult =
  | { readonly ok: true; readonly action: RoomAction }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Convenience wrapper so the socket layer never has to touch Zod error shapes. */
export const parseClientAction = (input: unknown): ParseClientActionResult => {
  const result = clientActionSchema.safeParse(input);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    };
  }
  const data = result.data;
  // `z.unknown()` infers an optional key, so the two payload-carrying actions are rebuilt
  // explicitly to satisfy the required-property action interfaces.
  if (data.type === 'SELECT_GAME') {
    return {
      ok: true,
      action: {
        type: 'SELECT_GAME',
        actorId: data.actorId,
        moduleId: data.moduleId,
        config: data.config,
      },
    };
  }
  if (data.type === 'SUBMIT_ANSWER') {
    return {
      ok: true,
      action: {
        type: 'SUBMIT_ANSWER',
        playerId: data.playerId,
        roundId: data.roundId,
        payload: data.payload,
      },
    };
  }
  return { ok: true, action: data };
};
