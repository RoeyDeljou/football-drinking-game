/**
 * Regression tests for the Phase-1 QA gate findings. Each `describe` is named after the finding id
 * (B = blocking, N = non-blocking) so a failure points straight back at the defect it guards.
 * M1-specific findings (B4, B5, the M1 part of N8) live in modules/m1-match-markets.test.ts and the
 * turn-based finding (N6) in modules/contract-coverage.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RoomAction } from './actions.js';
import { HOST_ONLY_ACTIONS, isSystemAction, parseClientAction, SYSTEM_ACTION_TYPES } from './actions.js';
import { asGameModuleId, asPlayerId } from './ids.js';
import type { PlayerId } from './ids.js';
import { defineGameModule } from './module.js';
import { G1_ID } from './modules/g1-guess-the-player.js';
import { G6_ID } from './modules/g6-trivia-rush.js';
import { lastCorrectPlayer, scoreChoiceRound } from './modules/helpers.js';
import { M1_ID } from './modules/m1-match-markets.js';
import { M2_DEFAULT_CONFIG, M2_ID, m2WhoIsThatPlayer } from './modules/m2-who-is-that-player.js';
import { M3_DEFAULT_CONFIG, M3_ID, m3ShirtNumber } from './modules/m3-shirt-number.js';
import { createModuleRegistry, PHASE_1_MODULES } from './modules/registry.js';
import { applyPenalties, DEFAULT_PENALTY_CAPS, penalty } from './penalties.js';
import { projectFor } from './projection.js';
import type { EngineDeps } from './reducer.js';
import { reduceAll, reduceRoom } from './reducer.js';
import { DEFAULT_SCORING, scoreNoAnswer } from './scoring.js';
import type { RoomState } from './state.js';
import { activeSession, currentRound } from './state.js';
import {
  ALL_BUILT,
  asRoundView,
  AWAY_TEAM_ID,
  HOME_TEAM_ID,
  HOST,
  makeHarness,
  matchEvent,
  mustGenerate,
  newRoom,
  P2,
  P3,
  playerViews,
  sub,
  T0,
} from './harness.test-utils.js';
import type { GameModuleId } from './ids.js';
import { asRoundId, asSessionId } from './ids.js';

const join = (playerId: PlayerId, nickname: string): RoomAction => ({
  type: 'PLAYER_JOIN',
  playerId,
  nickname,
  isGuest: true,
});

/** Host + two guests, `moduleId` selected and started. */
const startGame = (
  moduleId: GameModuleId,
  deps: EngineDeps,
  extra: readonly RoomAction[] = [],
): RoomState => {
  const result = reduceAll(
    newRoom(),
    [
      join(P2, 'Bea'),
      join(P3, 'Cal'),
      ...extra,
      { type: 'SELECT_GAME', actorId: HOST, moduleId, config: null },
      { type: 'START_SESSION', actorId: HOST },
    ],
    deps,
  );
  expect(result.rejection).toBeNull();
  expect(result.state.phase).toBe('playing');
  return result.state;
};

const roundIdOf = (room: RoomState) => currentRound(room)?.id ?? asRoundId('missing');

/* ----------------------------------- B1 ----------------------------------- */

describe('B1: guests cannot act as the system', () => {
  it('rejects a null actor at parse time for lock, reveal and abort', () => {
    expect(parseClientAction({ type: 'ABORT_ROOM', actorId: null, reason: 'HOST_ABORTED' }).ok).toBe(false);
    expect(parseClientAction({ type: 'LOCK_ROUND', actorId: null }).ok).toBe(false);
    expect(parseClientAction({ type: 'REVEAL_ROUND', actorId: null }).ok).toBe(false);
  });

  it('rejects a missing actor at parse time', () => {
    expect(parseClientAction({ type: 'ABORT_ROOM', reason: 'HOST_ABORTED' }).ok).toBe(false);
    expect(parseClientAction({ type: 'LOCK_ROUND' }).ok).toBe(false);
    expect(parseClientAction({ type: 'REVEAL_ROUND' }).ok).toBe(false);
  });

  it('never parses a system action from client input', () => {
    for (const type of SYSTEM_ACTION_TYPES) {
      expect(parseClientAction({ type }).ok).toBe(false);
      expect(parseClientAction({ type, reason: 'TIMED_OUT' }).ok).toBe(false);
    }
    expect(isSystemAction('SYSTEM_ABORT_ROOM')).toBe(true);
    expect(isSystemAction('ABORT_ROOM')).toBe(false);
  });

  it('lists lock, reveal and abort as host-only', () => {
    expect(HOST_ONLY_ACTIONS).toEqual(expect.arrayContaining(['LOCK_ROUND', 'REVEAL_ROUND', 'ABORT_ROOM']));
  });

  it("replays QA's probe: a guest's abort parses only with their own id, and the reducer refuses it", () => {
    const { deps } = makeHarness();
    const room = startGame(M3_ID, deps);
    const parsed = parseClientAction({ type: 'ABORT_ROOM', actorId: 'p2', reason: 'HOST_ABORTED' });
    if (!parsed.ok) throw new Error('expected a well-formed action');
    const result = reduceRoom(room, parsed.action, deps);
    expect(result.rejection?.code).toBe('NOT_HOST');
    expect(result.state).toBe(room);
    expect(result.state.phase).toBe('playing');
  });

  it('refuses a guest lock and reveal', () => {
    const { deps } = makeHarness();
    const room = startGame(M3_ID, deps);
    expect(reduceRoom(room, { type: 'LOCK_ROUND', actorId: P2 }, deps).rejection?.code).toBe('NOT_HOST');
    expect(reduceRoom(room, { type: 'REVEAL_ROUND', actorId: P3 }, deps).rejection?.code).toBe('NOT_HOST');
  });

  it('still lets the server lock, reveal and abort through the system variants', () => {
    const { deps } = makeHarness();
    const room = startGame(M3_ID, deps);
    expect(currentRound(reduceRoom(room, { type: 'SYSTEM_LOCK_ROUND' }, deps).state)?.status).toBe('locked');
    expect(reduceRoom(room, { type: 'SYSTEM_REVEAL_ROUND' }, deps).state.phase).toBe('roundReveal');
    expect(
      reduceRoom(room, { type: 'SYSTEM_ABORT_ROOM', reason: 'DATA_UNAVAILABLE' }, deps).state,
    ).toMatchObject({
      phase: 'aborted',
      abortReason: 'DATA_UNAVAILABLE',
    });
  });

  it('refuses a system reveal outside a live round', () => {
    const { deps } = makeHarness();
    expect(reduceRoom(newRoom(), { type: 'SYSTEM_REVEAL_ROUND' }, deps).rejection?.code).toBe('WRONG_PHASE');
    expect(reduceRoom(newRoom(), { type: 'SYSTEM_LOCK_ROUND' }, deps).rejection?.code).toBe('WRONG_PHASE');
  });
});

/* ----------------------------------- B2 ----------------------------------- */

describe('B2: an ended session cannot be revived', () => {
  it('rejects ADVANCE after END_SESSION and creates no new round', () => {
    const { deps } = makeHarness();
    const room = startGame(M3_ID, deps);
    const ended = reduceRoom(room, { type: 'END_SESSION', actorId: HOST }, deps).state;
    expect(ended.phase).toBe('intermission');

    const advanced = reduceRoom(ended, { type: 'ADVANCE', actorId: HOST }, deps);
    expect(advanced.rejection?.code).toBe('SESSION_FINISHED');
    expect(advanced.state).toBe(ended);
    expect(activeSession(advanced.state)?.rounds).toHaveLength(1);
  });

  it('keeps the multi-game flow: intermission → SELECT_GAME → START_SESSION', () => {
    const { deps } = makeHarness();
    let room = startGame(M3_ID, deps);
    room = reduceRoom(room, { type: 'END_SESSION', actorId: HOST }, deps).state;
    const next = reduceAll(
      room,
      [
        { type: 'SELECT_GAME', actorId: HOST, moduleId: M2_ID, config: null },
        { type: 'START_SESSION', actorId: HOST },
      ],
      deps,
    );
    expect(next.rejection).toBeNull();
    expect(next.state.phase).toBe('playing');
    expect(next.state.sessions.map((session) => session.moduleId)).toEqual([M3_ID, M2_ID]);
    expect(next.state.sessions[0]?.finishedAt).not.toBeNull();
    expect(activeSession(next.state)?.finishedAt).toBeNull();
  });

  it('still lets the host finish the room from that intermission', () => {
    const { deps } = makeHarness();
    let room = startGame(M3_ID, deps);
    room = reduceRoom(room, { type: 'END_SESSION', actorId: HOST }, deps).state;
    expect(reduceRoom(room, { type: 'FINISH_ROOM', actorId: HOST }, deps).state.phase).toBe('finished');
  });

  it('still advances a session that is merely between rounds', () => {
    const { deps } = makeHarness();
    let room = startGame(M3_ID, deps);
    room = reduceAll(
      room,
      [
        { type: 'REVEAL_ROUND', actorId: HOST },
        { type: 'ADVANCE', actorId: HOST },
        { type: 'ADVANCE', actorId: HOST },
      ],
      deps,
    ).state;
    expect(room.phase).toBe('playing');
    expect(activeSession(room)?.rounds).toHaveLength(2);
  });
});

/* ----------------------------------- B3 ----------------------------------- */

describe('B3: the per-round sip cap holds across penalty batches', () => {
  it('carries earlier sips into the round cap inside applyPenalties', () => {
    const A = asPlayerId('a');
    const result = applyPenalties({
      events: [penalty(A, 'self', 3, 'LOST_MARKET')],
      participantIds: [A],
      caps: { perPenalty: 10, perRound: 4, perSession: 100 },
      sessionId: asSessionId('s'),
      roundId: asRoundId('r'),
      sessionSipsByPlayer: { [A]: 3 },
      roundSipsByPlayer: { [A]: 3 },
    });
    expect(result.recorded[0]).toMatchObject({ appliedSips: 1, cappedBy: 'perRound' });
  });

  it('caps an M1 round at perRound across several MATCH_EVENTS batches plus the reveal', () => {
    const { deps } = makeHarness();
    let room = startGame(M1_ID, deps, [
      {
        type: 'UPDATE_SETTINGS',
        actorId: HOST,
        patch: { penaltyCaps: { perPenalty: 6, perRound: 2, perSession: 60 } },
      },
    ]);
    const round = currentRound(room);
    const markets = (
      round?.publicPayload as { markets: { id: string; options: { id: string; kind: string }[] }[] }
    ).markets;
    const prefer: Record<string, string> = {
      PENALTY_AWARDED: 'NO',
      OVER_UNDER_GOALS: 'UNDER',
      OVER_UNDER_CORNERS: 'UNDER',
      OVER_UNDER_CARDS: 'UNDER',
      BTTS: 'NO',
    };
    const picks = markets.map((market) => ({
      marketId: market.id,
      optionId:
        market.options.find((option) => option.kind === prefer[market.id])?.id ?? market.options[0]?.id ?? '',
    }));
    room = reduceRoom(
      room,
      { type: 'SUBMIT_ANSWER', playerId: HOST, roundId: roundIdOf(room), payload: { picks } },
      deps,
    ).state;

    const scorer = (index: number) => ALL_BUILT[index]?.player.id ?? null;
    const batches = [
      [matchEvent('PENALTY_AWARDED', { minute: 5, id: 'b3-pen' })],
      [
        matchEvent('GOAL', { teamId: HOME_TEAM_ID, playerId: scorer(1), minute: 10, id: 'b3-g1' }),
        matchEvent('GOAL', { teamId: AWAY_TEAM_ID, playerId: scorer(12), minute: 11, id: 'b3-g2' }),
        matchEvent('GOAL', { teamId: HOME_TEAM_ID, playerId: scorer(2), minute: 12, id: 'b3-g3' }),
      ],
      Array.from({ length: 10 }, (_, index) =>
        matchEvent('CORNER', { minute: 20 + index, id: `b3-c${index}` }),
      ),
    ];
    for (const events of batches) room = reduceRoom(room, { type: 'MATCH_EVENTS', events }, deps).state;
    room = reduceRoom(
      room,
      { type: 'MATCH_EVENTS', events: [matchEvent('FULL_TIME', { minute: 90, id: 'b3-ft' })] },
      deps,
    ).state;
    expect(room.phase).toBe('roundReveal');

    const roundId = roundIdOf(room);
    for (const player of room.players) {
      const charged = room.penalties
        .filter((entry) => entry.roundId === roundId && entry.recipientId === player.id)
        .reduce((sum, entry) => sum + entry.appliedSips, 0);
      expect(charged).toBeLessThanOrEqual(2);
      expect(player.sips).toBe(charged);
    }
    expect(room.players.find((player) => player.id === HOST)?.sips).toBe(2);
    expect(room.penalties.some((entry) => entry.recipientId === HOST && entry.cappedBy === 'perRound')).toBe(
      true,
    );
  });

  it('keeps default M1 settings under the default round cap', () => {
    const { deps } = makeHarness();
    let room = startGame(M1_ID, deps);
    const markets = (
      currentRound(room)?.publicPayload as { markets: { id: string; options: { id: string }[] }[] }
    ).markets;
    const picks = markets.map((market) => ({ marketId: market.id, optionId: market.options[0]?.id ?? '' }));
    room = reduceRoom(
      room,
      { type: 'SUBMIT_ANSWER', playerId: HOST, roundId: roundIdOf(room), payload: { picks } },
      deps,
    ).state;
    for (let minute = 1; minute <= 12; minute += 1) {
      room = reduceRoom(
        room,
        { type: 'MATCH_EVENTS', events: [matchEvent('CORNER', { minute, id: `dc${minute}` })] },
        deps,
      ).state;
    }
    room = reduceRoom(
      room,
      { type: 'MATCH_EVENTS', events: [matchEvent('FULL_TIME', { minute: 90, id: 'dft' })] },
      deps,
    ).state;
    for (const player of room.players) {
      expect(player.sips).toBeLessThanOrEqual(DEFAULT_PENALTY_CAPS.perRound);
    }
  });
});

/* ----------------------------------- N1 ----------------------------------- */

describe('N1: projection without the module leaks nothing module-owned', () => {
  it('sends a null payload instead of the raw G1 clues', () => {
    const { deps, clock } = makeHarness();
    const room = startGame(G1_ID, deps);
    const blind = { modules: createModuleRegistry([]), clock };

    const view = projectFor(room, HOST, blind);
    expect(view.round?.publicPayload).toBeNull();
    expect(view.round?.privatePayload).toBeNull();
    expect(JSON.stringify(view)).not.toContain('NATIONALITY');
    expect(JSON.stringify(view)).not.toContain('CAREER');

    // With the module the first clue is visible, so the difference is the missing module alone.
    expect(JSON.stringify(projectFor(room, HOST, deps))).toContain('NATIONALITY');
  });

  it('withholds the solution after reveal too', () => {
    const { deps, clock } = makeHarness();
    const revealed = reduceRoom(startGame(G1_ID, deps), { type: 'REVEAL_ROUND', actorId: HOST }, deps).state;
    const view = projectFor(revealed, HOST, { modules: createModuleRegistry([]), clock });
    if (view.round?.visibility !== 'revealed') throw new Error('expected a revealed round');
    expect(view.round.solution).toBeNull();
    expect(view.round.publicPayload).toBeNull();
  });
});

/* ----------------------------------- N2 ----------------------------------- */

describe('N2: kicks stick', () => {
  const kicked = (deps: EngineDeps): RoomState =>
    reduceAll(
      newRoom(),
      [join(P2, 'Bea'), join(P3, 'Cal'), { type: 'KICK_PLAYER', actorId: HOST, targetPlayerId: P2 }],
      deps,
    ).state;

  it('records the kicked player', () => {
    const { deps } = makeHarness();
    expect(kicked(deps).kickedPlayerIds).toEqual([P2]);
  });

  it('refuses a rejoin, even under a new nickname', () => {
    const { deps } = makeHarness();
    const result = reduceRoom(kicked(deps), join(P2, 'Totally Not Bea'), deps);
    expect(result.rejection?.code).toBe('PLAYER_KICKED');
  });

  it('refuses a reconnect', () => {
    const { deps } = makeHarness();
    const result = reduceRoom(kicked(deps), { type: 'PLAYER_RECONNECTED', playerId: P2 }, deps);
    expect(result.rejection?.code).toBe('PLAYER_KICKED');
  });

  it('does not affect anyone else', () => {
    const { deps } = makeHarness();
    const room = kicked(deps);
    expect(reduceRoom(room, join(asPlayerId('p4'), 'Dee'), deps).rejection).toBeNull();
    expect(reduceRoom(room, { type: 'PLAYER_DISCONNECTED', playerId: P3 }, deps).rejection).toBeNull();
  });

  it('lets a player who merely left come back', () => {
    const { deps } = makeHarness();
    const room = reduceAll(newRoom(), [join(P2, 'Bea'), { type: 'PLAYER_LEAVE', playerId: P2 }], deps).state;
    expect(reduceRoom(room, join(P2, 'Bea'), deps).rejection).toBeNull();
  });
});

/* ----------------------------------- N3 ----------------------------------- */

describe('N3: a game only starts from the loading screen after a successful load', () => {
  const loading = (deps: EngineDeps): RoomState =>
    reduceAll(
      newRoom(),
      [
        join(P2, 'Bea'),
        { type: 'SELECT_GAME', actorId: HOST, moduleId: M3_ID, config: null },
        { type: 'START_LOADING', actorId: HOST, stepKeys: ['fixtures', 'lineups'] },
      ],
      deps,
    ).state;

  it('refuses START_SESSION after LOADING_FAILED', () => {
    const { deps } = makeHarness();
    const failed = reduceAll(
      loading(deps),
      [
        { type: 'LOADING_PROGRESS', stepKey: 'fixtures', status: 'done', detail: null },
        { type: 'LOADING_PROGRESS', stepKey: 'lineups', status: 'done', detail: null },
        { type: 'LOADING_FAILED', reason: 'provider 503' },
      ],
      deps,
    ).state;
    const result = reduceRoom(failed, { type: 'START_SESSION', actorId: HOST }, deps);
    expect(result.rejection).toMatchObject({ code: 'LOADING_INCOMPLETE', detail: 'provider 503' });
    expect(result.state.phase).toBe('loading');
  });

  it('refuses START_SESSION while steps are still pending', () => {
    const { deps } = makeHarness();
    const partial = reduceRoom(
      loading(deps),
      { type: 'LOADING_PROGRESS', stepKey: 'fixtures', status: 'done', detail: null },
      deps,
    ).state;
    expect(reduceRoom(partial, { type: 'START_SESSION', actorId: HOST }, deps).rejection?.code).toBe(
      'LOADING_INCOMPLETE',
    );
  });

  it('starts once every step is done, including after a retry', () => {
    const { deps } = makeHarness();
    const retried = reduceAll(
      loading(deps),
      [
        { type: 'LOADING_FAILED', reason: 'timeout' },
        { type: 'START_LOADING', actorId: HOST, stepKeys: ['fixtures', 'lineups'] },
        { type: 'LOADING_PROGRESS', stepKey: 'fixtures', status: 'done', detail: null },
        { type: 'LOADING_PROGRESS', stepKey: 'lineups', status: 'done', detail: null },
      ],
      deps,
    ).state;
    const started = reduceRoom(retried, { type: 'START_SESSION', actorId: HOST }, deps);
    expect(started.rejection).toBeNull();
    expect(started.state.phase).toBe('playing');
  });
});

/* ----------------------------------- N4 ----------------------------------- */

describe('N4: the RNG is resumable', () => {
  it('stores the RNG state in the room and advances it only when randomness is used', () => {
    const { deps } = makeHarness();
    const lobby = reduceAll(
      newRoom(),
      [join(P2, 'Bea'), { type: 'SELECT_GAME', actorId: HOST, moduleId: M3_ID, config: null }],
      deps,
    ).state;
    expect(lobby.rngState).toBe(newRoom().rngState);

    const started = reduceRoom(lobby, { type: 'START_SESSION', actorId: HOST }, deps).state;
    expect(started.rngState).not.toBe(lobby.rngState);

    const rejected = reduceRoom(started, { type: 'START_SESSION', actorId: HOST }, deps);
    expect(rejected.rejection).not.toBeNull();
    expect(rejected.state.rngState).toBe(started.rngState);
  });

  it('continues the exact same sequence after a JSON round-trip on every dispatch', () => {
    for (const moduleId of [M2_ID, M3_ID, G6_ID]) {
      const straight = playSession(moduleId, 7, false);
      const restored = playSession(moduleId, 7, true);
      expect(restored).toEqual(straight);
      expect(JSON.stringify(restored)).toBe(JSON.stringify(straight));
    }
  });

  it('resumes mid-session on a brand-new set of deps, as a different server instance would', () => {
    const first = makeHarness();
    let room = startGame(M3_ID, first.deps);
    room = reduceAll(
      room,
      [
        { type: 'REVEAL_ROUND', actorId: HOST },
        { type: 'ADVANCE', actorId: HOST },
      ],
      first.deps,
    ).state;
    const tail: readonly RoomAction[] = [
      { type: 'ADVANCE', actorId: HOST },
      { type: 'REVEAL_ROUND', actorId: HOST },
      { type: 'ADVANCE', actorId: HOST },
      { type: 'ADVANCE', actorId: HOST },
    ];

    const uninterrupted = reduceAll(room, tail, first.deps).state;
    const second = makeHarness();
    second.clock.set(first.clock.now());
    const stored = JSON.parse(JSON.stringify(room)) as RoomState;
    const resumed = reduceAll(stored, tail, second.deps).state;

    expect(resumed).toEqual(uninterrupted);
    expect(activeSession(resumed)?.rounds.map((round) => round.contentKey)).toEqual(
      activeSession(uninterrupted)?.rounds.map((round) => round.contentKey),
    );
  });
});

/* ----------------------------------- N7 ----------------------------------- */

describe('N7: scoring quirks', () => {
  const scoring = { ...DEFAULT_SCORING, wrongAnswerPoints: 50, noAnswerPoints: 0 };

  it('gives non-answerers noAnswerPoints, never wrongAnswerPoints', () => {
    expect(scoreNoAnswer({ playerId: HOST, config: scoring }).points).toBe(0);
    const scores = scoreChoiceRound({
      players: playerViews([HOST, P2]),
      submissions: [sub(HOST, { value: 1 })],
      isCorrect: () => false,
      windowMs: 10_000,
      scoring,
    });
    expect(scores.find((entry) => entry.playerId === HOST)?.points).toBe(50);
    expect(scores.find((entry) => entry.playerId === P2)?.points).toBe(0);
    expect(scoreNoAnswer({ playerId: P2, config: { ...scoring, noAnswerPoints: 7 } }).points).toBe(7);
  });

  it('gives an M3 near miss no streak multiplier', () => {
    const generated = mustGenerate(m3ShirtNumber);
    const answer = (generated.solution as { shirtNumber: number }).shirtNumber;
    const near = answer < 99 ? answer + 1 : answer - 1;
    const players = playerViews([HOST, P2]).map((player) => ({ ...player, streak: 4 }));
    const outcome = m3ShirtNumber.scoreRound({
      config: M3_DEFAULT_CONFIG,
      round: asRoundView(generated),
      submissions: [sub(HOST, { guess: near }), sub(P2, { guess: answer })],
      players,
      scoring: DEFAULT_SCORING,
      now: T0,
    });
    const nearMiss = outcome.scores.find((entry) => entry.playerId === HOST);
    const exact = outcome.scores.find((entry) => entry.playerId === P2);
    expect(nearMiss?.points).toBeGreaterThan(0);
    expect(nearMiss?.correct).toBe(false);
    expect(nearMiss?.breakdown.streakMultiplier).toBe(1);
    expect(exact?.breakdown.streakMultiplier).toBeGreaterThan(1);
  });

  describe('last correct drinks', () => {
    const correct = [sub(HOST, {}, 1_000)];

    it('applies to a lone correct answer when others answered too', () => {
      expect(lastCorrectPlayer(correct, 3)).toBe(HOST);
    });

    it('does not apply when that player was the only one who answered', () => {
      expect(lastCorrectPlayer(correct, 1)).toBeNull();
    });

    it('does not apply when nobody was correct', () => {
      expect(lastCorrectPlayer([], 3)).toBeNull();
    });

    it('picks the slowest of several, and the later arrival on an exact tie', () => {
      expect(lastCorrectPlayer([sub(HOST, {}, 900), sub(P2, {}, 400)], 2)).toBe(HOST);
      expect(lastCorrectPlayer([sub(HOST, {}, 500), sub(P2, {}, 500)], 2)).toBe(P2);
    });

    it('is applied by M2 to a lone correct answer', () => {
      const generated = mustGenerate(m2WhoIsThatPlayer);
      const answer = (generated.solution as { playerId: string }).playerId;
      const options = (generated.publicPayload as { options: { playerId: string }[] }).options;
      const wrong = options.find((option) => option.playerId !== answer)?.playerId;
      const outcome = m2WhoIsThatPlayer.scoreRound({
        config: M2_DEFAULT_CONFIG,
        round: asRoundView(generated),
        submissions: [sub(HOST, { playerId: answer }, 2_000), sub(P2, { playerId: wrong }, 500)],
        players: playerViews([HOST, P2]),
        scoring: DEFAULT_SCORING,
        now: T0,
      });
      expect(outcome.penalties).toContainEqual(penalty(HOST, 'self', 1, 'LAST_CORRECT', null));
    });
  });

  it('credits roundsWon to a winner who has no score entry', () => {
    const empty = z.object({}).strict();
    const WIN_ID = asGameModuleId('WIN_ONLY');
    const winOnly = defineGameModule<{
      config: z.infer<typeof empty>;
      publicPayload: z.infer<typeof empty>;
      privatePayload: null;
      solution: z.infer<typeof empty>;
      submission: z.infer<typeof empty>;
    }>({
      id: WIN_ID,
      category: 'general',
      kind: 'simultaneous-answer',
      dataRequirements: [],
      minPlayers: 1,
      maxPlayers: null,
      allowResubmission: false,
      defaultConfig: {},
      configSchema: empty,
      publicPayloadSchema: empty,
      privatePayloadSchema: z.null(),
      solutionSchema: empty,
      submissionSchema: empty,
      generateRound: () => ({
        ok: true,
        round: {
          publicPayload: {},
          privatePayloads: {},
          solution: {},
          contentKey: 'w',
          answerWindowMs: 10_000,
          turnOrder: null,
        },
      }),
      validateSubmission: () => ({ ok: true, payload: {} }),
      scoreRound: () => ({ scores: [], winnerIds: [HOST], penalties: [], summary: null }),
      projectRound: (ctx) => ({
        publicPayload: ctx.round.publicPayload,
        privatePayload: null,
        solution: null,
      }),
    });
    const { deps: base } = makeHarness();
    const deps: EngineDeps = { ...base, modules: createModuleRegistry([winOnly]) };
    const room = startGame(WIN_ID, deps);
    const revealed = reduceRoom(room, { type: 'REVEAL_ROUND', actorId: HOST }, deps).state;
    const host = revealed.players.find((player) => player.id === HOST);
    expect(host?.roundsWon).toBe(1);
    expect(host?.score).toBe(0);
  });
});

/* ----------------------------------- N8 ----------------------------------- */

/** A module-appropriate answer for player `index`, read from the stored public payload. */
const answerFor = (moduleId: GameModuleId, payload: unknown, index: number, roundIndex: number): unknown => {
  const pickFrom = <T>(items: readonly T[]): T | undefined => items[(index + roundIndex) % items.length];
  switch (moduleId) {
    case M1_ID: {
      const markets = (payload as { markets: { id: string; options: { id: string }[] }[] }).markets;
      return {
        picks: markets.map((market) => ({ marketId: market.id, optionId: pickFrom(market.options)?.id })),
      };
    }
    case M2_ID:
    case G1_ID:
      return { playerId: pickFrom((payload as { options: { playerId: string }[] }).options)?.playerId };
    case M3_ID:
      return { guess: ((index * 7 + roundIndex * 13) % 99) + 1 };
    case G6_ID:
      return { optionId: pickFrom((payload as { options: { id: string }[] }).options)?.id };
    default:
      throw new Error(`no answer script for ${moduleId}`);
  }
};

/**
 * Plays a full three-round session of one module with scripted answers, clock movement and (for M1)
 * live events. With `roundTrip`, the state is serialized to JSON and restored after every dispatch,
 * exactly like a RoomStore would.
 */
const playSession = (moduleId: GameModuleId, seed: number, roundTrip: boolean): RoomState => {
  const { deps, clock } = makeHarness();
  let room = newRoom(T0, seed);
  const dispatch = (action: RoomAction): void => {
    room = reduceRoom(room, action, deps).state;
    if (roundTrip) room = JSON.parse(JSON.stringify(room)) as RoomState;
  };

  dispatch(join(P2, 'Bea'));
  dispatch(join(P3, 'Cal'));
  dispatch({ type: 'UPDATE_SETTINGS', actorId: HOST, patch: { roundsPerSession: 3 } });
  dispatch({ type: 'SELECT_GAME', actorId: HOST, moduleId, config: null });
  dispatch({ type: 'START_SESSION', actorId: HOST });

  for (let guard = 0; guard < 40; guard += 1) {
    // Kahoot-style: the last round's reveal takes the session to intermission with `finishedAt` set,
    // not straight to 'finished'. The room only reaches 'finished' via an explicit FINISH_ROOM below.
    if (room.phase === 'intermission' && activeSession(room)?.finishedAt !== null) break;
    if (room.phase === 'playing') {
      const round = currentRound(room);
      if (round === undefined) throw new Error('playing without a round');
      [HOST, P2, P3].forEach((playerId, index) => {
        clock.advance(700 + index * 450);
        if (room.phase === 'playing') {
          dispatch({
            type: 'SUBMIT_ANSWER',
            playerId,
            roundId: round.id,
            payload: answerFor(moduleId, round.publicPayload, index, round.index),
          });
        }
      });
      if (moduleId === M1_ID) {
        const prefix = `s${seed}-r${round.index}`;
        clock.advance(60_000);
        dispatch({
          type: 'MATCH_EVENTS',
          events: [
            matchEvent('KICK_OFF', { minute: 0, id: `${prefix}-ko` }),
            matchEvent('GOAL', {
              teamId: HOME_TEAM_ID,
              playerId: ALL_BUILT[(round.index + 8) % 11]?.player.id ?? null,
              minute: 17,
              id: `${prefix}-g1`,
            }),
          ],
        });
        dispatch({
          type: 'MATCH_EVENTS',
          events: [matchEvent('HALF_TIME', { minute: 45, id: `${prefix}-ht` })],
        });
        dispatch({
          type: 'MATCH_EVENTS',
          events: [matchEvent('FULL_TIME', { minute: 90, id: `${prefix}-ft` })],
        });
      }
      if (room.phase === 'playing') dispatch({ type: 'SYSTEM_REVEAL_ROUND' });
    }
    clock.advance(2_000);
    if (room.phase === 'roundReveal') dispatch({ type: 'ADVANCE', actorId: HOST });
    if (room.phase === 'intermission') dispatch({ type: 'ADVANCE', actorId: HOST });
  }

  expect(room.phase).toBe('intermission');
  expect(activeSession(room)?.finishedAt).not.toBeNull();
  dispatch({ type: 'FINISH_ROOM', actorId: HOST });
  expect(room.phase).toBe('finished');
  return room;
};

describe('N8: every Phase-1 module replays deterministically', () => {
  it('covers exactly the Phase-1 set', () => {
    expect(PHASE_1_MODULES.map((module) => module.id)).toEqual([M1_ID, M2_ID, M3_ID, G1_ID, G6_ID]);
  });

  for (const moduleId of [M1_ID, M2_ID, M3_ID, G1_ID, G6_ID]) {
    it(`${moduleId}: same seed and actions produce an identical final RoomState`, () => {
      const first = playSession(moduleId, 2024, false);
      const second = playSession(moduleId, 2024, false);
      expect(second).toEqual(first);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      expect(activeSession(first)?.rounds).toHaveLength(3);
      expect(first.players.some((player) => player.score > 0 || player.sips > 0)).toBe(true);
    });

    it(`${moduleId}: survives a JSON round-trip on every dispatch unchanged`, () => {
      expect(playSession(moduleId, 99, true)).toEqual(playSession(moduleId, 99, false));
    });

    it(`${moduleId}: a different seed plays a different game`, () => {
      const a = activeSession(playSession(moduleId, 1, false))?.rounds.map((round) => round.publicPayload);
      const b = activeSession(playSession(moduleId, 2, false))?.rounds.map((round) => round.publicPayload);
      expect(JSON.stringify(b)).not.toBe(JSON.stringify(a));
    });
  }
});
