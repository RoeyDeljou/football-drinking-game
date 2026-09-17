/**
 * Room, session and round state.
 *
 * All state is immutable and JSON-serializable: the reducer returns a new object, and the server
 * can persist or replay it without any engine cooperation.
 */

import { z } from 'zod';
import type { GameModuleId, PlayerId, RoomId, RoundId, SessionId } from './ids.js';
import type { GameCategory, RoundKind, RoundOutcome, TurnState } from './module.js';
import type { PenaltyCaps, RecordedPenalty } from './penalties.js';
import { DEFAULT_PENALTY_CAPS, penaltyCapsSchema } from './penalties.js';
import type { RankablePlayer, ScoringConfig } from './scoring.js';
import { DEFAULT_SCORING, scoringConfigSchema } from './scoring.js';

/**
 * The room lifecycle. `aborted` is a terminal branch reachable from any non-terminal phase;
 * `finished` is the normal terminal phase.
 */
export const ROOM_PHASES = [
  'lobby',
  'loading',
  'playing',
  'roundReveal',
  'intermission',
  'finished',
  'aborted',
] as const;

export type RoomPhase = (typeof ROOM_PHASES)[number];

export const TERMINAL_PHASES: readonly RoomPhase[] = ['finished', 'aborted'];

export type AbortReason =
  'HOST_ABORTED' | 'HOST_LEFT' | 'ALL_PLAYERS_LEFT' | 'DATA_UNAVAILABLE' | 'TIMED_OUT';

export interface RoomSettings {
  readonly maxPlayers: number;
  readonly minPlayersToStart: number;
  readonly roundsPerSession: number;
  /** Default answer window; a module may shorten it per round. */
  readonly answerWindowMs: number;
  /** How long the reveal screen holds before the room may advance automatically. */
  readonly revealHoldMs: number;
  readonly intermissionMs: number;
  readonly allowLateJoin: boolean;
  readonly scoring: ScoringConfig;
  readonly penaltyCaps: PenaltyCaps;
}

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  maxPlayers: 20,
  minPlayersToStart: 2,
  roundsPerSession: 8,
  answerWindowMs: 20_000,
  revealHoldMs: 5_000,
  intermissionMs: 8_000,
  allowLateJoin: true,
  scoring: DEFAULT_SCORING,
  penaltyCaps: DEFAULT_PENALTY_CAPS,
};

export const roomSettingsSchema = z
  .object({
    maxPlayers: z.number().int().min(1).max(50),
    minPlayersToStart: z.number().int().min(1).max(50),
    roundsPerSession: z.number().int().min(1).max(50),
    answerWindowMs: z.number().int().min(1_000).max(600_000),
    revealHoldMs: z.number().int().min(0).max(120_000),
    intermissionMs: z.number().int().min(0).max(120_000),
    allowLateJoin: z.boolean(),
    scoring: scoringConfigSchema,
    penaltyCaps: penaltyCapsSchema,
  })
  .strict();

/** Partial settings the host may push from the lobby. */
export const roomSettingsPatchSchema = roomSettingsSchema.partial();
export type RoomSettingsPatch = z.infer<typeof roomSettingsPatchSchema>;

/**
 * Merge a patch onto settings. Written field by field rather than spread, because
 * `exactOptionalPropertyTypes` means a spread would smuggle `undefined` into required fields.
 */
export const mergeRoomSettings = (base: RoomSettings, patch: RoomSettingsPatch): RoomSettings => ({
  maxPlayers: patch.maxPlayers ?? base.maxPlayers,
  minPlayersToStart: patch.minPlayersToStart ?? base.minPlayersToStart,
  roundsPerSession: patch.roundsPerSession ?? base.roundsPerSession,
  answerWindowMs: patch.answerWindowMs ?? base.answerWindowMs,
  revealHoldMs: patch.revealHoldMs ?? base.revealHoldMs,
  intermissionMs: patch.intermissionMs ?? base.intermissionMs,
  allowLateJoin: patch.allowLateJoin ?? base.allowLateJoin,
  scoring: patch.scoring ?? base.scoring,
  penaltyCaps: patch.penaltyCaps ?? base.penaltyCaps,
});

export interface PlayerState extends RankablePlayer {
  readonly id: PlayerId;
  readonly nickname: string;
  readonly isGuest: boolean;
  readonly connected: boolean;
  readonly joinedAt: number;
  readonly leftAt: number | null;
  /** Cumulative across every game played in this room. */
  readonly score: number;
  readonly streak: number;
  readonly bestStreak: number;
  readonly correctAnswers: number;
  readonly roundsWon: number;
  readonly totalResponseMs: number;
  /** Cumulative sips owed. */
  readonly sips: number;
}

export interface SubmissionRecord {
  readonly playerId: PlayerId;
  readonly submittedAt: number;
  readonly elapsedMs: number;
  /** Module-validated payload, stored opaquely. */
  readonly payload: unknown;
  /** Monotonic per round, so "who answered first" survives identical timestamps. */
  readonly sequence: number;
}

export type RoundStatus = 'open' | 'locked' | 'resolved';

export interface RoundRecord {
  readonly id: RoundId;
  readonly index: number;
  readonly moduleId: GameModuleId;
  readonly kind: RoundKind;
  readonly status: RoundStatus;
  readonly startedAt: number;
  readonly answerWindowMs: number | null;
  readonly deadlineAt: number | null;
  readonly lockedAt: number | null;
  readonly revealedAt: number | null;
  readonly contentKey: string;
  readonly publicPayload: unknown;
  readonly privatePayloads: Readonly<Partial<Record<PlayerId, unknown>>>;
  /** Hidden. Never leaves the engine before reveal — see `projectFor`. */
  readonly solution: unknown;
  readonly submissions: readonly SubmissionRecord[];
  readonly outcome: RoundOutcome | null;
  /** `MatchEvent.id`s already folded in, which makes live-event ingestion idempotent. */
  readonly observedEventIds: readonly string[];
  readonly turn: TurnState | null;
}

export interface SessionState {
  readonly id: SessionId;
  readonly moduleId: GameModuleId;
  readonly category: GameCategory;
  readonly config: unknown;
  readonly roundsPlanned: number;
  readonly rounds: readonly RoundRecord[];
  readonly startedAt: number;
  readonly finishedAt: number | null;
  /** Sips accrued in this session per player, for the per-session penalty cap. */
  readonly sipsByPlayer: Readonly<Partial<Record<PlayerId, number>>>;
}

export type LoadingStepStatus = 'pending' | 'active' | 'done' | 'failed';

export interface LoadingStep {
  /** Matches the data layer's prefetch step keys (`fixtures`, `lineups`, `squads`, `stats`). */
  readonly key: string;
  readonly status: LoadingStepStatus;
  readonly detail: string | null;
}

export interface LoadingState {
  readonly steps: readonly LoadingStep[];
  readonly startedAt: number;
  readonly failedReason: string | null;
}

export interface GameSelection {
  readonly moduleId: GameModuleId;
  /** Already validated by the module's `configSchema`. */
  readonly config: unknown;
}

export interface RoomState {
  readonly id: RoomId;
  readonly pin: string;
  readonly phase: RoomPhase;
  readonly hostPlayerId: PlayerId;
  readonly players: readonly PlayerState[];
  readonly settings: RoomSettings;
  readonly selection: GameSelection | null;
  readonly loading: LoadingState | null;
  readonly sessions: readonly SessionState[];
  readonly activeSessionIndex: number | null;
  /** Every penalty ever applied in this room, already capped. The room's drink tally. */
  readonly penalties: readonly RecordedPenalty[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly abortReason: AbortReason | null;
  /** Players the host kicked. They can neither rejoin nor reconnect. */
  readonly kickedPlayerIds: readonly PlayerId[];
  /**
   * The RNG's internal state. The reducer rebuilds the generator from this on every dispatch and
   * writes the advanced state back, so a room restored from any `RoomStore` continues the same random
   * sequence. Opaque: only the `RngSource` that produced it understands it.
   */
  readonly rngState: number;
  /** Bumped on every accepted action, so the transport can drop out-of-order broadcasts. */
  readonly version: number;
}

export interface CreateRoomInput {
  readonly roomId: RoomId;
  readonly pin: string;
  readonly hostPlayerId: PlayerId;
  readonly hostNickname: string;
  readonly hostIsGuest: boolean;
  readonly now: number;
  /** Initial RNG state, e.g. `MULBERRY32.initialState(seed)`. Store the seed if you want to audit replays. */
  readonly rngState: number;
  readonly settings?: RoomSettingsPatch;
}

export const createPlayer = (input: {
  readonly id: PlayerId;
  readonly nickname: string;
  readonly isGuest: boolean;
  readonly now: number;
}): PlayerState => ({
  id: input.id,
  nickname: input.nickname,
  isGuest: input.isGuest,
  connected: true,
  joinedAt: input.now,
  leftAt: null,
  score: 0,
  streak: 0,
  bestStreak: 0,
  correctAnswers: 0,
  roundsWon: 0,
  totalResponseMs: 0,
  sips: 0,
});

/** The only way to mint a room. Not an action: rooms are created by the transport, then reduced. */
export const createRoom = (input: CreateRoomInput): RoomState => ({
  id: input.roomId,
  pin: input.pin,
  phase: 'lobby',
  hostPlayerId: input.hostPlayerId,
  players: [
    createPlayer({
      id: input.hostPlayerId,
      nickname: input.hostNickname,
      isGuest: input.hostIsGuest,
      now: input.now,
    }),
  ],
  settings: mergeRoomSettings(DEFAULT_ROOM_SETTINGS, input.settings ?? {}),
  selection: null,
  loading: null,
  sessions: [],
  activeSessionIndex: null,
  penalties: [],
  createdAt: input.now,
  updatedAt: input.now,
  abortReason: null,
  kickedPlayerIds: [],
  rngState: input.rngState >>> 0,
  version: 1,
});

/* ------------------------------- selectors -------------------------------- */

export const findPlayer = (room: RoomState, playerId: PlayerId): PlayerState | undefined =>
  room.players.find((player) => player.id === playerId);

export const isHost = (room: RoomState, playerId: PlayerId): boolean => room.hostPlayerId === playerId;

export const isTerminal = (room: RoomState): boolean => TERMINAL_PHASES.includes(room.phase);

export const activeSession = (room: RoomState): SessionState | undefined =>
  room.activeSessionIndex === null ? undefined : room.sessions[room.activeSessionIndex];

export const currentRound = (room: RoomState): RoundRecord | undefined => {
  const session = activeSession(room);
  if (session === undefined) return undefined;
  return session.rounds[session.rounds.length - 1];
};

export const activePlayers = (room: RoomState): readonly PlayerState[] =>
  room.players.filter((player) => player.leftAt === null);

export const hasSubmitted = (round: RoundRecord, playerId: PlayerId): boolean =>
  round.submissions.some((submission) => submission.playerId === playerId);
