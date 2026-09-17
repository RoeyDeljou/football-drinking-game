import { describe, expect, it } from 'vitest';
import type { RoomAction } from './actions.js';
import { HOST_ONLY_ACTIONS } from './actions.js';
import { EMPTY_DATA_CONTEXT } from './data.js';
import { asGameModuleId, asPlayerId, asRoundId } from './ids.js';
import { defineGameModule } from './module.js';
import { createModuleRegistry } from './modules/registry.js';
import { penalty } from './penalties.js';
import { pickRoundWinners } from './scoring.js';
import { z } from 'zod';
import type { EngineDeps, Reduction } from './reducer.js';
import { reduceAll, reduceRoom } from './reducer.js';
import type { RoomState } from './state.js';
import { activeSession, currentRound } from './state.js';
import { HOST, makeHarness, newRoom, P2, P3, T0, matchEvent, sampleData } from './harness.test-utils.js';
import { scoreChoiceRound } from './modules/helpers.js';

/* ------------------------- a deterministic test game ------------------------ */

const TEST_ID = asGameModuleId('TEST');
const testConfigSchema = z
  .object({ fail: z.boolean(), answerWindowMs: z.number().int().min(1_000) })
  .strict();
const testPublicSchema = z.object({ options: z.array(z.number().int()) }).strict();
const testSolutionSchema = z.object({ value: z.number().int() }).strict();
const testSubmissionSchema = z.object({ value: z.number().int() }).strict();

interface TestShape {
  readonly config: z.infer<typeof testConfigSchema>;
  readonly publicPayload: z.infer<typeof testPublicSchema>;
  readonly privatePayload: null;
  readonly solution: z.infer<typeof testSolutionSchema>;
  readonly submission: z.infer<typeof testSubmissionSchema>;
}

const testModule = defineGameModule<TestShape>({
  id: TEST_ID,
  category: 'general',
  kind: 'simultaneous-answer',
  dataRequirements: [],
  minPlayers: 1,
  maxPlayers: 4,
  allowResubmission: false,
  defaultConfig: { fail: false, answerWindowMs: 10_000 },
  configSchema: testConfigSchema,
  publicPayloadSchema: testPublicSchema,
  privatePayloadSchema: z.null(),
  solutionSchema: testSolutionSchema,
  submissionSchema: testSubmissionSchema,
  generateRound: (ctx) =>
    ctx.config.fail
      ? { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'configured to fail' }
      : {
          ok: true,
          round: {
            publicPayload: { options: [1, 2, 3] },
            privatePayloads: {},
            solution: { value: (ctx.roundIndex % 3) + 1 },
            contentKey: `c${ctx.roundIndex}`,
            answerWindowMs: ctx.config.answerWindowMs,
            turnOrder: null,
          },
        },
  validateSubmission: (ctx) => {
    const parsed = testSubmissionSchema.safeParse(ctx.raw);
    if (!parsed.success) return { ok: false, code: 'SCHEMA', detail: null };
    if (!ctx.round.publicPayload.options.includes(parsed.data.value)) {
      return { ok: false, code: 'UNKNOWN_OPTION', detail: String(parsed.data.value) };
    }
    return { ok: true, payload: parsed.data };
  },
  scoreRound: (ctx) => {
    const scores = scoreChoiceRound<TestShape>({
      players: ctx.players,
      submissions: ctx.submissions,
      isCorrect: (submission) => submission.payload.value === ctx.round.solution.value,
      windowMs: ctx.round.answerWindowMs,
      scoring: ctx.scoring,
    });
    return {
      scores,
      winnerIds: pickRoundWinners(scores),
      penalties: scores
        .filter((score) => !score.correct)
        .map((score) => penalty(score.playerId, 'self', 2, 'WRONG_ANSWER')),
      summary: { value: ctx.round.solution.value },
    };
  },
  projectRound: (ctx) => ({
    publicPayload: ctx.round.publicPayload,
    privatePayload: null,
    solution: ctx.visibility === 'revealed' ? ctx.round.solution : null,
  }),
});

const registry = createModuleRegistry([testModule]);

const harness = (now = T0) =>
  makeHarness({ now, modules: registry, data: { ...sampleData(), quality: null } });

const join = (playerId: string, nickname: string): RoomAction => ({
  type: 'PLAYER_JOIN',
  playerId: asPlayerId(playerId),
  nickname,
  isGuest: true,
});

const selectAndStart = (config: Partial<TestShape['config']> = {}): readonly RoomAction[] => [
  {
    type: 'SELECT_GAME',
    actorId: HOST,
    moduleId: TEST_ID,
    config: { fail: false, answerWindowMs: 10_000, ...config },
  },
  { type: 'START_SESSION', actorId: HOST },
];

/** A two-player room sitting on round 1 of the test game. */
const playingRoom = (deps: EngineDeps): RoomState => {
  const result = reduceAll(newRoom(), [join('p2', 'Bea'), ...selectAndStart()], deps);
  expect(result.rejection).toBeNull();
  expect(result.state.phase).toBe('playing');
  return result.state;
};

const expectRejected = (result: Reduction, code: string): void => {
  expect(result.rejection?.code).toBe(code);
  expect(result.events).toEqual([]);
};

/* --------------------------------- lobby ---------------------------------- */

describe('presence', () => {
  it('adds a joining player and bumps the version', () => {
    const { deps } = harness();
    const before = newRoom();
    const result = reduceRoom(before, join('p2', 'Bea'), deps);
    expect(result.rejection).toBeNull();
    expect(result.state.players).toHaveLength(2);
    expect(result.state.version).toBe(before.version + 1);
    expect(result.events).toEqual([{ type: 'PLAYER_JOINED', playerId: P2 }]);
  });

  it('returns the identical state object when an action is rejected', () => {
    const { deps } = harness();
    const before = newRoom();
    const result = reduceRoom(before, join('host', 'Host'), deps);
    expectRejected(result, 'PLAYER_ALREADY_JOINED');
    expect(result.state).toBe(before);
    expect(result.state.version).toBe(before.version);
  });

  it('refuses a duplicate nickname regardless of case', () => {
    const { deps } = harness();
    expectRejected(reduceRoom(newRoom(), join('p2', ' host '), deps), 'NICKNAME_TAKEN');
  });

  it('refuses a join once the room is full', () => {
    const { deps } = harness();
    const room = reduceRoom(
      newRoom(),
      { type: 'UPDATE_SETTINGS', actorId: HOST, patch: { maxPlayers: 2 } },
      deps,
    ).state;
    const withTwo = reduceRoom(room, join('p2', 'Bea'), deps).state;
    expectRejected(reduceRoom(withTwo, join('p3', 'Cal'), deps), 'ROOM_FULL');
  });

  it('refuses a late join when the host disabled it', () => {
    const { deps } = harness();
    const room = reduceAll(
      newRoom(),
      [
        join('p2', 'Bea'),
        { type: 'UPDATE_SETTINGS', actorId: HOST, patch: { allowLateJoin: false } },
        ...selectAndStart(),
      ],
      deps,
    ).state;
    expectRejected(reduceRoom(room, join('p3', 'Cal'), deps), 'LATE_JOIN_DISABLED');
  });

  it('allows a late join mid-game by default', () => {
    const { deps } = harness();
    const room = playingRoom(deps);
    expect(reduceRoom(room, join('p3', 'Cal'), deps).state.players).toHaveLength(3);
  });

  it('lets a player who left rejoin with their old id', () => {
    const { deps } = harness();
    const room = reduceAll(
      newRoom(),
      [join('p2', 'Bea'), { type: 'PLAYER_LEAVE', playerId: P2 }],
      deps,
    ).state;
    const back = reduceRoom(room, join('p2', 'Bea'), deps);
    expect(back.rejection).toBeNull();
    expect(back.state.players.filter((player) => player.leftAt === null)).toHaveLength(2);
  });

  it('tracks disconnect and reconnect, and ignores a repeat', () => {
    const { deps } = harness();
    const room = reduceRoom(newRoom(), join('p2', 'Bea'), deps).state;
    const gone = reduceRoom(room, { type: 'PLAYER_DISCONNECTED', playerId: P2 }, deps);
    expect(gone.state.players.find((player) => player.id === P2)?.connected).toBe(false);
    const again = reduceRoom(gone.state, { type: 'PLAYER_DISCONNECTED', playerId: P2 }, deps);
    expect(again.state).toBe(gone.state);
    expect(again.rejection).toBeNull();
    const back = reduceRoom(gone.state, { type: 'PLAYER_RECONNECTED', playerId: P2 }, deps);
    expect(back.state.players.find((player) => player.id === P2)?.connected).toBe(true);
  });

  it('rejects presence actions for an unknown player', () => {
    const { deps } = harness();
    expectRejected(
      reduceRoom(newRoom(), { type: 'PLAYER_DISCONNECTED', playerId: asPlayerId('nobody') }, deps),
      'PLAYER_NOT_FOUND',
    );
    expectRejected(
      reduceRoom(newRoom(), { type: 'PLAYER_LEAVE', playerId: asPlayerId('nobody') }, deps),
      'PLAYER_NOT_FOUND',
    );
  });

  it('hands the host role to the longest-standing player when the host leaves', () => {
    const { deps } = harness();
    const room = reduceAll(newRoom(), [join('p2', 'Bea'), join('p3', 'Cal')], deps).state;
    const result = reduceRoom(room, { type: 'PLAYER_LEAVE', playerId: HOST }, deps);
    expect(result.state.hostPlayerId).toBe(P2);
    expect(result.events).toContainEqual({ type: 'HOST_CHANGED', playerId: P2 });
  });

  it('aborts the room when the last player leaves', () => {
    const { deps } = harness();
    const result = reduceRoom(newRoom(), { type: 'PLAYER_LEAVE', playerId: HOST }, deps);
    expect(result.state.phase).toBe('aborted');
    expect(result.state.abortReason).toBe('ALL_PLAYERS_LEFT');
  });

  it('transfers the host on request but not to a stranger', () => {
    const { deps } = harness();
    const room = reduceRoom(newRoom(), join('p2', 'Bea'), deps).state;
    expect(
      reduceRoom(room, { type: 'TRANSFER_HOST', actorId: HOST, targetPlayerId: P2 }, deps).state.hostPlayerId,
    ).toBe(P2);
    expectRejected(
      reduceRoom(room, { type: 'TRANSFER_HOST', actorId: HOST, targetPlayerId: P3 }, deps),
      'PLAYER_NOT_FOUND',
    );
  });

  it('kicks a player but never the host', () => {
    const { deps } = harness();
    const room = reduceRoom(newRoom(), join('p2', 'Bea'), deps).state;
    const kicked = reduceRoom(room, { type: 'KICK_PLAYER', actorId: HOST, targetPlayerId: P2 }, deps);
    expect(kicked.state.players.find((player) => player.id === P2)?.leftAt).toBe(T0);
    expectRejected(
      reduceRoom(room, { type: 'KICK_PLAYER', actorId: HOST, targetPlayerId: HOST }, deps),
      'CANNOT_KICK_HOST',
    );
  });
});

describe('host-only authorization', () => {
  const nonHostAction = (type: string): RoomAction => {
    switch (type) {
      case 'TRANSFER_HOST':
        return { type: 'TRANSFER_HOST', actorId: P2, targetPlayerId: HOST };
      case 'KICK_PLAYER':
        return { type: 'KICK_PLAYER', actorId: P2, targetPlayerId: HOST };
      case 'UPDATE_SETTINGS':
        return { type: 'UPDATE_SETTINGS', actorId: P2, patch: { maxPlayers: 4 } };
      case 'SELECT_GAME':
        return { type: 'SELECT_GAME', actorId: P2, moduleId: TEST_ID, config: null };
      case 'START_LOADING':
        return { type: 'START_LOADING', actorId: P2, stepKeys: ['fixtures'] };
      case 'START_SESSION':
        return { type: 'START_SESSION', actorId: P2 };
      case 'ADVANCE':
        return { type: 'ADVANCE', actorId: P2 };
      case 'END_SESSION':
        return { type: 'END_SESSION', actorId: P2 };
      case 'FINISH_ROOM':
        return { type: 'FINISH_ROOM', actorId: P2 };
      case 'LOCK_ROUND':
        return { type: 'LOCK_ROUND', actorId: P2 };
      case 'REVEAL_ROUND':
        return { type: 'REVEAL_ROUND', actorId: P2 };
      case 'ABORT_ROOM':
        return { type: 'ABORT_ROOM', actorId: P2, reason: 'HOST_ABORTED' };
      default:
        throw new Error(`no fixture for host-only action ${type}`);
    }
  };

  it('rejects every host-only action from a guest', () => {
    const { deps } = harness();
    const room = reduceRoom(newRoom(), join('p2', 'Bea'), deps).state;
    for (const type of HOST_ONLY_ACTIONS) {
      expectRejected(reduceRoom(room, nonHostAction(type), deps), 'NOT_HOST');
    }
  });

  it('rejects a guest trying to lock, reveal or abort', () => {
    const { deps } = harness();
    const room = playingRoom(deps);
    expectRejected(reduceRoom(room, { type: 'LOCK_ROUND', actorId: P2 }, deps), 'NOT_HOST');
    expectRejected(reduceRoom(room, { type: 'REVEAL_ROUND', actorId: P2 }, deps), 'NOT_HOST');
    expectRejected(
      reduceRoom(room, { type: 'ABORT_ROOM', actorId: P2, reason: 'HOST_ABORTED' }, deps),
      'NOT_HOST',
    );
  });

  it('B1: accepts the server-only system lock, reveal and abort', () => {
    const { deps } = harness();
    const room = playingRoom(deps);
    const locked = reduceRoom(room, { type: 'SYSTEM_LOCK_ROUND' }, deps);
    expect(locked.rejection).toBeNull();
    expect(currentRound(locked.state)?.status).toBe('locked');
    expect(reduceRoom(room, { type: 'SYSTEM_REVEAL_ROUND' }, deps).state.phase).toBe('roundReveal');
    const aborted = reduceRoom(room, { type: 'SYSTEM_ABORT_ROOM', reason: 'TIMED_OUT' }, deps);
    expect(aborted.state.phase).toBe('aborted');
    expect(aborted.state.abortReason).toBe('TIMED_OUT');
  });

  it('B1: lets the host lock, reveal and abort', () => {
    const { deps } = harness();
    const room = playingRoom(deps);
    expect(reduceRoom(room, { type: 'LOCK_ROUND', actorId: HOST }, deps).rejection).toBeNull();
    expect(reduceRoom(room, { type: 'REVEAL_ROUND', actorId: HOST }, deps).state.phase).toBe('roundReveal');
    expect(
      reduceRoom(room, { type: 'ABORT_ROOM', actorId: HOST, reason: 'HOST_ABORTED' }, deps).state.phase,
    ).toBe('aborted');
  });
});

describe('setup', () => {
  it('validates a settings patch and refuses an inconsistent one', () => {
    const { deps } = harness();
    const room = newRoom();
    expect(
      reduceRoom(room, { type: 'UPDATE_SETTINGS', actorId: HOST, patch: { roundsPerSession: 3 } }, deps).state
        .settings.roundsPerSession,
    ).toBe(3);
    expectRejected(
      reduceRoom(
        room,
        { type: 'UPDATE_SETTINGS', actorId: HOST, patch: { maxPlayers: 1, minPlayersToStart: 5 } },
        deps,
      ),
      'INVALID_SETTINGS',
    );
    expectRejected(
      reduceRoom(room, { type: 'UPDATE_SETTINGS', actorId: HOST, patch: { answerWindowMs: 5 } }, deps),
      'INVALID_SETTINGS',
    );
  });

  it('refuses settings changes mid-round', () => {
    const { deps } = harness();
    const room = playingRoom(deps);
    expectRejected(
      reduceRoom(room, { type: 'UPDATE_SETTINGS', actorId: HOST, patch: { maxPlayers: 9 } }, deps),
      'WRONG_PHASE',
    );
  });

  it('selects a game, defaulting and validating the config', () => {
    const { deps } = harness();
    const room = newRoom();
    const withDefault = reduceRoom(
      room,
      { type: 'SELECT_GAME', actorId: HOST, moduleId: TEST_ID, config: null },
      deps,
    );
    expect(withDefault.state.selection?.config).toEqual({ fail: false, answerWindowMs: 10_000 });
    expectRejected(
      reduceRoom(
        room,
        { type: 'SELECT_GAME', actorId: HOST, moduleId: asGameModuleId('NOPE'), config: null },
        deps,
      ),
      'UNKNOWN_MODULE',
    );
    expectRejected(
      reduceRoom(
        room,
        { type: 'SELECT_GAME', actorId: HOST, moduleId: TEST_ID, config: { fail: 'yes' } },
        deps,
      ),
      'INVALID_CONFIG',
    );
  });

  it('refuses a game whose data is unavailable', () => {
    const { deps: depsWithModules } = harness();
    const deps: EngineDeps = {
      ...depsWithModules,
      data: { ...EMPTY_DATA_CONTEXT, quality: null },
      modules: createModuleRegistry([
        defineGameModule<TestShape>({
          id: asGameModuleId('NEEDS_DATA'),
          category: 'matchday',
          kind: 'simultaneous-answer',
          dataRequirements: ['hasLineups'],
          minPlayers: 1,
          maxPlayers: null,
          allowResubmission: false,
          defaultConfig: { fail: false, answerWindowMs: 10_000 },
          configSchema: testConfigSchema,
          publicPayloadSchema: testPublicSchema,
          privatePayloadSchema: z.null(),
          solutionSchema: testSolutionSchema,
          submissionSchema: testSubmissionSchema,
          generateRound: () => ({ ok: false, reason: 'INSUFFICIENT_DATA', detail: null }),
          validateSubmission: () => ({ ok: false, code: 'SCHEMA', detail: null }),
          scoreRound: () => ({ scores: [], winnerIds: [], penalties: [], summary: null }),
          projectRound: (ctx) => ({
            publicPayload: ctx.round.publicPayload,
            privatePayload: null,
            solution: null,
          }),
        }),
      ]),
    };
    expectRejected(
      reduceRoom(
        newRoom(),
        { type: 'SELECT_GAME', actorId: HOST, moduleId: asGameModuleId('NEEDS_DATA'), config: null },
        deps,
      ),
      'DATA_UNAVAILABLE',
    );
  });

  it('drives the loading screen, reports an unknown step and allows a retry after failure', () => {
    const { deps } = harness();
    const selected = reduceRoom(
      newRoom(),
      { type: 'SELECT_GAME', actorId: HOST, moduleId: TEST_ID, config: null },
      deps,
    ).state;
    const loading = reduceRoom(
      selected,
      { type: 'START_LOADING', actorId: HOST, stepKeys: ['fixtures', 'lineups'] },
      deps,
    );
    expect(loading.state.phase).toBe('loading');
    expect(loading.state.loading?.steps.map((step) => step.status)).toEqual(['active', 'pending']);

    const progressed = reduceRoom(
      loading.state,
      { type: 'LOADING_PROGRESS', stepKey: 'fixtures', status: 'done', detail: null },
      deps,
    );
    expect(progressed.state.loading?.steps[0]?.status).toBe('done');
    expectRejected(
      reduceRoom(
        progressed.state,
        { type: 'LOADING_PROGRESS', stepKey: 'ghost', status: 'done', detail: null },
        deps,
      ),
      'UNKNOWN_LOADING_STEP',
    );

    const failed = reduceRoom(progressed.state, { type: 'LOADING_FAILED', reason: 'provider 503' }, deps);
    expect(failed.state.loading?.failedReason).toBe('provider 503');
    const retried = reduceRoom(
      failed.state,
      { type: 'START_LOADING', actorId: HOST, stepKeys: ['fixtures'] },
      deps,
    );
    expect(retried.rejection).toBeNull();
    expect(retried.state.loading?.failedReason).toBeNull();
  });

  it('refuses loading and progress outside the right phase', () => {
    const { deps } = harness();
    expectRejected(
      reduceRoom(newRoom(), { type: 'START_LOADING', actorId: HOST, stepKeys: ['fixtures'] }, deps),
      'NO_GAME_SELECTED',
    );
    expectRejected(
      reduceRoom(
        newRoom(),
        { type: 'LOADING_PROGRESS', stepKey: 'fixtures', status: 'done', detail: null },
        deps,
      ),
      'WRONG_PHASE',
    );
    expectRejected(reduceRoom(newRoom(), { type: 'LOADING_FAILED', reason: 'x' }, deps), 'WRONG_PHASE');
  });
});

describe('starting a session', () => {
  it('needs a selected game and enough players', () => {
    const { deps } = harness();
    expectRejected(reduceRoom(newRoom(), { type: 'START_SESSION', actorId: HOST }, deps), 'NO_GAME_SELECTED');

    const selected = reduceRoom(
      newRoom(),
      { type: 'SELECT_GAME', actorId: HOST, moduleId: TEST_ID, config: null },
      deps,
    ).state;
    expectRejected(
      reduceRoom(selected, { type: 'START_SESSION', actorId: HOST }, deps),
      'NOT_ENOUGH_PLAYERS',
    );
  });

  it('refuses more players than the module supports', () => {
    const { deps } = harness();
    const room = reduceAll(
      newRoom(),
      [
        join('p2', 'Bea'),
        join('p3', 'Cal'),
        join('p4', 'Dee'),
        join('p5', 'Eve'),
        { type: 'SELECT_GAME', actorId: HOST, moduleId: TEST_ID, config: null },
      ],
      deps,
    ).state;
    expectRejected(reduceRoom(room, { type: 'START_SESSION', actorId: HOST }, deps), 'TOO_MANY_PLAYERS');
  });

  it('reports a generator failure without corrupting the room', () => {
    const { deps } = harness();
    const room = reduceAll(
      newRoom(),
      [join('p2', 'Bea'), ...selectAndStart({ fail: true }).slice(0, 1)],
      deps,
    ).state;
    const result = reduceRoom(room, { type: 'START_SESSION', actorId: HOST }, deps);
    expect(result.rejection?.code).toBe('ROUND_GENERATION_FAILED');
    expect(result.state).toBe(room);
    expect(result.state.phase).toBe('lobby');
  });

  it('opens round one with a deadline and emits the right events', () => {
    const { deps } = harness();
    const room = playingRoom(deps);
    const round = currentRound(room);
    expect(round?.status).toBe('open');
    expect(round?.deadlineAt).toBe(T0 + 10_000);
    expect(activeSession(room)?.rounds).toHaveLength(1);
  });
});

describe('submissions', () => {
  it('accepts a valid answer and records the elapsed time', () => {
    const { deps, clock } = harness();
    const room = playingRoom(deps);
    const round = currentRound(room);
    clock.advance(2_500);
    const result = reduceRoom(
      room,
      { type: 'SUBMIT_ANSWER', playerId: P2, roundId: round?.id ?? asRoundId('x'), payload: { value: 2 } },
      deps,
    );
    expect(result.rejection).toBeNull();
    const submission = currentRound(result.state)?.submissions[0];
    expect(submission?.elapsedMs).toBe(2_500);
    expect(submission?.sequence).toBe(1);
    expect(result.events[0]).toEqual({
      type: 'SUBMISSION_ACCEPTED',
      playerId: P2,
      roundId: round?.id,
      replaced: false,
    });
  });

  it('rejects a second answer from the same player', () => {
    const { deps } = harness();
    const room = playingRoom(deps);
    const roundId = currentRound(room)?.id ?? asRoundId('x');
    const once = reduceRoom(
      room,
      { type: 'SUBMIT_ANSWER', playerId: P2, roundId, payload: { value: 2 } },
      deps,
    ).state;
    expectRejected(
      reduceRoom(once, { type: 'SUBMIT_ANSWER', playerId: P2, roundId, payload: { value: 3 } }, deps),
      'DUPLICATE_SUBMISSION',
    );
  });

  it('rejects an answer after the deadline', () => {
    const { deps, clock } = harness();
    const room = playingRoom(deps);
    const roundId = currentRound(room)?.id ?? asRoundId('x');
    clock.advance(10_001);
    expectRejected(
      reduceRoom(room, { type: 'SUBMIT_ANSWER', playerId: P2, roundId, payload: { value: 2 } }, deps),
      'DEADLINE_PASSED',
    );
  });

  it('rejects an answer for the wrong round, a schema-invalid payload and an unknown option', () => {
    const { deps } = harness();
    const room = playingRoom(deps);
    const roundId = currentRound(room)?.id ?? asRoundId('x');
    expectRejected(
      reduceRoom(
        room,
        { type: 'SUBMIT_ANSWER', playerId: P2, roundId: asRoundId('other'), payload: { value: 1 } },
        deps,
      ),
      'ROUND_NOT_FOUND',
    );
    const bad = reduceRoom(
      room,
      { type: 'SUBMIT_ANSWER', playerId: P2, roundId, payload: { nope: true } },
      deps,
    );
    expect(bad.rejection?.code).toBe('INVALID_SUBMISSION');
    expect(bad.rejection?.submissionCode).toBe('SCHEMA');
    const unknown = reduceRoom(
      room,
      { type: 'SUBMIT_ANSWER', playerId: P2, roundId, payload: { value: 99 } },
      deps,
    );
    expect(unknown.rejection?.submissionCode).toBe('UNKNOWN_OPTION');
  });

  it('rejects an answer from a stranger, from a player who left, and in the wrong phase', () => {
    const { deps } = harness();
    const room = playingRoom(deps);
    const roundId = currentRound(room)?.id ?? asRoundId('x');
    expectRejected(
      reduceRoom(
        room,
        { type: 'SUBMIT_ANSWER', playerId: asPlayerId('ghost'), roundId, payload: { value: 1 } },
        deps,
      ),
      'PLAYER_NOT_FOUND',
    );
    const left = reduceRoom(room, { type: 'PLAYER_LEAVE', playerId: P2 }, deps).state;
    expectRejected(
      reduceRoom(left, { type: 'SUBMIT_ANSWER', playerId: P2, roundId, payload: { value: 1 } }, deps),
      'PLAYER_NOT_FOUND',
    );
    expectRejected(
      reduceRoom(newRoom(), { type: 'SUBMIT_ANSWER', playerId: HOST, roundId, payload: { value: 1 } }, deps),
      'WRONG_PHASE',
    );
  });

  it('rejects an answer once the round is locked', () => {
    const { deps } = harness();
    const room = playingRoom(deps);
    const roundId = currentRound(room)?.id ?? asRoundId('x');
    const locked = reduceRoom(room, { type: 'LOCK_ROUND', actorId: HOST }, deps).state;
    expectRejected(
      reduceRoom(locked, { type: 'SUBMIT_ANSWER', playerId: P2, roundId, payload: { value: 1 } }, deps),
      'ROUND_CLOSED',
    );
    expectRejected(reduceRoom(locked, { type: 'LOCK_ROUND', actorId: HOST }, deps), 'ROUND_CLOSED');
  });
});

describe('reveal and scoring', () => {
  const answerAll = (room: RoomState, deps: EngineDeps, hostValue: number, guestValue: number): Reduction => {
    const roundId = currentRound(room)?.id ?? asRoundId('x');
    return reduceAll(
      room,
      [
        { type: 'SUBMIT_ANSWER', playerId: HOST, roundId, payload: { value: hostValue } },
        { type: 'SUBMIT_ANSWER', playerId: P2, roundId, payload: { value: guestValue } },
      ],
      deps,
    );
  };

  it('locks and reveals automatically once everyone has answered', () => {
    const { deps } = harness();
    const room = playingRoom(deps);
    const result = answerAll(room, deps, 1, 2);
    expect(result.state.phase).toBe('roundReveal');
    const round = currentRound(result.state);
    expect(round?.status).toBe('resolved');
    expect(round?.revealedAt).toBe(T0);
    expect(result.events.map((event) => event.type)).toContain('ROUND_LOCKED');
    expect(result.events.map((event) => event.type)).toContain('ROUND_REVEALED');
  });

  it('applies points, streaks, round wins and sips to the players', () => {
    const { deps } = harness();
    const room = playingRoom(deps);
    const result = answerAll(room, deps, 1, 2);
    const host = result.state.players.find((player) => player.id === HOST);
    const guest = result.state.players.find((player) => player.id === P2);
    expect(host?.score).toBeGreaterThan(0);
    expect(host?.correctAnswers).toBe(1);
    expect(host?.streak).toBe(1);
    expect(host?.roundsWon).toBe(1);
    expect(host?.sips).toBe(0);
    expect(guest?.score).toBe(0);
    expect(guest?.streak).toBe(0);
    expect(guest?.sips).toBe(2);
    expect(result.state.penalties).toHaveLength(1);
    expect(result.state.penalties[0]?.reason).toBe('WRONG_ANSWER');
  });

  it('resets a streak on a wrong answer and grows it on a run', () => {
    const { deps, clock } = harness();
    let room = playingRoom(deps);
    room = answerAll(room, deps, 1, 1).state; // round 1 answer is 1
    room = reduceAll(
      room,
      [
        { type: 'ADVANCE', actorId: HOST },
        { type: 'ADVANCE', actorId: HOST },
      ],
      deps,
    ).state;
    clock.advance(10);
    room = answerAll(room, deps, 2, 1).state; // round 2 answer is 2
    const host = room.players.find((player) => player.id === HOST);
    const guest = room.players.find((player) => player.id === P2);
    expect(host?.streak).toBe(2);
    expect(host?.bestStreak).toBe(2);
    expect(guest?.streak).toBe(0);
    expect(guest?.bestStreak).toBe(1);
  });

  it('counts a non-answer as incorrect without a submission time', () => {
    const { deps } = harness();
    const room = playingRoom(deps);
    const revealed = reduceRoom(room, { type: 'REVEAL_ROUND', actorId: HOST }, deps).state;
    const host = revealed.players.find((player) => player.id === HOST);
    expect(host?.totalResponseMs).toBe(0);
    expect(host?.sips).toBe(2);
    expect(currentRound(revealed)?.outcome?.winnerIds).toEqual([]);
  });

  it('reveals on TICK once the answer window has expired, and does nothing before', () => {
    const { deps, clock } = harness();
    const room = playingRoom(deps);
    expect(reduceRoom(room, { type: 'TICK' }, deps).state).toBe(room);
    clock.advance(10_000);
    const expired = reduceRoom(room, { type: 'TICK' }, deps);
    expect(expired.state.phase).toBe('roundReveal');
    expect(reduceRoom(newRoom(), { type: 'TICK' }, deps).rejection).toBeNull();
  });

  it('refuses to reveal the same round twice', () => {
    const { deps } = harness();
    const room = playingRoom(deps);
    const revealed = reduceRoom(room, { type: 'REVEAL_ROUND', actorId: HOST }, deps).state;
    expectRejected(reduceRoom(revealed, { type: 'REVEAL_ROUND', actorId: HOST }, deps), 'WRONG_PHASE');
  });

  it('honours the per-session sip cap across rounds', () => {
    const { deps, clock } = harness();
    let room = reduceAll(
      newRoom(),
      [
        join('p2', 'Bea'),
        {
          type: 'UPDATE_SETTINGS',
          actorId: HOST,
          patch: { penaltyCaps: { perPenalty: 6, perRound: 10, perSession: 3 } },
        },
        ...selectAndStart(),
      ],
      deps,
    ).state;
    // Nobody answers either round, so each round emits a 2-sip NO_ANSWER-style penalty.
    room = reduceRoom(room, { type: 'REVEAL_ROUND', actorId: HOST }, deps).state;
    room = reduceAll(
      room,
      [
        { type: 'ADVANCE', actorId: HOST },
        { type: 'ADVANCE', actorId: HOST },
      ],
      deps,
    ).state;
    clock.advance(5);
    room = reduceRoom(room, { type: 'REVEAL_ROUND', actorId: HOST }, deps).state;
    const guest = room.players.find((player) => player.id === P2);
    expect(guest?.sips).toBe(3);
  });
});

describe('progression', () => {
  const finishRound = (room: RoomState, deps: EngineDeps): RoomState =>
    reduceRoom(room, { type: 'REVEAL_ROUND', actorId: HOST }, deps).state;

  it('walks roundReveal → intermission → playing', () => {
    const { deps } = harness();
    const revealed = finishRound(playingRoom(deps), deps);
    const intermission = reduceRoom(revealed, { type: 'ADVANCE', actorId: HOST }, deps);
    expect(intermission.state.phase).toBe('intermission');
    expect(intermission.events).toContainEqual({
      type: 'PHASE_CHANGED',
      from: 'roundReveal',
      to: 'intermission',
    });

    const next = reduceRoom(intermission.state, { type: 'ADVANCE', actorId: HOST }, deps);
    expect(next.state.phase).toBe('playing');
    expect(activeSession(next.state)?.rounds).toHaveLength(2);
    expect(currentRound(next.state)?.index).toBe(1);
  });

  it('Kahoot-style: reaching the last round goes to intermission, not finished, with finishedAt set', () => {
    const { deps } = harness();
    let room = reduceAll(
      newRoom(),
      [
        join('p2', 'Bea'),
        { type: 'UPDATE_SETTINGS', actorId: HOST, patch: { roundsPerSession: 2 } },
        ...selectAndStart(),
      ],
      deps,
    ).state;

    room = finishRound(room, deps);
    room = reduceAll(
      room,
      [
        { type: 'ADVANCE', actorId: HOST },
        { type: 'ADVANCE', actorId: HOST },
      ],
      deps,
    ).state;
    expect(room.phase).toBe('playing');

    // Reveal the last round: REVEAL_ROUND behaves exactly like any other round-end.
    room = finishRound(room, deps);
    expect(room.phase).toBe('roundReveal');
    expect(activeSession(room)?.finishedAt).toBeNull();

    // ADVANCE from that reveal goes to intermission — not 'finished' — and sets finishedAt right there.
    const afterLastRound = reduceRoom(room, { type: 'ADVANCE', actorId: HOST }, deps);
    expect(afterLastRound.state.phase).toBe('intermission');
    expect(afterLastRound.events.map((event) => event.type)).toContain('SESSION_FINISHED');
    expect(afterLastRound.events.some((event) => event.type === 'ROOM_FINISHED')).toBe(false);
    expect(activeSession(afterLastRound.state)?.finishedAt).toBe(T0);

    // The room is not terminal: joining, kicking, etc. still work.
    expect(reduceRoom(afterLastRound.state, join('p9', 'Zed'), deps).rejection).toBeNull();

    // A further ADVANCE (trying to keep playing the same, now-finished session) is refused.
    const stuck = reduceRoom(afterLastRound.state, { type: 'ADVANCE', actorId: HOST }, deps);
    expect(stuck.rejection?.code).toBe('SESSION_FINISHED');
    expect(stuck.state).toBe(afterLastRound.state);
  });

  it('the room only ever reaches finished via an explicit FINISH_ROOM, never automatically', () => {
    const { deps } = harness();
    let room = reduceAll(
      newRoom(),
      [
        join('p2', 'Bea'),
        { type: 'UPDATE_SETTINGS', actorId: HOST, patch: { roundsPerSession: 1 } },
        ...selectAndStart(),
      ],
      deps,
    ).state;

    room = finishRound(room, deps); // roundReveal, on the session's only (= last) round
    const afterLastRound = reduceRoom(room, { type: 'ADVANCE', actorId: HOST }, deps).state;
    expect(afterLastRound.phase).toBe('intermission');
    // Still not terminal: TICK, more ADVANCEs, etc. never silently produce 'finished'.
    expect(reduceRoom(afterLastRound, { type: 'TICK' }, deps).state.phase).not.toBe('finished');
    expect(reduceRoom(afterLastRound, { type: 'ADVANCE', actorId: HOST }, deps).state.phase).not.toBe(
      'finished',
    );

    const finished = reduceRoom(afterLastRound, { type: 'FINISH_ROOM', actorId: HOST }, deps);
    expect(finished.state.phase).toBe('finished');
    expect(finished.events.map((event) => event.type)).toContain('ROOM_FINISHED');
  });

  it('FINISH_ROOM from intermission after a natural session end still works', () => {
    const { deps } = harness();
    let room = reduceAll(
      newRoom(),
      [
        join('p2', 'Bea'),
        { type: 'UPDATE_SETTINGS', actorId: HOST, patch: { roundsPerSession: 1 } },
        ...selectAndStart(),
      ],
      deps,
    ).state;
    room = finishRound(room, deps);
    const intermission = reduceRoom(room, { type: 'ADVANCE', actorId: HOST }, deps).state;
    expect(intermission.phase).toBe('intermission');

    const done = reduceRoom(intermission, { type: 'FINISH_ROOM', actorId: HOST }, deps);
    expect(done.state.phase).toBe('finished');
    // The session that ended naturally stays finished, and stays the only session.
    expect(done.state.sessions).toHaveLength(1);
    expect(done.state.sessions[0]?.finishedAt).toBe(T0);
  });

  it('SELECT_GAME + START_SESSION from intermission after a natural session end starts a genuinely new session', () => {
    const { deps } = harness();
    let room = reduceAll(
      newRoom(),
      [
        join('p2', 'Bea'),
        { type: 'UPDATE_SETTINGS', actorId: HOST, patch: { roundsPerSession: 1 } },
        ...selectAndStart(),
      ],
      deps,
    ).state;
    room = finishRound(room, deps);
    const intermission = reduceRoom(room, { type: 'ADVANCE', actorId: HOST }, deps).state;
    expect(intermission.phase).toBe('intermission');
    expect(intermission.activeSessionIndex).toBe(0);

    const second = reduceAll(intermission, selectAndStart(), deps);
    expect(second.rejection).toBeNull();
    expect(second.state.phase).toBe('playing');
    expect(second.state.activeSessionIndex).toBe(1);
    expect(second.state.sessions).toHaveLength(2);
    expect(second.state.sessions[0]?.finishedAt).toBe(T0); // the first session stays finished
    expect(activeSession(second.state)?.finishedAt).toBeNull(); // the new one is not
    expect(activeSession(second.state)?.rounds).toHaveLength(1);
  });

  it('refuses to advance from the lobby', () => {
    const { deps } = harness();
    expectRejected(reduceRoom(newRoom(), { type: 'ADVANCE', actorId: HOST }, deps), 'WRONG_PHASE');
  });

  it('ends a session back to intermission and allows a second game to start there', () => {
    const { deps } = harness();
    const room = playingRoom(deps);
    const ended = reduceRoom(room, { type: 'END_SESSION', actorId: HOST }, deps);
    expect(ended.state.phase).toBe('intermission');
    expect(ended.state.sessions[0]?.finishedAt).toBe(T0);

    const second = reduceAll(ended.state, selectAndStart(), deps);
    expect(second.state.phase).toBe('playing');
    expect(second.state.sessions).toHaveLength(2);
    expect(second.state.activeSessionIndex).toBe(1);
  });

  it('refuses END_SESSION with nothing running', () => {
    const { deps } = harness();
    expectRejected(reduceRoom(newRoom(), { type: 'END_SESSION', actorId: HOST }, deps), 'NO_ACTIVE_SESSION');
  });

  it('finishes and aborts as terminal branches, then refuses everything else', () => {
    const { deps } = harness();
    const room = playingRoom(deps);
    const finished = reduceRoom(room, { type: 'FINISH_ROOM', actorId: HOST }, deps);
    expect(finished.state.phase).toBe('finished');
    expectRejected(reduceRoom(finished.state, { type: 'ADVANCE', actorId: HOST }, deps), 'ROOM_TERMINAL');

    const aborted = reduceRoom(room, { type: 'ABORT_ROOM', actorId: HOST, reason: 'HOST_ABORTED' }, deps);
    expect(aborted.state.phase).toBe('aborted');
    expect(aborted.state.abortReason).toBe('HOST_ABORTED');
    expectRejected(reduceRoom(aborted.state, join('p9', 'Zed'), deps), 'ROOM_TERMINAL');
    // TICK stays harmless on a dead room, so a stray timer cannot produce an error storm.
    expect(reduceRoom(aborted.state, { type: 'TICK' }, deps).rejection).toBeNull();
  });
});

describe('live events', () => {
  it('ignores match events for a module that does not observe them', () => {
    const { deps } = harness();
    const room = playingRoom(deps);
    const result = reduceRoom(room, { type: 'MATCH_EVENTS', events: [matchEvent('CORNER')] }, deps);
    expect(result.state).toBe(room);
    expect(result.rejection).toBeNull();
  });

  it('refuses match events outside a live round', () => {
    const { deps } = harness();
    expectRejected(reduceRoom(newRoom(), { type: 'MATCH_EVENTS', events: [] }, deps), 'WRONG_PHASE');
  });
});
