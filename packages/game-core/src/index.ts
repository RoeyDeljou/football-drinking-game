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
  DrinkRollTier,
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
  DRINK_ROLL_TABLE,
  penalty,
  penaltyCapsSchema,
  penaltyEventSchema,
  PENALTY_REASONS,
  resolvePenaltyRecipients,
  rollDrinkSips,
  tallySips,
  tallySipsForRound,
} from './penalties.js';

/* live events: match clock, goal attribution, the per-round live-event window */
export type { GoalSide, MatchClock } from './match-events.js';
export {
  clockOf,
  compareMatchClock,
  GOAL_EVENT_TYPES,
  goalCreditedSide,
  goalScorerOf,
  isGoalEvent,
  latestClockOf,
  laterClock,
  matchClockSchema,
} from './match-events.js';
export type { LiveStatsSnapshot } from './live-stats.js';
export { matchStatsActionSchema, playerMatchStatsSchema, teamMatchStatsSchema } from './live-stats.js';
export type { LiveBaselineSource, LiveEventWindow, LiveEventWindowMode, LiveWindowStep } from './live-window.js';
export { DEFAULT_LIVE_EVENT_WINDOW, initialLiveWindow, stepLiveWindow } from './live-window.js';
/* free-text name matching (M10; reusable by recall games) */
export type { GuessAssignment, GuessResult, GuessStatus, NameCandidate } from './name-matching.js';
export {
  assignGuesses,
  compactName,
  editDistance,
  nameDistance,
  nameKeys,
  normalizeName,
  typoAllowance,
} from './name-matching.js';
/* module contract */
export type {
  AfterSubmissionContext,
  AfterSubmissionResult,
  ConfigParseResult,
  ContentScheduleContext,
  EngineGameModule,
  GameCategory,
  GameModuleDefinition,
  GeneratedRound,
  GenerateRoundResult,
  ModuleShape,
  ObserveEventsContext,
  ObserveEventsResult,
  ObserveStatsContext,
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
  MatchStatsAction,
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
export {
  createDefaultRegistry,
  createModuleRegistry,
  generalMixed,
  matchdayMixed,
  MIXED_ROTATION_EXCLUDED,
  PHASE_1_MODULES,
  STANDALONE_MODULES,
} from './modules/registry.js';

export type {
  MixedConfig,
  MixedModuleOptions,
  MixedPublicPayload,
  MixedSolution,
  MixedSummary,
  ParsedMixedContentKey,
} from './modules/mixed.js';
export {
  createMixedModule,
  G_MIX_ID,
  isMixable,
  M_MIX_ID,
  MIXABLE_ROUND_KINDS,
  MIXED_CONTENT_KEY_SEPARATOR,
  mixedContentKey,
  orderMixedCandidates,
  parseMixedContentKey,
  SHIRT_NUMBER_DISPLAYS,
  SHIRT_NUMBER_QUIZZES,
  suppressesShirtNumbers,
  suppressOptionShirtNumbers,
} from './modules/mixed.js';

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
export type { LiveEventKind, FiredEvent } from './modules/live-event-kinds.js';
export {
  LIVE_EVENT_KINDS,
  liveEventKindOf,
  liveEventSideOf,
  orderLiveBatch,
} from './modules/live-event-kinds.js';
export type { M4Action, M4DraftEntry, M4LogEntry, M4PublicPayload, M4Solution } from './modules/m4-your-man.js';
export { draftStarters, M4_ACTIONS, M4_DEFAULT_CONFIG, M4_ID, m4ActionsOf, m4YourMan } from './modules/m4-your-man.js';
export type { M8Bracket, M8Duel, M8PublicPayload, M8Solution, M8Stat, M8StatRow } from './modules/m8-stat-duel.js';
export {
  M8_DEFAULT_CONFIG,
  M8_ID,
  M8_STATS,
  M8_TIEBREAK_ORDER,
  m8StatDuel,
  m8StatValue,
  playM8Bracket,
} from './modules/m8-stat-duel.js';
export type { M9Answer, M9PublicPayload, M9Question, M9QuestionType, M9Settlement, M9Solution } from './modules/m9-flash-rounds.js';
export {
  ANSWERS as M9_ANSWERS,
  buildM9Question,
  M9_DEFAULT_CONFIG,
  M9_ID,
  M9_LAST_MINUTE,
  M9_MIN_ANSWER_MS,
  m9ContentKey,
  m9FlashRounds,
  MIN_WINDOW_MINUTES as M9_MIN_WINDOW_MINUTES,
  QUESTION_TYPES as M9_QUESTION_TYPES,
  settleM9,
} from './modules/m9-flash-rounds.js';
export type { M5Fire, M5PublicPayload, M5Solution } from './modules/m5-event-roulette.js';
export {
  dealEventKinds,
  M5_DEFAULT_CONFIG,
  M5_DEFAULT_EVENT_KINDS,
  M5_ID,
  m5EventRoulette,
} from './modules/m5-event-roulette.js';
export type { BingoCellSpec, BingoTick, M6Card, M6Cell, M6PublicPayload, M6Solution } from './modules/m6-match-bingo.js';
export {
  bingoCellId,
  bingoLines,
  dealBingoCards,
  M6_CARD_MIX,
  M6_CELL_TIERS,
  M6_DEFAULT_CONFIG,
  M6_ID,
  m6MatchBingo,
  tickBingoCards,
} from './modules/m6-match-bingo.js';
export type { M7Outcome, M7PublicPayload, M7Solution, M7Submission } from './modules/m7-minute-sniper.js';
export {
  M7_DEFAULT_CONFIG,
  M7_ID,
  M7_LAST_MINUTE,
  m7MinPick,
  m7MinuteSniper,
  m7SettlingEvent,
} from './modules/m7-minute-sniper.js';
export type { M10PublicPayload, M10Solution, M10Submission } from './modules/m10-lineup-recall.js';
export {
  gradeLineupGuesses,
  M10_DEFAULT_CONFIG,
  M10_ID,
  M10_MAX_GUESS_LENGTH,
  m10ContentKey,
  m10LineupRecall,
} from './modules/m10-lineup-recall.js';

export type { G1Clue, G1ClueKind } from './modules/g1-guess-the-player.js';
export {
  G1_DEFAULT_CONFIG,
  G1_ID,
  g1GuessThePlayer,
  visibleClueCount,
} from './modules/g1-guess-the-player.js';

export type { G3ClubStep } from './modules/g3-career-path.js';
export {
  careerEliminationStep,
  careerPath,
  G3_DEFAULT_CONFIG,
  G3_ID,
  g3CareerPath,
} from './modules/g3-career-path.js';

export type { G6QuestionKind } from './modules/g6-trivia-rush.js';
export { G6_DEFAULT_CONFIG, G6_ID, g6TriviaRush } from './modules/g6-trivia-rush.js';

/* module authoring helpers */
export type { ChoiceScoringInput, PitchPlayer } from './modules/helpers.js';
export {
  buildOptions,
  lastCorrectPlayer,
  nonSubmitters,
  pitchPlayers,
  ROLLED_PENALTY_META,
  rolledSelfPenalties,
  scoreChoiceRound,
  selfPenalties,
  uniqueValues,
} from './modules/helpers.js';
