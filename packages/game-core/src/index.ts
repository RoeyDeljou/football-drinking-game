/**
 * @fdg/game-core — platform-agnostic engine for the football drinking game.
 *
 * Nothing in this package may import React, Next, Node built-ins, Socket.IO, Prisma, or perform I/O.
 * Time and randomness arrive through injected ports so every session is deterministically replayable.
 *
 * Typical server wiring:
 *
 * ```ts
 * // Once, when the room is created. The RNG state lives inside RoomState from here on.
 * const room = createRoom({ ...ids, now: Date.now(), rngState: MULBERRY32.initialState(seed) });
 *
 * // On every dispatch. Nothing in deps is room-specific state, so any server instance can serve it.
 * const deps = {
 *   clock: { now: () => Date.now() },          // the *server* owns the real clock
 *   rng: MULBERRY32,                           // rebuilt from state.rngState inside the reducer
 *   modules: createDefaultRegistry(),
 *   data: await buildRoundDataContext(room),   // from @fdg/football-data
 * };
 * const parsed = parseClientAction(socketPayload); // client input; never builds a SYSTEM_* action
 * if (!parsed.ok) return rejectSocket(parsed.issues);
 * const { state, events, rejection } = reduceRoom(await roomStore.load(roomId), parsed.action, deps);
 * if (rejection === null) await roomStore.save(state); // JSON round-trips losslessly, RNG included
 * for (const player of state.players) send(player.id, projectFor(state, player.id, deps));
 *
 * // Server-owned timers dispatch system actions directly: { type: 'TICK' }, { type: 'SYSTEM_ABORT_ROOM', reason }.
 * ```
 */

export const GAME_CORE_VERSION = '0.1.0';

/* ids */
export type { ById, GameModuleId, PlayerId, RoomId, RoundId, SessionId } from './ids.js';
export { asGameModuleId, asPlayerId, asRoomId, asRoundId, asSessionId } from './ids.js';

/* ports */
export type { ControllableClock, EngineClock, ResumableRng, Rng, RngSource } from './ports.js';
export { createControllableClock, createFixedClock, createSeededRng, MULBERRY32 } from './ports.js';

/* errors */
export { EngineInvariantError } from './errors.js';

/* football data seam */
export type { DataRequirementKey, PlayabilityCode, PlayabilityResult, RoundDataContext } from './data.js';
export { checkModulePlayable, DATA_REQUIREMENT_KEYS, EMPTY_DATA_CONTEXT } from './data.js';

/* scoring */
export type {
  LeaderboardRow,
  RankablePlayer,
  RoundScore,
  ScoreAnswerInput,
  ScoreBreakdown,
  ScoringConfig,
  SpeedCurve,
} from './scoring.js';
export {
  buildLeaderboard,
  compareRankable,
  DEFAULT_SCORING,
  isFullTie,
  pickRoundWinners,
  scoreAnswer,
  scoreNoAnswer,
  scoringConfigSchema,
  speedBonus,
  speedBonusFraction,
  streakMultiplier,
} from './scoring.js';

/* penalties */
export type {
  ApplyPenaltiesInput,
  ApplyPenaltiesResult,
  CapReason,
  PenaltyCaps,
  PenaltyEvent,
  PenaltyMeta,
  PenaltyReason,
  PenaltyTarget,
  RecordedPenalty,
} from './penalties.js';
export {
  applyPenalties,
  DEFAULT_PENALTY_CAPS,
  penalty,
  penaltyCapsSchema,
  penaltyEventSchema,
  PENALTY_REASONS,
  resolvePenaltyRecipients,
  tallySips,
  tallySipsForRound,
} from './penalties.js';

/* module contract */
export type {
  AfterSubmissionContext,
  AfterSubmissionResult,
  ConfigParseResult,
  EngineGameModule,
  GameCategory,
  GameModuleDefinition,
  GeneratedRound,
  GenerateRoundResult,
  ModuleShape,
  ObserveEventsContext,
  ObserveEventsResult,
  PerPlayer,
  ProjectRoundContext,
  RoundGenerationContext,
  RoundGenerationFailure,
  RoundKind,
  RoundOutcome,
  RoundPlayerView,
  RoundProjection,
  RoundView,
  RoundVisibility,
  ScoreRoundContext,
  SubmissionRejectionCode,
  SubmissionValidation,
  TurnState,
  TypedSubmission,
  ValidateSubmissionContext,
} from './module.js';
export { defineGameModule, ROUND_KINDS } from './module.js';

/* state */
export type {
  AbortReason,
  CreateRoomInput,
  GameSelection,
  LoadingState,
  LoadingStep,
  LoadingStepStatus,
  PlayerState,
  RoomPhase,
  RoomSettings,
  RoomSettingsPatch,
  RoomState,
  RoundRecord,
  RoundStatus,
  SessionState,
  SubmissionRecord,
} from './state.js';
export {
  activePlayers,
  activeSession,
  createPlayer,
  createRoom,
  currentRound,
  DEFAULT_ROOM_SETTINGS,
  findPlayer,
  hasSubmitted,
  isHost,
  isTerminal,
  ROOM_PHASES,
  roomSettingsPatchSchema,
  roomSettingsSchema,
  TERMINAL_PHASES,
} from './state.js';

/* actions */
export type {
  AbortRoomAction,
  AdvanceAction,
  ClientAction,
  EndSessionAction,
  FinishRoomAction,
  KickPlayerAction,
  LoadingFailedAction,
  LoadingProgressAction,
  LockRoundAction,
  MatchEventsAction,
  ParseClientActionResult,
  PlayerDisconnectedAction,
  PlayerJoinAction,
  PlayerLeaveAction,
  PlayerReconnectedAction,
  RevealRoundAction,
  RoomAction,
  RoomActionType,
  SelectGameAction,
  StartLoadingAction,
  StartSessionAction,
  SubmitAnswerAction,
  SystemAbortRoomAction,
  SystemLockRoundAction,
  SystemRevealRoundAction,
  TickAction,
  TransferHostAction,
  UpdateSettingsAction,
} from './actions.js';
export {
  clientActionSchema,
  HOST_ONLY_ACTIONS,
  isHostOnlyAction,
  isSystemAction,
  parseClientAction,
  SYSTEM_ACTION_TYPES,
} from './actions.js';

/* reducer */
export type { EngineDeps, EngineEvent, EngineRejection, Reduction, RejectionCode } from './reducer.js';
export { reduceAll, reduceRoom } from './reducer.js';

/* projection */
export type {
  DrinkTallyRow,
  ProjectedPlayer,
  ProjectedRoom,
  ProjectedRound,
  ProjectedRoundPreReveal,
  ProjectedRoundRevealed,
  ProjectedSelf,
  ProjectedSession,
  ProjectedSubmission,
  ProjectedSubmissionStatus,
  ProjectionDeps,
} from './projection.js';
export { projectFor, projectForHostScreen } from './projection.js';

/* modules + registry */
export type { GameModuleRegistry, ModulePlayability } from './modules/registry.js';
export { createDefaultRegistry, createModuleRegistry, PHASE_1_MODULES } from './modules/registry.js';

export type {
  M1Counters,
  M1MarketKind,
  M1OptionOutcome,
  M1OptionSettlement,
  M1Settlement,
} from './modules/m1-match-markets.js';
export {
  EMPTY_M1_COUNTERS,
  foldMatchEvents,
  M1_DEFAULT_CONFIG,
  M1_ID,
  m1MatchMarkets,
  settleAllMarkets,
  settleMarket,
} from './modules/m1-match-markets.js';

export type { M2FactKind } from './modules/m2-who-is-that-player.js';
export {
  FACT_KIND_LEAK_FIELD,
  M2_DEFAULT_CONFIG,
  M2_ID,
  m2WhoIsThatPlayer,
  redactOptionsForFact,
} from './modules/m2-who-is-that-player.js';

export { M3_DEFAULT_CONFIG, M3_ID, m3ShirtNumber } from './modules/m3-shirt-number.js';

export type { G1Clue } from './modules/g1-guess-the-player.js';
export {
  G1_DEFAULT_CONFIG,
  G1_ID,
  g1GuessThePlayer,
  visibleClueCount,
} from './modules/g1-guess-the-player.js';

export type { G6QuestionKind } from './modules/g6-trivia-rush.js';
export { G6_DEFAULT_CONFIG, G6_ID, g6TriviaRush } from './modules/g6-trivia-rush.js';

/* module authoring helpers */
export type { ChoiceScoringInput, PitchPlayer } from './modules/helpers.js';
export {
  buildOptions,
  lastCorrectPlayer,
  nonSubmitters,
  pitchPlayers,
  scoreChoiceRound,
  selfPenalties,
  uniqueValues,
} from './modules/helpers.js';
