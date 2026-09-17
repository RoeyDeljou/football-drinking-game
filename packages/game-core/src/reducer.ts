/**
 * The room reducer: `(state, action, deps) => { state, events, rejection }`.
 *
 * Pure. No mutation, no `Date.now()`, no `Math.random()` — time comes from `deps.clock`, randomness
 * from `deps.rng` (rebuilt from `state.rngState` on every dispatch), football data from `deps.data`.
 * A rejected action returns the *identical* state object, so the transport can skip the broadcast.
 */

import type { MatchEvent } from '@fdg/football-data';
import type { RoomAction } from './actions.js';
import type { RoundDataContext } from './data.js';
import { checkModulePlayable } from './data.js';
import type { GameModuleId, PlayerId, RoundId, SessionId } from './ids.js';
import { asRoundId, asSessionId } from './ids.js';
import type {
  EngineGameModule,
  ModuleShape,
  RoundKind,
  RoundOutcome,
  RoundPlayerView,
  RoundView,
  SubmissionRejectionCode,
  TurnState,
  TypedSubmission,
} from './module.js';
import type { GameModuleRegistry } from './modules/registry.js';
import type { RecordedPenalty } from './penalties.js';
import { applyPenalties, tallySipsForRound } from './penalties.js';
import type { EngineClock, ResumableRng, RngSource } from './ports.js';
import type { RoundScore } from './scoring.js';
import type {
  AbortReason,
  LoadingState,
  LoadingStep,
  PlayerState,
  RoomPhase,
  RoomSettings,
  RoomState,
  RoundRecord,
  SessionState,
  SubmissionRecord,
} from './state.js';
import {
  activePlayers,
  activeSession,
  createPlayer,
  findPlayer,
  isTerminal,
  mergeRoomSettings,
  roomSettingsSchema,
} from './state.js';

export interface EngineDeps {
  readonly clock: EngineClock;
  /**
   * Where randomness comes from. The reducer calls `rng.fromState(state.rngState)` per dispatch and
   * persists the advanced state, so randomness survives serialization. `MULBERRY32` by default.
   */
  readonly rng: RngSource;
  readonly modules: GameModuleRegistry;
  /** Football data for round generation. `EMPTY_DATA_CONTEXT` for games that need none. */
  readonly data: RoundDataContext;
}

export type RejectionCode =
  | 'ROOM_TERMINAL'
  | 'WRONG_PHASE'
  | 'NOT_HOST'
  | 'PLAYER_NOT_FOUND'
  | 'PLAYER_ALREADY_JOINED'
  | 'PLAYER_KICKED'
  | 'NICKNAME_TAKEN'
  | 'ROOM_FULL'
  | 'LATE_JOIN_DISABLED'
  | 'CANNOT_KICK_HOST'
  | 'INVALID_SETTINGS'
  | 'UNKNOWN_MODULE'
  | 'INVALID_CONFIG'
  | 'DATA_UNAVAILABLE'
  | 'NO_GAME_SELECTED'
  | 'LOADING_INCOMPLETE'
  | 'NOT_ENOUGH_PLAYERS'
  | 'TOO_MANY_PLAYERS'
  | 'ROUND_GENERATION_FAILED'
  | 'NO_ACTIVE_SESSION'
  | 'SESSION_FINISHED'
  | 'ROUND_NOT_FOUND'
  | 'ROUND_CLOSED'
  | 'DEADLINE_PASSED'
  | 'DUPLICATE_SUBMISSION'
  | 'INVALID_SUBMISSION'
  | 'NOT_YOUR_TURN'
  | 'PLAYER_ELIMINATED'
  | 'UNKNOWN_LOADING_STEP'
  /** A `long-running-bet` round self-locks (slip lock, then full time); a manual lock has no meaning. */
  | 'ROUND_NOT_LOCKABLE';

export interface EngineRejection {
  readonly code: RejectionCode;
  /** Machine-oriented detail (a Zod issue, an id). Not user-facing copy. */
  readonly detail: string | null;
  /** For `INVALID_SUBMISSION`: the module's own reason (`MARKET_SETTLED`, `UNKNOWN_OPTION`, …). */
  readonly submissionCode: SubmissionRejectionCode | null;
}

export type EngineEvent =
  | { readonly type: 'PHASE_CHANGED'; readonly from: RoomPhase; readonly to: RoomPhase }
  | { readonly type: 'PLAYER_JOINED'; readonly playerId: PlayerId }
  | { readonly type: 'PLAYER_LEFT'; readonly playerId: PlayerId }
  | {
      readonly type: 'PLAYER_CONNECTION_CHANGED';
      readonly playerId: PlayerId;
      readonly connected: boolean;
    }
  | { readonly type: 'PLAYER_KICKED'; readonly playerId: PlayerId }
  | { readonly type: 'HOST_CHANGED'; readonly playerId: PlayerId }
  | { readonly type: 'SETTINGS_UPDATED' }
  | { readonly type: 'GAME_SELECTED'; readonly moduleId: GameModuleId }
  | { readonly type: 'LOADING_UPDATED' }
  | { readonly type: 'LOADING_FAILED'; readonly reason: string }
  | {
      readonly type: 'SESSION_STARTED';
      readonly sessionId: SessionId;
      readonly moduleId: GameModuleId;
    }
  | { readonly type: 'ROUND_STARTED'; readonly roundId: RoundId; readonly index: number }
  | { readonly type: 'ROUND_UPDATED'; readonly roundId: RoundId }
  | {
      readonly type: 'SUBMISSION_ACCEPTED';
      readonly playerId: PlayerId;
      readonly roundId: RoundId;
      readonly replaced: boolean;
    }
  | {
      readonly type: 'TURN_CHANGED';
      readonly roundId: RoundId;
      readonly playerId: PlayerId | null;
    }
  | { readonly type: 'ROUND_LOCKED'; readonly roundId: RoundId }
  | {
      readonly type: 'ROUND_REVEALED';
      readonly roundId: RoundId;
      readonly winnerIds: readonly PlayerId[];
    }
  | { readonly type: 'PENALTIES_APPLIED'; readonly penalties: readonly RecordedPenalty[] }
  | { readonly type: 'SESSION_FINISHED'; readonly sessionId: SessionId }
  | { readonly type: 'ROOM_FINISHED' }
  | { readonly type: 'ROOM_ABORTED'; readonly reason: AbortReason };

export interface Reduction {
  readonly state: RoomState;
  readonly events: readonly EngineEvent[];
  /** `null` when the action was accepted. */
  readonly rejection: EngineRejection | null;
}

/* ------------------------------- internals -------------------------------- */

/** Round kinds whose answer deadline also ends the round. */
const DEADLINE_ENDS_ROUND: readonly RoundKind[] = ['simultaneous-answer', 'pairing'];

const reject = (
  state: RoomState,
  code: RejectionCode,
  detail: string | null = null,
  submissionCode: SubmissionRejectionCode | null = null,
): Reduction => ({
  state,
  events: [],
  rejection: { code, detail, submissionCode },
});

const accept = (state: RoomState, events: readonly EngineEvent[]): Reduction => ({
  state,
  events,
  rejection: null,
});

const unchanged = (state: RoomState): Reduction => ({ state, events: [], rejection: null });

/**
 * Chain a follow-up reduction after an accepted one, keeping both sets of events. If the follow-up is
 * rejected, the first (already valid) reduction stands on its own.
 */
const then = (first: Reduction, second: Reduction): Reduction =>
  second.rejection !== null
    ? first
    : { state: second.state, events: [...first.events, ...second.events], rejection: null };

const commit = (state: RoomState, patch: Partial<RoomState>, now: number): RoomState => ({
  ...state,
  ...patch,
  updatedAt: now,
  version: state.version + 1,
});

const phaseChange = (from: RoomPhase, to: RoomPhase): readonly EngineEvent[] =>
  from === to ? [] : [{ type: 'PHASE_CHANGED', from, to }];

const toPlayerViews = (room: RoomState): readonly RoundPlayerView[] =>
  activePlayers(room).map((player) => ({
    id: player.id,
    nickname: player.nickname,
    connected: player.connected,
    score: player.score,
    streak: player.streak,
  }));

const toRoundView = (round: RoundRecord): RoundView<ModuleShape> => ({
  id: round.id,
  index: round.index,
  startedAt: round.startedAt,
  answerWindowMs: round.answerWindowMs,
  deadlineAt: round.deadlineAt,
  publicPayload: round.publicPayload,
  privatePayloads: round.privatePayloads,
  solution: round.solution,
  turn: round.turn,
});

const toTypedSubmissions = (round: RoundRecord): readonly TypedSubmission<ModuleShape>[] =>
  round.submissions.map((submission) => ({
    playerId: submission.playerId,
    payload: submission.payload,
    submittedAt: submission.submittedAt,
    elapsedMs: submission.elapsedMs,
  }));

interface ActiveSlice {
  readonly session: SessionState;
  readonly sessionIndex: number;
  readonly round: RoundRecord;
  readonly roundIndex: number;
  readonly module: EngineGameModule;
}

const readActiveSlice = (state: RoomState, deps: EngineDeps): ActiveSlice | null => {
  const sessionIndex = state.activeSessionIndex;
  if (sessionIndex === null) return null;
  const session = state.sessions[sessionIndex];
  if (session === undefined) return null;
  const roundIndex = session.rounds.length - 1;
  const round = session.rounds[roundIndex];
  if (round === undefined) return null;
  const module = deps.modules.get(session.moduleId);
  if (module === undefined) return null;
  return { session, sessionIndex, round, roundIndex, module };
};

const writeRound = (
  state: RoomState,
  slice: { sessionIndex: number; roundIndex: number },
  round: RoundRecord,
  sessionPatch: Partial<SessionState> = {},
): readonly SessionState[] =>
  state.sessions.map((session, index) => {
    if (index !== slice.sessionIndex) return session;
    return {
      ...session,
      ...sessionPatch,
      rounds: session.rounds.map((existing, roundIndex) =>
        roundIndex === slice.roundIndex ? round : existing,
      ),
    };
  });

const nicknameTaken = (state: RoomState, nickname: string): boolean =>
  activePlayers(state).some(
    (player) => player.nickname.trim().toLowerCase() === nickname.trim().toLowerCase(),
  );

const loadingSucceeded = (loading: LoadingState | null): boolean =>
  loading !== null && loading.failedReason === null && loading.steps.every((step) => step.status === 'done');

/* --------------------------------- turns ---------------------------------- */

/** A player may take a turn if they are still in the chain, still in the room and connected. */
const canTakeTurn = (state: RoomState, turn: TurnState, playerId: PlayerId): boolean => {
  if (turn.eliminated.includes(playerId)) return false;
  const player = findPlayer(state, playerId);
  return player !== undefined && player.leftAt === null && player.connected;
};

/**
 * The next index, strictly after `fromIndex` and wrapping round (so a lone eligible player can take
 * consecutive turns), whose player can take a turn. `null` when nobody can.
 */
const nextTurnIndex = (state: RoomState, turn: TurnState, fromIndex: number): number | null => {
  const length = turn.order.length;
  for (let offset = 1; offset <= length; offset += 1) {
    const index = (fromIndex + offset) % length;
    const candidate = turn.order[index];
    if (candidate !== undefined && canTakeTurn(state, turn, candidate)) return index;
  }
  return null;
};

/* --------------------------- round construction --------------------------- */

interface BuildRoundOutcome {
  readonly ok: boolean;
  readonly round: RoundRecord | null;
  readonly detail: string | null;
}

const buildRound = (
  state: RoomState,
  session: SessionState,
  module: EngineGameModule,
  deps: EngineDeps,
  rng: ResumableRng,
  roundIndex: number,
): BuildRoundOutcome => {
  const now = deps.clock.now();
  const result = module.generateRound({
    config: session.config,
    sessionId: session.id,
    roundIndex,
    players: toPlayerViews(state),
    data: deps.data,
    rng,
    now,
    usedContentKeys: session.rounds.map((round) => round.contentKey),
    defaultAnswerWindowMs: state.settings.answerWindowMs,
  });

  if (!result.ok) {
    return { ok: false, round: null, detail: `${result.reason}:${result.detail ?? ''}` };
  }

  const generated = result.round;
  const turnOrder = generated.turnOrder;
  const turn: TurnState | null =
    module.kind === 'turn-based' && turnOrder !== null && turnOrder.length > 0
      ? { order: turnOrder, activeIndex: 0, eliminated: [] }
      : null;

  return {
    ok: true,
    detail: null,
    round: {
      id: asRoundId(`${session.id}:r${roundIndex + 1}`),
      index: roundIndex,
      moduleId: module.id,
      kind: module.kind,
      status: 'open',
      startedAt: now,
      answerWindowMs: generated.answerWindowMs,
      deadlineAt: generated.answerWindowMs === null ? null : now + generated.answerWindowMs,
      lockedAt: null,
      revealedAt: null,
      contentKey: generated.contentKey,
      publicPayload: generated.publicPayload,
      privatePayloads: generated.privatePayloads,
      solution: generated.solution,
      submissions: [],
      outcome: null,
      observedEventIds: [],
      turn,
    },
  };
};

/* ------------------------------- resolution -------------------------------- */

const applyOutcomeToPlayers = (
  players: readonly PlayerState[],
  outcome: RoundOutcome,
  sipsByPlayer: Readonly<Partial<Record<PlayerId, number>>>,
  round: RoundRecord,
): readonly PlayerState[] =>
  players.map((player) => {
    const score = outcome.scores.find((entry) => entry.playerId === player.id);
    const submission = round.submissions.find((entry) => entry.playerId === player.id);
    const sips = sipsByPlayer[player.id] ?? 0;
    const won = outcome.winnerIds.includes(player.id);

    if (score === undefined) {
      // No score entry leaves points and streak alone, but a win and sips still count.
      if (sips === 0 && !won) return player;
      return {
        ...player,
        roundsWon: player.roundsWon + (won ? 1 : 0),
        sips: player.sips + sips,
      };
    }

    const streak = score.correct ? player.streak + 1 : 0;
    return {
      ...player,
      score: player.score + score.points,
      streak,
      bestStreak: Math.max(player.bestStreak, streak),
      correctAnswers: player.correctAnswers + (score.correct ? 1 : 0),
      roundsWon: player.roundsWon + (won ? 1 : 0),
      totalResponseMs: player.totalResponseMs + (submission?.elapsedMs ?? 0),
      sips: player.sips + sips,
    };
  });

const mergeSips = (
  base: Readonly<Partial<Record<PlayerId, number>>>,
  added: Readonly<Partial<Record<PlayerId, number>>>,
): Readonly<Partial<Record<PlayerId, number>>> => {
  const merged: Partial<Record<PlayerId, number>> = { ...base };
  for (const [key, value] of Object.entries(added)) {
    if (value === undefined) continue;
    const playerId = key as PlayerId;
    merged[playerId] = (merged[playerId] ?? 0) + value;
  }
  return merged;
};

/**
 * Locks the round if it is still open, scores it through the module, applies capped penalties and
 * moves the room to `roundReveal`.
 */
const revealRound = (state: RoomState, deps: EngineDeps): Reduction => {
  const slice = readActiveSlice(state, deps);
  if (slice === null) return reject(state, 'NO_ACTIVE_SESSION');
  if (slice.round.status === 'resolved') return reject(state, 'ROUND_CLOSED', 'already resolved');

  const now = deps.clock.now();
  const events: EngineEvent[] = [];

  const locked: RoundRecord =
    slice.round.status === 'open' ? { ...slice.round, status: 'locked', lockedAt: now } : slice.round;
  if (slice.round.status === 'open') events.push({ type: 'ROUND_LOCKED', roundId: locked.id });

  const outcome = slice.module.scoreRound({
    config: slice.session.config,
    round: toRoundView(locked),
    submissions: toTypedSubmissions(locked),
    players: toPlayerViews(state),
    scoring: state.settings.scoring,
    now,
  });

  const penaltyResult = applyPenalties({
    events: outcome.penalties,
    participantIds: activePlayers(state).map((player) => player.id),
    caps: state.settings.penaltyCaps,
    sessionId: slice.session.id,
    roundId: locked.id,
    sessionSipsByPlayer: slice.session.sipsByPlayer,
    roundSipsByPlayer: tallySipsForRound(state.penalties, locked.id),
  });

  const resolved: RoundRecord = {
    ...locked,
    status: 'resolved',
    revealedAt: now,
    outcome,
  };

  const sessions = writeRound(state, slice, resolved, {
    sipsByPlayer: mergeSips(slice.session.sipsByPlayer, penaltyResult.sipsByPlayer),
  });

  const next = commit(
    state,
    {
      phase: 'roundReveal',
      sessions,
      players: applyOutcomeToPlayers(state.players, outcome, penaltyResult.sipsByPlayer, resolved),
      penalties: [...state.penalties, ...penaltyResult.recorded],
    },
    now,
  );

  events.push({ type: 'ROUND_REVEALED', roundId: resolved.id, winnerIds: outcome.winnerIds });
  if (penaltyResult.recorded.length > 0) {
    events.push({ type: 'PENALTIES_APPLIED', penalties: penaltyResult.recorded });
  }
  events.push(...phaseChange(state.phase, 'roundReveal'));

  return accept(next, events);
};

const lockRound = (state: RoomState, deps: EngineDeps): Reduction => {
  if (state.phase !== 'playing') return reject(state, 'WRONG_PHASE', state.phase);
  const slice = readActiveSlice(state, deps);
  if (slice === null) return reject(state, 'NO_ACTIVE_SESSION');
  if (slice.round.status !== 'open') return reject(state, 'ROUND_CLOSED', slice.round.status);
  // A long-running bet resolves itself: the slip locks at the first observed event (or the slip
  // deadline), and the round itself only ends when the module reports it resolved (M1: full time).
  // A manual lock in between would freeze MATCH_EVENTS processing while markets are still live,
  // silently starving the round of the data it needs to ever resolve — so it is refused outright.
  if (slice.module.kind === 'long-running-bet') {
    return reject(state, 'ROUND_NOT_LOCKABLE', slice.round.kind);
  }
  const now = deps.clock.now();

  return accept(
    commit(
      state,
      { sessions: writeRound(state, slice, { ...slice.round, status: 'locked', lockedAt: now }) },
      now,
    ),
    [{ type: 'ROUND_LOCKED', roundId: slice.round.id }],
  );
};

const abortRoom = (state: RoomState, reason: AbortReason, now: number): Reduction => {
  const sessions =
    state.activeSessionIndex === null ? state.sessions : finishSession(state, state.activeSessionIndex, now);
  return accept(commit(state, { phase: 'aborted', abortReason: reason, sessions }, now), [
    { type: 'ROOM_ABORTED', reason },
    ...phaseChange(state.phase, 'aborted'),
  ]);
};

const everyoneSubmitted = (state: RoomState, round: RoundRecord): boolean => {
  const eligible = activePlayers(state).filter((player) => player.connected);
  if (eligible.length === 0) return false;
  return eligible.every((player) =>
    round.submissions.some((submission) => submission.playerId === player.id),
  );
};

const finishSession = (state: RoomState, sessionIndex: number, now: number): readonly SessionState[] =>
  state.sessions.map((session, index) =>
    index === sessionIndex && session.finishedAt === null ? { ...session, finishedAt: now } : session,
  );

/**
 * After a presence change (leave, disconnect, kick): if a turn-based round is waiting on a player who
 * can no longer act, pass the turn to the next player who can, or end the round if nobody can.
 */
const repairTurn = (previous: Reduction, deps: EngineDeps): Reduction => {
  const state = previous.state;
  if (previous.rejection !== null || state.phase !== 'playing') return previous;
  const slice = readActiveSlice(state, deps);
  if (slice === null || slice.round.status !== 'open' || slice.round.turn === null) return previous;

  const turn = slice.round.turn;
  const active = turn.order[turn.activeIndex];
  if (active !== undefined && canTakeTurn(state, turn, active)) return previous;

  const nextIndex = nextTurnIndex(state, turn, turn.activeIndex);
  if (nextIndex === null) return then(previous, revealRound(state, deps));

  const now = deps.clock.now();
  const round: RoundRecord = { ...slice.round, turn: { ...turn, activeIndex: nextIndex } };
  return then(
    previous,
    accept(commit(state, { sessions: writeRound(state, slice, round) }, now), [
      { type: 'TURN_CHANGED', roundId: round.id, playerId: turn.order[nextIndex] ?? null },
    ]),
  );
};

/**
 * The `actorId` of a host-only action, read by exhaustively switching over every member of
 * `RoomAction` — not by an `'actorId' in action` runtime check. A future action variant that is
 * host-only but happens to omit (or rename) its `actorId` field would silently pass a structural
 * check; here it is instead a compile error, because the `never` branch below stops accepting the
 * switch until every action type is listed on one side or the other.
 */
const hostActorOf = (action: RoomAction): PlayerId | null => {
  switch (action.type) {
    case 'TRANSFER_HOST':
    case 'KICK_PLAYER':
    case 'UPDATE_SETTINGS':
    case 'SELECT_GAME':
    case 'START_LOADING':
    case 'START_SESSION':
    case 'ADVANCE':
    case 'END_SESSION':
    case 'FINISH_ROOM':
    case 'LOCK_ROUND':
    case 'REVEAL_ROUND':
    case 'ABORT_ROOM':
      return action.actorId;
    case 'PLAYER_JOIN':
    case 'PLAYER_LEAVE':
    case 'PLAYER_DISCONNECTED':
    case 'PLAYER_RECONNECTED':
    case 'SUBMIT_ANSWER':
    case 'LOADING_PROGRESS':
    case 'LOADING_FAILED':
    case 'SYSTEM_LOCK_ROUND':
    case 'SYSTEM_REVEAL_ROUND':
    case 'SYSTEM_ABORT_ROOM':
    case 'MATCH_EVENTS':
    case 'TICK':
      return null;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
};

/* ------------------------------- the reducer ------------------------------- */

/**
 * The single entry point. `deps` are injected per dispatch so the server can supply freshly
 * prefetched football data without the engine ever fetching anything.
 *
 * Randomness: a generator is rebuilt from `state.rngState`; if the action is accepted, the advanced
 * RNG state is written back into the resulting state. A rejected action consumes no randomness.
 */
export const reduceRoom = (state: RoomState, action: RoomAction, deps: EngineDeps): Reduction => {
  const rng = deps.rng.fromState(state.rngState);
  const result = reduceWith(state, action, deps, rng);
  const advanced = rng.state();
  if (result.rejection !== null || advanced === result.state.rngState) return result;
  return { ...result, state: { ...result.state, rngState: advanced } };
};

const reduceWith = (state: RoomState, action: RoomAction, deps: EngineDeps, rng: ResumableRng): Reduction => {
  const now = deps.clock.now();

  if (isTerminal(state) && action.type !== 'TICK') {
    return reject(state, 'ROOM_TERMINAL', state.phase);
  }

  // Every host-only action carries a required, non-null `actorId`; there is no system bypass here.
  const hostActor = hostActorOf(action);
  if (hostActor !== null && hostActor !== state.hostPlayerId) {
    return reject(state, 'NOT_HOST', hostActor);
  }

  switch (action.type) {
    /* ---------------------------- presence ---------------------------- */

    case 'PLAYER_JOIN': {
      if (state.kickedPlayerIds.includes(action.playerId)) {
        return reject(state, 'PLAYER_KICKED', action.playerId);
      }
      const existing = findPlayer(state, action.playerId);
      if (existing !== undefined && existing.leftAt === null) {
        return reject(state, 'PLAYER_ALREADY_JOINED', action.playerId);
      }
      if (state.phase !== 'lobby' && !state.settings.allowLateJoin) {
        return reject(state, 'LATE_JOIN_DISABLED', state.phase);
      }
      if (activePlayers(state).length >= state.settings.maxPlayers) {
        return reject(state, 'ROOM_FULL');
      }
      if (nicknameTaken(state, action.nickname)) {
        return reject(state, 'NICKNAME_TAKEN', action.nickname);
      }

      const player = createPlayer({
        id: action.playerId,
        nickname: action.nickname,
        isGuest: action.isGuest,
        now,
      });
      const players =
        existing === undefined
          ? [...state.players, player]
          : state.players.map((candidate) =>
              candidate.id === action.playerId
                ? { ...candidate, connected: true, leftAt: null, nickname: action.nickname }
                : candidate,
            );

      return accept(commit(state, { players }, now), [{ type: 'PLAYER_JOINED', playerId: action.playerId }]);
    }

    case 'PLAYER_LEAVE': {
      const player = findPlayer(state, action.playerId);
      if (player === undefined || player.leftAt !== null) {
        return reject(state, 'PLAYER_NOT_FOUND', action.playerId);
      }

      const players = state.players.map((candidate) =>
        candidate.id === action.playerId ? { ...candidate, connected: false, leftAt: now } : candidate,
      );
      const remaining = players.filter((candidate) => candidate.leftAt === null);
      const events: EngineEvent[] = [{ type: 'PLAYER_LEFT', playerId: action.playerId }];

      if (remaining.length === 0) {
        events.push({ type: 'ROOM_ABORTED', reason: 'ALL_PLAYERS_LEFT' });
        events.push(...phaseChange(state.phase, 'aborted'));
        return accept(
          commit(
            state,
            {
              players,
              phase: 'aborted',
              abortReason: 'ALL_PLAYERS_LEFT',
              sessions:
                state.activeSessionIndex === null
                  ? state.sessions
                  : finishSession(state, state.activeSessionIndex, now),
            },
            now,
          ),
          events,
        );
      }

      let hostPlayerId = state.hostPlayerId;
      if (hostPlayerId === action.playerId) {
        const successor = remaining
          .slice()
          .sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1))[0];
        if (successor !== undefined) {
          hostPlayerId = successor.id;
          events.push({ type: 'HOST_CHANGED', playerId: hostPlayerId });
        }
      }

      return repairTurn(accept(commit(state, { players, hostPlayerId }, now), events), deps);
    }

    case 'PLAYER_DISCONNECTED':
    case 'PLAYER_RECONNECTED': {
      const connected = action.type === 'PLAYER_RECONNECTED';
      if (connected && state.kickedPlayerIds.includes(action.playerId)) {
        return reject(state, 'PLAYER_KICKED', action.playerId);
      }
      const player = findPlayer(state, action.playerId);
      if (player === undefined || player.leftAt !== null) {
        return reject(state, 'PLAYER_NOT_FOUND', action.playerId);
      }
      if (player.connected === connected) return unchanged(state);
      const changed = accept(
        commit(
          state,
          {
            players: state.players.map((candidate) =>
              candidate.id === action.playerId ? { ...candidate, connected } : candidate,
            ),
          },
          now,
        ),
        [{ type: 'PLAYER_CONNECTION_CHANGED', playerId: action.playerId, connected }],
      );
      return connected ? changed : repairTurn(changed, deps);
    }

    case 'TRANSFER_HOST': {
      const target = findPlayer(state, action.targetPlayerId);
      if (target === undefined || target.leftAt !== null) {
        return reject(state, 'PLAYER_NOT_FOUND', action.targetPlayerId);
      }
      if (state.hostPlayerId === action.targetPlayerId) return unchanged(state);
      return accept(commit(state, { hostPlayerId: action.targetPlayerId }, now), [
        { type: 'HOST_CHANGED', playerId: action.targetPlayerId },
      ]);
    }

    case 'KICK_PLAYER': {
      if (action.targetPlayerId === state.hostPlayerId) {
        return reject(state, 'CANNOT_KICK_HOST');
      }
      const target = findPlayer(state, action.targetPlayerId);
      if (target === undefined || target.leftAt !== null) {
        return reject(state, 'PLAYER_NOT_FOUND', action.targetPlayerId);
      }
      return repairTurn(
        accept(
          commit(
            state,
            {
              players: state.players.map((candidate) =>
                candidate.id === action.targetPlayerId
                  ? { ...candidate, connected: false, leftAt: now }
                  : candidate,
              ),
              kickedPlayerIds: [...state.kickedPlayerIds, action.targetPlayerId],
            },
            now,
          ),
          [{ type: 'PLAYER_KICKED', playerId: action.targetPlayerId }],
        ),
        deps,
      );
    }

    /* ----------------------------- setup ------------------------------ */

    case 'UPDATE_SETTINGS': {
      if (state.phase !== 'lobby' && state.phase !== 'intermission') {
        return reject(state, 'WRONG_PHASE', state.phase);
      }
      const merged: RoomSettings = mergeRoomSettings(state.settings, action.patch);
      const parsed = roomSettingsSchema.safeParse(merged);
      if (!parsed.success) {
        return reject(state, 'INVALID_SETTINGS', parsed.error.issues[0]?.message ?? 'invalid');
      }
      if (merged.minPlayersToStart > merged.maxPlayers) {
        return reject(state, 'INVALID_SETTINGS', 'minPlayersToStart > maxPlayers');
      }
      return accept(commit(state, { settings: merged }, now), [{ type: 'SETTINGS_UPDATED' }]);
    }

    case 'SELECT_GAME': {
      if (state.phase !== 'lobby' && state.phase !== 'intermission') {
        return reject(state, 'WRONG_PHASE', state.phase);
      }
      const module = deps.modules.get(action.moduleId);
      if (module === undefined) return reject(state, 'UNKNOWN_MODULE', action.moduleId);

      const config = module.parseConfig(action.config ?? module.defaultConfig);
      if (!config.ok) return reject(state, 'INVALID_CONFIG', config.issues.join('; '));

      const playability = checkModulePlayable(module, deps.data.quality);
      if (!playability.playable) {
        return reject(state, 'DATA_UNAVAILABLE', playability.missing.join(','));
      }

      return accept(commit(state, { selection: { moduleId: module.id, config: config.config } }, now), [
        { type: 'GAME_SELECTED', moduleId: module.id },
      ]);
    }

    case 'START_LOADING': {
      const retryable = state.phase === 'loading' && state.loading?.failedReason !== null;
      if (state.phase !== 'lobby' && !retryable) return reject(state, 'WRONG_PHASE', state.phase);
      if (state.selection === null) return reject(state, 'NO_GAME_SELECTED');

      const steps: readonly LoadingStep[] = action.stepKeys.map((key, index) => ({
        key,
        status: index === 0 ? 'active' : 'pending',
        detail: null,
      }));

      return accept(
        commit(state, { phase: 'loading', loading: { steps, startedAt: now, failedReason: null } }, now),
        [{ type: 'LOADING_UPDATED' }, ...phaseChange(state.phase, 'loading')],
      );
    }

    case 'LOADING_PROGRESS': {
      if (state.phase !== 'loading' || state.loading === null) {
        return reject(state, 'WRONG_PHASE', state.phase);
      }
      const loading = state.loading;
      if (!loading.steps.some((step) => step.key === action.stepKey)) {
        return reject(state, 'UNKNOWN_LOADING_STEP', action.stepKey);
      }
      return accept(
        commit(
          state,
          {
            loading: {
              ...loading,
              steps: loading.steps.map((step) =>
                step.key === action.stepKey
                  ? { key: step.key, status: action.status, detail: action.detail }
                  : step,
              ),
            },
          },
          now,
        ),
        [{ type: 'LOADING_UPDATED' }],
      );
    }

    case 'LOADING_FAILED': {
      if (state.phase !== 'loading' || state.loading === null) {
        return reject(state, 'WRONG_PHASE', state.phase);
      }
      return accept(commit(state, { loading: { ...state.loading, failedReason: action.reason } }, now), [
        { type: 'LOADING_FAILED', reason: action.reason },
      ]);
    }

    /* ----------------------------- session ---------------------------- */

    case 'START_SESSION': {
      if (state.phase !== 'lobby' && state.phase !== 'loading' && state.phase !== 'intermission') {
        return reject(state, 'WRONG_PHASE', state.phase);
      }
      // From the loading screen a game may only start once every step finished and nothing failed;
      // a failed load is retried with START_LOADING, never skipped.
      if (state.phase === 'loading' && !loadingSucceeded(state.loading)) {
        return reject(state, 'LOADING_INCOMPLETE', state.loading?.failedReason ?? null);
      }
      const selection = state.selection;
      if (selection === null) return reject(state, 'NO_GAME_SELECTED');
      const module = deps.modules.get(selection.moduleId);
      if (module === undefined) return reject(state, 'UNKNOWN_MODULE', selection.moduleId);

      const roster = activePlayers(state);
      const minPlayers = Math.max(state.settings.minPlayersToStart, module.minPlayers);
      if (roster.length < minPlayers) {
        return reject(state, 'NOT_ENOUGH_PLAYERS', `${roster.length}/${minPlayers}`);
      }
      if (module.maxPlayers !== null && roster.length > module.maxPlayers) {
        return reject(state, 'TOO_MANY_PLAYERS', `${roster.length}/${module.maxPlayers}`);
      }

      const sessionId = asSessionId(`${state.id}:s${state.sessions.length + 1}`);
      const session: SessionState = {
        id: sessionId,
        moduleId: module.id,
        category: module.category,
        config: selection.config,
        roundsPlanned: state.settings.roundsPerSession,
        rounds: [],
        startedAt: now,
        finishedAt: null,
        sipsByPlayer: {},
      };

      const built = buildRound(state, session, module, deps, rng, 0);
      if (!built.ok || built.round === null) {
        return reject(state, 'ROUND_GENERATION_FAILED', built.detail);
      }

      const withRoundOne: SessionState = { ...session, rounds: [built.round] };
      const previousSessions =
        state.activeSessionIndex === null
          ? state.sessions
          : finishSession(state, state.activeSessionIndex, now);

      return accept(
        commit(
          state,
          {
            phase: 'playing',
            sessions: [...previousSessions, withRoundOne],
            activeSessionIndex: previousSessions.length,
            loading: null,
          },
          now,
        ),
        [
          { type: 'SESSION_STARTED', sessionId, moduleId: module.id },
          { type: 'ROUND_STARTED', roundId: built.round.id, index: 0 },
          ...phaseChange(state.phase, 'playing'),
        ],
      );
    }

    /* ---------------------------- gameplay ---------------------------- */

    case 'SUBMIT_ANSWER': {
      if (state.phase !== 'playing') return reject(state, 'WRONG_PHASE', state.phase);
      const slice = readActiveSlice(state, deps);
      if (slice === null) return reject(state, 'NO_ACTIVE_SESSION');
      if (slice.round.id !== action.roundId) {
        return reject(state, 'ROUND_NOT_FOUND', action.roundId);
      }
      if (slice.round.status !== 'open') return reject(state, 'ROUND_CLOSED', slice.round.status);

      const player = findPlayer(state, action.playerId);
      if (player === undefined || player.leftAt !== null) {
        return reject(state, 'PLAYER_NOT_FOUND', action.playerId);
      }
      if (slice.round.deadlineAt !== null && now > slice.round.deadlineAt) {
        return reject(state, 'DEADLINE_PASSED', String(slice.round.deadlineAt));
      }

      const turn = slice.round.turn;
      if (turn !== null) {
        if (turn.eliminated.includes(action.playerId)) {
          return reject(state, 'PLAYER_ELIMINATED', action.playerId);
        }
        if (turn.order[turn.activeIndex] !== action.playerId) {
          return reject(state, 'NOT_YOUR_TURN', action.playerId);
        }
      }

      const already = slice.round.submissions.some((submission) => submission.playerId === action.playerId);
      if (already && !slice.module.allowResubmission) {
        return reject(state, 'DUPLICATE_SUBMISSION', action.playerId);
      }

      const elapsedMs = Math.max(0, now - slice.round.startedAt);
      const validation = slice.module.validateSubmission({
        config: slice.session.config,
        round: toRoundView(slice.round),
        playerId: action.playerId,
        raw: action.payload,
        submittedAt: now,
        elapsedMs,
        alreadySubmitted: already,
      });
      if (!validation.ok) {
        return reject(state, 'INVALID_SUBMISSION', validation.detail, validation.code);
      }

      const nextSequence =
        slice.round.submissions.reduce((max, entry) => Math.max(max, entry.sequence), 0) + 1;
      const record: SubmissionRecord = {
        playerId: action.playerId,
        submittedAt: now,
        elapsedMs,
        payload: validation.payload,
        sequence: nextSequence,
      };
      const submissions = already
        ? slice.round.submissions.map((entry) => (entry.playerId === action.playerId ? record : entry))
        : [...slice.round.submissions, record];

      let nextRound: RoundRecord = { ...slice.round, submissions };
      const events: EngineEvent[] = [
        {
          type: 'SUBMISSION_ACCEPTED',
          playerId: action.playerId,
          roundId: nextRound.id,
          replaced: already,
        },
      ];

      const hook = slice.module.afterSubmission({
        config: slice.session.config,
        round: toRoundView(nextRound),
        playerId: action.playerId,
        payload: validation.payload,
        submissions: toTypedSubmissions(nextRound),
        players: toPlayerViews(state),
        now,
      });

      let lockRequested = hook?.lockRound === true;
      const eliminated = hook?.eliminate ?? [];

      if (turn !== null) {
        const nextEliminated = [...new Set([...turn.eliminated, ...eliminated])];
        const survivors = turn.order.filter((id) => !nextEliminated.includes(id));
        if (survivors.length <= 1) lockRequested = true;
        const advancedTurn: TurnState = { ...turn, eliminated: nextEliminated };
        const nextIndex = nextTurnIndex(state, advancedTurn, turn.activeIndex);
        if (nextIndex === null) lockRequested = true;
        const activeIndex = nextIndex ?? turn.activeIndex;
        nextRound = { ...nextRound, turn: { ...advancedTurn, activeIndex } };
        events.push({
          type: 'TURN_CHANGED',
          roundId: nextRound.id,
          playerId: nextIndex === null ? null : (turn.order[activeIndex] ?? null),
        });
      }

      const autoLock =
        lockRequested || (slice.module.kind === 'simultaneous-answer' && everyoneSubmitted(state, nextRound));

      const withSubmission = accept(
        commit(state, { sessions: writeRound(state, slice, nextRound) }, now),
        events,
      );
      if (!autoLock) return withSubmission;
      return then(withSubmission, revealRound(withSubmission.state, deps));
    }

    case 'LOCK_ROUND':
    case 'SYSTEM_LOCK_ROUND':
      return lockRound(state, deps);

    case 'REVEAL_ROUND':
    case 'SYSTEM_REVEAL_ROUND': {
      if (state.phase !== 'playing') return reject(state, 'WRONG_PHASE', state.phase);
      return revealRound(state, deps);
    }

    case 'MATCH_EVENTS': {
      if (state.phase !== 'playing') return reject(state, 'WRONG_PHASE', state.phase);
      const slice = readActiveSlice(state, deps);
      if (slice === null) return reject(state, 'NO_ACTIVE_SESSION');
      if (!slice.module.supportsLiveEvents) return unchanged(state);
      // Once the round has left `open` there is genuinely nowhere for this batch to go — surface a
      // real rejection rather than a silent no-op, so the server layer can see and log a dropped
      // batch instead of reading a false success.
      if (slice.round.status !== 'open') return reject(state, 'ROUND_CLOSED', slice.round.status);

      const seen = new Set(slice.round.observedEventIds);
      const fresh: MatchEvent[] = [];
      for (const event of action.events) {
        // De-duplicate against earlier batches *and* within this batch.
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        fresh.push(event);
      }
      if (fresh.length === 0) return unchanged(state);

      const observation = slice.module.observeEvents({
        config: slice.session.config,
        round: toRoundView(slice.round),
        events: fresh,
        submissions: toTypedSubmissions(slice.round),
        players: toPlayerViews(state),
        now,
      });
      if (observation === null) return unchanged(state);

      const penaltyResult = applyPenalties({
        events: observation.penalties,
        participantIds: activePlayers(state).map((player) => player.id),
        caps: state.settings.penaltyCaps,
        sessionId: slice.session.id,
        roundId: slice.round.id,
        sessionSipsByPlayer: slice.session.sipsByPlayer,
        roundSipsByPlayer: tallySipsForRound(state.penalties, slice.round.id),
      });

      const updatedRound: RoundRecord = {
        ...slice.round,
        publicPayload: observation.publicPayload,
        privatePayloads: observation.privatePayloads,
        solution: observation.solution,
        observedEventIds: [...slice.round.observedEventIds, ...fresh.map((event) => event.id)],
      };

      const deltas: readonly RoundScore[] = observation.scoreDeltas;
      const players = state.players.map((player) => {
        const delta = deltas.find((entry) => entry.playerId === player.id);
        const sips = penaltyResult.sipsByPlayer[player.id] ?? 0;
        if (delta === undefined && sips === 0) return player;
        return {
          ...player,
          score: player.score + (delta?.points ?? 0),
          sips: player.sips + sips,
        };
      });

      const events: EngineEvent[] = [{ type: 'ROUND_UPDATED', roundId: updatedRound.id }];
      if (penaltyResult.recorded.length > 0) {
        events.push({ type: 'PENALTIES_APPLIED', penalties: penaltyResult.recorded });
      }

      const progressed = accept(
        commit(
          state,
          {
            players,
            sessions: writeRound(state, slice, updatedRound, {
              sipsByPlayer: mergeSips(slice.session.sipsByPlayer, penaltyResult.sipsByPlayer),
            }),
            penalties: [...state.penalties, ...penaltyResult.recorded],
          },
          now,
        ),
        events,
      );

      if (!observation.resolved) return progressed;
      return then(progressed, revealRound(progressed.state, deps));
    }

    case 'TICK': {
      if (state.phase !== 'playing') return unchanged(state);
      const slice = readActiveSlice(state, deps);
      if (slice === null) return unchanged(state);
      if (slice.round.status !== 'open') return unchanged(state);
      if (slice.round.deadlineAt === null || now < slice.round.deadlineAt) {
        return unchanged(state);
      }
      // For a long-running bet or a private card the deadline closes *submissions* only: the round
      // itself runs until the module says it is resolved (full time, bingo full house, …).
      if (!DEADLINE_ENDS_ROUND.includes(slice.round.kind)) return unchanged(state);
      return revealRound(state, deps);
    }

    /* --------------------------- progression -------------------------- */

    case 'ADVANCE': {
      if (state.phase === 'roundReveal') {
        // Kahoot-style: reaching the last round of a session is not special — it goes to intermission
        // like any other round-end. The session's `finishedAt` is set right here so the room never
        // auto-terminates; only an explicit FINISH_ROOM (or ABORT_ROOM) ever leaves `intermission` for
        // a phase the host cannot come back from.
        const sessionIndex = state.activeSessionIndex;
        const session = activeSession(state);
        const sessionJustEnded =
          sessionIndex !== null && session !== undefined && session.rounds.length >= session.roundsPlanned;

        const events: EngineEvent[] = [...phaseChange('roundReveal', 'intermission')];
        if (sessionJustEnded && sessionIndex !== null && session !== undefined) {
          events.push({ type: 'SESSION_FINISHED', sessionId: session.id });
        }

        return accept(
          commit(
            state,
            {
              phase: 'intermission',
              sessions:
                sessionJustEnded && sessionIndex !== null
                  ? finishSession(state, sessionIndex, now)
                  : state.sessions,
            },
            now,
          ),
          events,
        );
      }

      if (state.phase !== 'intermission') return reject(state, 'WRONG_PHASE', state.phase);

      const sessionIndex = state.activeSessionIndex;
      const session = activeSession(state);
      if (sessionIndex === null || session === undefined) {
        return reject(state, 'NO_ACTIVE_SESSION');
      }
      // A session that ended — naturally (its last round was just revealed, above) or via
      // END_SESSION — stays visible for the intermission screen but can never resume. From here the
      // host picks another game (SELECT_GAME → START_SESSION) or ends the room with FINISH_ROOM.
      // `session.rounds.length >= session.roundsPlanned` can only coincide with `finishedAt === null`
      // if some future change starts adding rounds outside this reducer's own bookkeeping above — so
      // this rejection is also the last line of defense against ever auto-building a round nobody
      // planned to play.
      if (session.finishedAt !== null || session.rounds.length >= session.roundsPlanned) {
        return reject(state, 'SESSION_FINISHED', session.id);
      }

      const module = deps.modules.get(session.moduleId);
      if (module === undefined) return reject(state, 'UNKNOWN_MODULE', session.moduleId);

      const built = buildRound(state, session, module, deps, rng, session.rounds.length);
      if (!built.ok || built.round === null) {
        return reject(state, 'ROUND_GENERATION_FAILED', built.detail);
      }
      const round = built.round;

      return accept(
        commit(
          state,
          {
            phase: 'playing',
            sessions: state.sessions.map((candidate, index) =>
              index === sessionIndex ? { ...candidate, rounds: [...candidate.rounds, round] } : candidate,
            ),
          },
          now,
        ),
        [
          { type: 'ROUND_STARTED', roundId: round.id, index: round.index },
          ...phaseChange('intermission', 'playing'),
        ],
      );
    }

    case 'END_SESSION': {
      const sessionIndex = state.activeSessionIndex;
      if (sessionIndex === null) return reject(state, 'NO_ACTIVE_SESSION');
      if (state.phase !== 'playing' && state.phase !== 'roundReveal') {
        return reject(state, 'WRONG_PHASE', state.phase);
      }
      const session = state.sessions[sessionIndex];
      if (session === undefined) return reject(state, 'NO_ACTIVE_SESSION');

      return accept(
        commit(state, { phase: 'intermission', sessions: finishSession(state, sessionIndex, now) }, now),
        [{ type: 'SESSION_FINISHED', sessionId: session.id }, ...phaseChange(state.phase, 'intermission')],
      );
    }

    case 'FINISH_ROOM': {
      const events: EngineEvent[] = [{ type: 'ROOM_FINISHED' }];
      const sessions =
        state.activeSessionIndex === null
          ? state.sessions
          : finishSession(state, state.activeSessionIndex, now);
      events.push(...phaseChange(state.phase, 'finished'));
      return accept(commit(state, { phase: 'finished', sessions }, now), events);
    }

    case 'ABORT_ROOM':
    case 'SYSTEM_ABORT_ROOM':
      return abortRoom(state, action.reason, now);

    default: {
      const exhaustive: never = action;
      void exhaustive;
      return unchanged(state);
    }
  }
};

/** Convenience for replay drivers and tests: fold a list of actions into one final state. */
export const reduceAll = (state: RoomState, actions: readonly RoomAction[], deps: EngineDeps): Reduction => {
  let current = state;
  const events: EngineEvent[] = [];
  let lastRejection: EngineRejection | null = null;

  for (const action of actions) {
    const result = reduceRoom(current, action, deps);
    current = result.state;
    events.push(...result.events);
    if (result.rejection !== null) lastRejection = result.rejection;
  }

  return { state: current, events, rejection: lastRejection };
};
