/**
 * Per-recipient projection.
 *
 * This is the only shape the transport is allowed to broadcast. Pre-reveal it is *structurally*
 * impossible for a projection to carry the solution, the outcome or a rival's pick: those fields
 * exist only on the `revealed` member of the `ProjectedRound` union, so a leak would be a type
 * error rather than a bug you find in production.
 */

import type { GameModuleId, PlayerId, RoomId, RoundId, SessionId } from './ids.js';
import type { GameCategory, RoundKind, RoundOutcome, RoundVisibility, TurnState } from './module.js';
import type { GameModuleRegistry } from './modules/registry.js';
import type { RecordedPenalty } from './penalties.js';
import type { EngineClock } from './ports.js';
import type { LeaderboardRow } from './scoring.js';
import { buildLeaderboard } from './scoring.js';
import type {
  AbortReason,
  GameSelection,
  LoadingState,
  RoomPhase,
  RoomSettings,
  RoomState,
  RoundRecord,
  RoundStatus,
  SessionState,
} from './state.js';
import { activePlayers, activeSession } from './state.js';

export interface ProjectionDeps {
  readonly modules: GameModuleRegistry;
  readonly clock: EngineClock;
}

export interface ProjectedPlayer {
  readonly id: PlayerId;
  readonly nickname: string;
  readonly isGuest: boolean;
  readonly isHost: boolean;
  readonly connected: boolean;
  readonly hasLeft: boolean;
  readonly score: number;
  readonly streak: number;
  readonly bestStreak: number;
  readonly correctAnswers: number;
  readonly roundsWon: number;
  readonly sips: number;
}

/** Pre-reveal, all a player learns about rivals is *whether* they have answered. */
export interface ProjectedSubmissionStatus {
  readonly playerId: PlayerId;
  readonly submitted: boolean;
  readonly submittedAt: number | null;
}

/** Post-reveal, everyone's pick becomes public. */
export interface ProjectedSubmission {
  readonly playerId: PlayerId;
  readonly payload: unknown;
  readonly submittedAt: number;
  readonly elapsedMs: number;
}

interface ProjectedRoundBase {
  readonly id: RoundId;
  readonly index: number;
  readonly moduleId: GameModuleId;
  readonly kind: RoundKind;
  readonly status: RoundStatus;
  readonly startedAt: number;
  readonly answerWindowMs: number | null;
  readonly deadlineAt: number | null;
  readonly turn: TurnState | null;
  /** Filtered by the module — e.g. G1 only emits the clues unlocked so far. */
  readonly publicPayload: unknown;
  /** This viewer's private card/assignment only. `null` for the shared big-screen view. */
  readonly privatePayload: unknown;
  readonly submissionStatus: readonly ProjectedSubmissionStatus[];
  readonly yourSubmission: unknown;
}

export interface ProjectedRoundPreReveal extends ProjectedRoundBase {
  readonly visibility: 'pre-reveal';
}

export interface ProjectedRoundRevealed extends ProjectedRoundBase {
  readonly visibility: 'revealed';
  readonly solution: unknown;
  readonly outcome: RoundOutcome | null;
  readonly submissions: readonly ProjectedSubmission[];
  readonly penalties: readonly RecordedPenalty[];
}

export type ProjectedRound = ProjectedRoundPreReveal | ProjectedRoundRevealed;

export interface ProjectedSession {
  readonly id: SessionId;
  readonly moduleId: GameModuleId;
  readonly category: GameCategory;
  readonly roundsPlanned: number;
  readonly roundsPlayed: number;
  readonly finished: boolean;
}

export interface ProjectedSelf {
  readonly playerId: PlayerId;
  readonly isHost: boolean;
  readonly score: number;
  readonly streak: number;
  readonly sips: number;
  readonly rank: number | null;
  readonly hasSubmitted: boolean;
  readonly isYourTurn: boolean;
}

export interface DrinkTallyRow {
  readonly playerId: PlayerId;
  readonly nickname: string;
  readonly sips: number;
}

export interface ProjectedRoom {
  readonly roomId: RoomId;
  readonly pin: string;
  readonly phase: RoomPhase;
  readonly version: number;
  readonly updatedAt: number;
  readonly hostPlayerId: PlayerId;
  readonly viewerId: PlayerId | null;
  readonly you: ProjectedSelf | null;
  readonly players: readonly ProjectedPlayer[];
  readonly settings: RoomSettings;
  readonly selection: GameSelection | null;
  readonly loading: LoadingState | null;
  readonly session: ProjectedSession | null;
  readonly round: ProjectedRound | null;
  readonly leaderboard: readonly LeaderboardRow[];
  readonly drinkTally: readonly DrinkTallyRow[];
  readonly abortReason: AbortReason | null;
}

const projectPlayers = (room: RoomState): readonly ProjectedPlayer[] =>
  room.players.map((player) => ({
    id: player.id,
    nickname: player.nickname,
    isGuest: player.isGuest,
    isHost: player.id === room.hostPlayerId,
    connected: player.connected,
    hasLeft: player.leftAt !== null,
    score: player.score,
    streak: player.streak,
    bestStreak: player.bestStreak,
    correctAnswers: player.correctAnswers,
    roundsWon: player.roundsWon,
    sips: player.sips,
  }));

const projectSession = (session: SessionState): ProjectedSession => ({
  id: session.id,
  moduleId: session.moduleId,
  category: session.category,
  roundsPlanned: session.roundsPlanned,
  roundsPlayed: session.rounds.length,
  finished: session.finishedAt !== null,
});

/** A round is revealed once it has been resolved — never merely because the phase changed. */
const visibilityOf = (round: RoundRecord): RoundVisibility =>
  round.status === 'resolved' ? 'revealed' : 'pre-reveal';

const projectRoundFor = (
  room: RoomState,
  session: SessionState,
  round: RoundRecord,
  viewerId: PlayerId | null,
  deps: ProjectionDeps,
): ProjectedRound => {
  const module = deps.modules.get(round.moduleId);
  const visibility = visibilityOf(round);
  const now = deps.clock.now();

  const moduleProjection =
    module === undefined
      ? // Without the module we cannot know what is safe to show (G1 hides clues inside its public
        // payload, for instance), so nothing module-owned leaves the engine.
        { publicPayload: null, privatePayload: null, solution: null }
      : module.projectRound({
          config: session.config,
          round: {
            id: round.id,
            index: round.index,
            startedAt: round.startedAt,
            answerWindowMs: round.answerWindowMs,
            deadlineAt: round.deadlineAt,
            publicPayload: round.publicPayload,
            privatePayloads: round.privatePayloads,
            solution: round.solution,
            turn: round.turn,
          },
          viewerId,
          visibility,
          now,
        });

  const base: ProjectedRoundBase = {
    id: round.id,
    index: round.index,
    moduleId: round.moduleId,
    kind: round.kind,
    status: round.status,
    startedAt: round.startedAt,
    answerWindowMs: round.answerWindowMs,
    deadlineAt: round.deadlineAt,
    turn: round.turn,
    publicPayload: moduleProjection.publicPayload,
    privatePayload: viewerId === null ? null : (moduleProjection.privatePayload ?? null),
    submissionStatus: activePlayers(room).map((player) => {
      const submission = round.submissions.find((entry) => entry.playerId === player.id);
      return {
        playerId: player.id,
        submitted: submission !== undefined,
        submittedAt: submission?.submittedAt ?? null,
      };
    }),
    yourSubmission:
      viewerId === null
        ? null
        : (round.submissions.find((entry) => entry.playerId === viewerId)?.payload ?? null),
  };

  if (visibility === 'pre-reveal') {
    // No `solution`, no `outcome`, no rival payloads. The object simply has no such keys.
    return { ...base, visibility: 'pre-reveal' };
  }

  return {
    ...base,
    visibility: 'revealed',
    solution: module === undefined ? null : (moduleProjection.solution ?? round.solution),
    outcome: round.outcome,
    submissions: round.submissions.map((submission) => ({
      playerId: submission.playerId,
      payload: submission.payload,
      submittedAt: submission.submittedAt,
      elapsedMs: submission.elapsedMs,
    })),
    penalties: room.penalties.filter((entry) => entry.roundId === round.id),
  };
};

/**
 * Build the view one recipient is allowed to see. `viewerId === null` produces the shared
 * "big screen" view: public payload only, no private card and no personal submission.
 */
export const projectFor = (
  room: RoomState,
  viewerId: PlayerId | null,
  deps: ProjectionDeps,
): ProjectedRoom => {
  const session = activeSession(room);
  const round = session?.rounds[session.rounds.length - 1];
  const leaderboard = buildLeaderboard(activePlayers(room));

  const projectedRound =
    session !== undefined && round !== undefined
      ? projectRoundFor(room, session, round, viewerId, deps)
      : null;

  const me = viewerId === null ? undefined : room.players.find((player) => player.id === viewerId);

  const you: ProjectedSelf | null =
    me === undefined
      ? null
      : {
          playerId: me.id,
          isHost: me.id === room.hostPlayerId,
          score: me.score,
          streak: me.streak,
          sips: me.sips,
          rank: leaderboard.find((row) => row.playerId === me.id)?.rank ?? null,
          hasSubmitted:
            round !== undefined && round.submissions.some((submission) => submission.playerId === me.id),
          isYourTurn:
            round?.turn !== undefined &&
            round?.turn !== null &&
            round.turn.order[round.turn.activeIndex] === me.id,
        };

  return {
    roomId: room.id,
    pin: room.pin,
    phase: room.phase,
    version: room.version,
    updatedAt: room.updatedAt,
    hostPlayerId: room.hostPlayerId,
    viewerId,
    you,
    players: projectPlayers(room),
    settings: room.settings,
    selection: room.selection,
    loading: room.loading,
    session: session === undefined ? null : projectSession(session),
    round: projectedRound,
    leaderboard,
    drinkTally: activePlayers(room)
      .map((player) => ({ playerId: player.id, nickname: player.nickname, sips: player.sips }))
      .sort((a, b) => b.sips - a.sips || (a.playerId < b.playerId ? -1 : 1)),
    abortReason: room.abortReason,
  };
};

/** The shared screen view — a projection that belongs to no player. */
export const projectForHostScreen = (room: RoomState, deps: ProjectionDeps): ProjectedRoom =>
  projectFor(room, null, deps);
