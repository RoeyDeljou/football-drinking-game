/**
 * The `GameModule` contract has to carry the whole catalog without the engine changing shape.
 * These tests implement the awkward cases from `docs/GAME_CATALOG.md` as throwaway modules and
 * drive them through the real reducer:
 *
 *  - M6 Match Bingo   → `private-card`, per-player private cards ticked by the live feed
 *  - M8 Stat Duel     → `pairing`, head-to-head inside one round
 *  - G8 Teammate Chain→ `turn-based`, one active player, elimination
 *
 * M1 Match Markets (`long-running-bet`) and M5 Event Roulette (a one-cell private card) are covered
 * by m1-match-markets.test.ts and by the private-card case respectively.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RoomAction } from '../actions.js';
import { EngineInvariantError } from '../errors.js';
import { asGameModuleId, asPlayerId, asRoundId } from '../ids.js';
import type { PerPlayer } from '../module.js';
import { defineGameModule } from '../module.js';
import { createModuleRegistry } from '../modules/registry.js';
import { penalty } from '../penalties.js';
import { reduceAll, reduceRoom } from '../reducer.js';
import { DEFAULT_SCORING, scoreAnswer } from '../scoring.js';
import type { RoomState } from '../state.js';
import { currentRound } from '../state.js';
import {
  HOST,
  makeHarness,
  matchEvent,
  newRoom,
  P2,
  P3,
  playerViews,
  sampleData,
  T0,
} from '../harness.test-utils.js';

const empty = z.object({}).strict();

/* ------------------------- M6-style private cards -------------------------- */

const bingoConfig = z.object({ cardSize: z.number().int().min(1).max(25) }).strict();
const bingoPublic = z.object({ eventTypes: z.array(z.string()) }).strict();
const bingoPrivate = z
  .object({ cells: z.array(z.object({ type: z.string(), ticked: z.boolean() }).strict()) })
  .strict();
const bingoSolution = z.object({ fullHouseFor: z.array(z.string()) }).strict();

interface BingoShape {
  readonly config: z.infer<typeof bingoConfig>;
  readonly publicPayload: z.infer<typeof bingoPublic>;
  readonly privatePayload: z.infer<typeof bingoPrivate>;
  readonly solution: z.infer<typeof bingoSolution>;
  readonly submission: z.infer<typeof empty>;
}

const BINGO_ID = asGameModuleId('M6_FAKE');
const EVENT_TYPES = ['CORNER', 'OFFSIDE', 'THROW_IN'];

const bingoModule = defineGameModule<BingoShape>({
  id: BINGO_ID,
  category: 'matchday',
  kind: 'private-card',
  dataRequirements: ['hasLiveEvents'],
  minPlayers: 1,
  maxPlayers: null,
  allowResubmission: false,
  defaultConfig: { cardSize: 2 },
  configSchema: bingoConfig,
  publicPayloadSchema: bingoPublic,
  privatePayloadSchema: bingoPrivate,
  solutionSchema: bingoSolution,
  submissionSchema: empty,
  generateRound: (ctx) => {
    const privatePayloads: Record<string, BingoShape['privatePayload']> = {};
    for (const [index, player] of ctx.players.entries()) {
      privatePayloads[player.id] = {
        cells: Array.from({ length: ctx.config.cardSize }, (_, cell) => ({
          type: EVENT_TYPES[(index + cell) % EVENT_TYPES.length] ?? 'CORNER',
          ticked: false,
        })),
      };
    }
    return {
      ok: true,
      round: {
        publicPayload: { eventTypes: EVENT_TYPES },
        privatePayloads: privatePayloads as PerPlayer<BingoShape['privatePayload']>,
        solution: { fullHouseFor: [] },
        contentKey: `bingo-${ctx.roundIndex}`,
        answerWindowMs: null,
        turnOrder: null,
      },
    };
  },
  validateSubmission: () => ({ ok: true, payload: {} }),
  observeEvents: (ctx) => {
    const seen = new Set(ctx.events.map((event) => String(event.type)));
    const next: Record<string, BingoShape['privatePayload']> = {};
    const fullHouseFor: string[] = [];
    for (const [playerId, card] of Object.entries(ctx.round.privatePayloads)) {
      if (card === undefined) continue;
      const cells = card.cells.map((cell) => ({
        type: cell.type,
        ticked: cell.ticked || seen.has(cell.type),
      }));
      next[playerId] = { cells };
      if (cells.every((cell) => cell.ticked)) fullHouseFor.push(playerId);
    }
    return {
      publicPayload: ctx.round.publicPayload,
      privatePayloads: next as PerPlayer<BingoShape['privatePayload']>,
      solution: { fullHouseFor },
      penalties: fullHouseFor.map((playerId) =>
        penalty(asPlayerId(playerId), 'others', 3, 'BINGO_FULL_HOUSE'),
      ),
      scoreDeltas: [],
      resolved: fullHouseFor.length > 0,
    };
  },
  scoreRound: (ctx) => ({
    scores: ctx.players.map((player) =>
      scoreAnswer({
        playerId: player.id,
        correct: ctx.round.solution.fullHouseFor.includes(player.id),
        elapsedMs: 0,
        windowMs: null,
        streakBefore: player.streak,
        config: ctx.scoring,
      }),
    ),
    winnerIds: ctx.round.solution.fullHouseFor.map((id) => asPlayerId(id)),
    penalties: [],
    summary: null,
  }),
  projectRound: (ctx) => ({
    publicPayload: ctx.round.publicPayload,
    privatePayload: ctx.viewerId === null ? null : (ctx.round.privatePayloads[ctx.viewerId] ?? null),
    solution: ctx.visibility === 'revealed' ? ctx.round.solution : null,
  }),
});

/* --------------------------- M8-style pairings ----------------------------- */

const duelPublic = z.object({ pairs: z.array(z.object({ a: z.string(), b: z.string() }).strict()) }).strict();
const duelSubmission = z.object({ value: z.number().int() }).strict();

interface DuelShape {
  readonly config: z.infer<typeof empty>;
  readonly publicPayload: z.infer<typeof duelPublic>;
  readonly privatePayload: null;
  readonly solution: z.infer<typeof empty>;
  readonly submission: z.infer<typeof duelSubmission>;
}

const DUEL_ID = asGameModuleId('M8_FAKE');

const duelModule = defineGameModule<DuelShape>({
  id: DUEL_ID,
  category: 'matchday',
  kind: 'pairing',
  dataRequirements: [],
  minPlayers: 2,
  maxPlayers: null,
  allowResubmission: false,
  defaultConfig: {},
  configSchema: empty,
  publicPayloadSchema: duelPublic,
  privatePayloadSchema: z.null(),
  solutionSchema: empty,
  submissionSchema: duelSubmission,
  generateRound: (ctx) => {
    const pairs: { a: string; b: string }[] = [];
    for (let index = 0; index + 1 < ctx.players.length; index += 2) {
      const a = ctx.players[index];
      const b = ctx.players[index + 1];
      if (a !== undefined && b !== undefined) pairs.push({ a: a.id, b: b.id });
    }
    return {
      ok: true,
      round: {
        publicPayload: { pairs },
        privatePayloads: {},
        solution: {},
        contentKey: `duel-${ctx.roundIndex}`,
        answerWindowMs: ctx.defaultAnswerWindowMs,
        turnOrder: null,
      },
    };
  },
  validateSubmission: (ctx) => {
    const parsed = duelSubmission.safeParse(ctx.raw);
    return parsed.success ? { ok: true, payload: parsed.data } : { ok: false, code: 'SCHEMA', detail: null };
  },
  scoreRound: (ctx) => {
    const valueOf = (playerId: string): number =>
      ctx.submissions.find((entry) => entry.playerId === playerId)?.payload.value ?? -1;
    const winners: string[] = [];
    const penalties = [];
    for (const pair of ctx.round.publicPayload.pairs) {
      const [winner, loser] = valueOf(pair.a) >= valueOf(pair.b) ? [pair.a, pair.b] : [pair.b, pair.a];
      winners.push(winner);
      penalties.push(penalty(asPlayerId(loser), 'self', 2, 'DUEL_LOST', { opponent: winner }));
    }
    return {
      scores: winners.map((playerId) =>
        scoreAnswer({
          playerId: asPlayerId(playerId),
          correct: true,
          elapsedMs: 0,
          windowMs: null,
          streakBefore: 0,
          config: ctx.scoring,
        }),
      ),
      winnerIds: winners.map((id) => asPlayerId(id)),
      penalties,
      summary: null,
    };
  },
  projectRound: (ctx) => ({
    publicPayload: ctx.round.publicPayload,
    privatePayload: null,
    solution: ctx.visibility === 'revealed' ? ctx.round.solution : null,
  }),
});

/* --------------------------- G8-style turn order --------------------------- */

const chainSubmission = z.object({ name: z.string().min(1) }).strict();

interface ChainShape {
  readonly config: z.infer<typeof empty>;
  readonly publicPayload: z.infer<typeof empty>;
  readonly privatePayload: null;
  readonly solution: z.infer<typeof empty>;
  readonly submission: z.infer<typeof chainSubmission>;
}

const CHAIN_ID = asGameModuleId('G8_FAKE');

const chainModule = defineGameModule<ChainShape>({
  id: CHAIN_ID,
  category: 'general',
  kind: 'turn-based',
  dataRequirements: [],
  minPlayers: 2,
  maxPlayers: null,
  allowResubmission: true,
  defaultConfig: {},
  configSchema: empty,
  publicPayloadSchema: empty,
  privatePayloadSchema: z.null(),
  solutionSchema: empty,
  submissionSchema: chainSubmission,
  generateRound: (ctx) => ({
    ok: true,
    round: {
      publicPayload: {},
      privatePayloads: {},
      solution: {},
      contentKey: `chain-${ctx.roundIndex}`,
      answerWindowMs: null,
      turnOrder: ctx.players.map((player) => player.id),
    },
  }),
  validateSubmission: (ctx) => {
    const parsed = chainSubmission.safeParse(ctx.raw);
    return parsed.success ? { ok: true, payload: parsed.data } : { ok: false, code: 'SCHEMA', detail: null };
  },
  afterSubmission: (ctx) => ({
    lockRound: false,
    eliminate: ctx.payload.name === 'pass' ? [ctx.playerId] : [],
  }),
  scoreRound: (ctx) => {
    const eliminated = ctx.round.turn?.eliminated ?? [];
    return {
      scores: ctx.players.map((player) =>
        scoreAnswer({
          playerId: player.id,
          correct: !eliminated.includes(player.id),
          elapsedMs: 0,
          windowMs: null,
          streakBefore: player.streak,
          config: ctx.scoring,
        }),
      ),
      winnerIds: ctx.players.filter((player) => !eliminated.includes(player.id)).map((player) => player.id),
      penalties: eliminated.map((playerId) => penalty(playerId, 'self', 3, 'CHAIN_BROKEN')),
      summary: null,
    };
  },
  projectRound: (ctx) => ({
    publicPayload: ctx.round.publicPayload,
    privatePayload: null,
    solution: ctx.visibility === 'revealed' ? ctx.round.solution : null,
  }),
});

/* ---------------------------------- tests ---------------------------------- */

const registry = createModuleRegistry([bingoModule, duelModule, chainModule]);

const start = (moduleId: typeof BINGO_ID, players = [P2, P3]) => {
  const harness = makeHarness({ modules: registry, data: sampleData() });
  const actions: readonly RoomAction[] = [
    ...players.map((playerId): RoomAction => ({
      type: 'PLAYER_JOIN',
      playerId,
      nickname: String(playerId),
      isGuest: true,
    })),
    { type: 'SELECT_GAME', actorId: HOST, moduleId, config: null },
    { type: 'START_SESSION', actorId: HOST },
  ];
  const result = reduceAll(newRoom(), actions, harness.deps);
  expect(result.rejection).toBeNull();
  return { ...harness, room: result.state };
};

describe('private-card games (M5, M6, M4)', () => {
  it('deals a private card per player and keeps it out of everyone else’s state', () => {
    const { room } = start(BINGO_ID);
    const round = currentRound(room);
    expect(Object.keys(round?.privatePayloads ?? {}).sort()).toEqual([HOST, P2, P3].sort());
    expect(round?.deadlineAt).toBeNull();
  });

  it('is not ended by a clock tick, because it has no answer window', () => {
    const { room, deps, clock } = start(BINGO_ID);
    clock.advance(600_000);
    expect(reduceRoom(room, { type: 'TICK' }, deps).state).toBe(room);
  });

  it('ticks cards from the live feed and resolves on a full house', () => {
    const { room, deps } = start(BINGO_ID);
    const partial = reduceRoom(room, { type: 'MATCH_EVENTS', events: [matchEvent('CORNER')] }, deps);
    expect(partial.state.phase).toBe('playing');
    expect(partial.events.map((event) => event.type)).toContain('ROUND_UPDATED');

    const full = reduceRoom(
      partial.state,
      { type: 'MATCH_EVENTS', events: [matchEvent('OFFSIDE'), matchEvent('THROW_IN')] },
      deps,
    );
    expect(full.state.phase).toBe('roundReveal');
    expect(full.state.penalties.some((entry) => entry.reason === 'BINGO_FULL_HOUSE')).toBe(true);
    // A full house is an `others` penalty: nobody ever drinks for their own full house.
    expect(
      full.state.penalties.some(
        (entry) => entry.reason === 'BINGO_FULL_HOUSE' && entry.recipientId === entry.playerId,
      ),
    ).toBe(false);
  });

  it('ignores a replayed match event, so polling twice cannot double-charge', () => {
    const { room, deps } = start(BINGO_ID);
    const event = matchEvent('CORNER', { id: 'fixed-1' });
    const once = reduceRoom(room, { type: 'MATCH_EVENTS', events: [event] }, deps);
    const twice = reduceRoom(once.state, { type: 'MATCH_EVENTS', events: [event] }, deps);
    expect(twice.state).toBe(once.state);
    expect(twice.rejection).toBeNull();
  });

  it('reports a real rejection — never a false rejection:null success — once the round is manually locked', () => {
    // Unlike M1 (long-running-bet), a private-card round has a legitimate reason for a host to lock it
    // early, so LOCK_ROUND is allowed here. But a MATCH_EVENTS batch arriving after that lock must not
    // be silently swallowed: the caller needs a real rejection to see and log a dropped batch.
    const { room, deps } = start(BINGO_ID);
    const locked = reduceRoom(room, { type: 'LOCK_ROUND', actorId: HOST }, deps);
    expect(locked.rejection).toBeNull();
    expect(currentRound(locked.state)?.status).toBe('locked');

    const dropped = reduceRoom(locked.state, { type: 'MATCH_EVENTS', events: [matchEvent('CORNER')] }, deps);
    expect(dropped.rejection).toEqual({ code: 'ROUND_CLOSED', detail: 'locked', submissionCode: null });
    expect(dropped.state).toBe(locked.state);
  });
});

describe('pairing games (M8)', () => {
  it('pairs players inside one round and drinks the loser of each duel', () => {
    const { room, deps } = start(DUEL_ID, [P2]);
    const round = currentRound(room);
    expect(round?.kind).toBe('pairing');
    expect(round?.publicPayload).toEqual({ pairs: [{ a: HOST, b: P2 }] });

    const played = reduceAll(
      room,
      [
        {
          type: 'SUBMIT_ANSWER',
          playerId: HOST,
          roundId: round?.id ?? asRoundId('x'),
          payload: { value: 9 },
        },
        { type: 'SUBMIT_ANSWER', playerId: P2, roundId: round?.id ?? asRoundId('x'), payload: { value: 4 } },
        { type: 'SYSTEM_LOCK_ROUND' },
        { type: 'REVEAL_ROUND', actorId: HOST },
      ],
      deps,
    );
    expect(played.state.phase).toBe('roundReveal');
    const loss = played.state.penalties.find((entry) => entry.reason === 'DUEL_LOST');
    expect(loss?.recipientId).toBe(P2);
    expect(currentRound(played.state)?.outcome?.winnerIds).toEqual([HOST]);
  });

  it('ends a pairing round when its deadline passes', () => {
    const { room, deps, clock } = start(DUEL_ID, [P2]);
    clock.advance(20_000);
    expect(reduceRoom(room, { type: 'TICK' }, deps).state.phase).toBe('roundReveal');
  });
});

describe('turn-based games (G8)', () => {
  const roundId = (room: RoomState) => currentRound(room)?.id ?? asRoundId('x');

  it('only accepts an answer from the active player', () => {
    const { room, deps } = start(CHAIN_ID);
    expect(currentRound(room)?.turn).toEqual({ order: [HOST, P2, P3], activeIndex: 0, eliminated: [] });
    const outOfTurn = reduceRoom(
      room,
      { type: 'SUBMIT_ANSWER', playerId: P2, roundId: roundId(room), payload: { name: 'Pirlo' } },
      deps,
    );
    expect(outOfTurn.rejection?.code).toBe('NOT_YOUR_TURN');
  });

  it('rotates the turn after each accepted answer', () => {
    const { room, deps } = start(CHAIN_ID);
    const result = reduceRoom(
      room,
      { type: 'SUBMIT_ANSWER', playerId: HOST, roundId: roundId(room), payload: { name: 'Pirlo' } },
      deps,
    );
    expect(currentRound(result.state)?.turn?.activeIndex).toBe(1);
    expect(result.events).toContainEqual({ type: 'TURN_CHANGED', roundId: roundId(room), playerId: P2 });
  });

  it('eliminates a player who fails, skips their turn, and ends the round on the last survivor', () => {
    const { room, deps } = start(CHAIN_ID);
    const first = reduceRoom(
      room,
      { type: 'SUBMIT_ANSWER', playerId: HOST, roundId: roundId(room), payload: { name: 'pass' } },
      deps,
    );
    expect(currentRound(first.state)?.turn?.eliminated).toEqual([HOST]);
    expect(currentRound(first.state)?.turn?.activeIndex).toBe(1);

    const eliminatedAgain = reduceRoom(
      first.state,
      { type: 'SUBMIT_ANSWER', playerId: HOST, roundId: roundId(room), payload: { name: 'Kaka' } },
      deps,
    );
    expect(eliminatedAgain.rejection?.code).toBe('PLAYER_ELIMINATED');

    const second = reduceRoom(
      first.state,
      { type: 'SUBMIT_ANSWER', playerId: P2, roundId: roundId(room), payload: { name: 'pass' } },
      deps,
    );
    expect(second.state.phase).toBe('roundReveal');
    expect(currentRound(second.state)?.outcome?.winnerIds).toEqual([P3]);
    expect(second.state.players.find((player) => player.id === HOST)?.sips).toBe(3);
  });
});

describe('N6: turn-based rounds never stall on an absent player', () => {
  const roundId = (room: RoomState) => currentRound(room)?.id ?? asRoundId('x');
  const P4 = asPlayerId('p4');

  it('passes the turn on when the active player disconnects', () => {
    const { room, deps } = start(CHAIN_ID);
    const result = reduceRoom(room, { type: 'PLAYER_DISCONNECTED', playerId: HOST }, deps);
    expect(currentRound(result.state)?.turn?.activeIndex).toBe(1);
    expect(result.events).toContainEqual({ type: 'TURN_CHANGED', roundId: roundId(room), playerId: P2 });
    const next = reduceRoom(
      result.state,
      { type: 'SUBMIT_ANSWER', playerId: P2, roundId: roundId(room), payload: { name: 'Nesta' } },
      deps,
    );
    expect(next.rejection).toBeNull();
  });

  it('passes the turn on when the active player leaves or is kicked', () => {
    const left = start(CHAIN_ID);
    const afterSubmit = reduceRoom(
      left.room,
      { type: 'SUBMIT_ANSWER', playerId: HOST, roundId: roundId(left.room), payload: { name: 'Pirlo' } },
      left.deps,
    ).state;
    const leave = reduceRoom(afterSubmit, { type: 'PLAYER_LEAVE', playerId: P2 }, left.deps);
    expect(currentRound(leave.state)?.turn?.activeIndex).toBe(2);

    const kicked = start(CHAIN_ID);
    const kick = reduceRoom(
      kicked.room,
      { type: 'KICK_PLAYER', actorId: HOST, targetPlayerId: P2 },
      kicked.deps,
    );
    // P2 was not active, so the turn stays with the host…
    expect(currentRound(kick.state)?.turn?.activeIndex).toBe(0);
    // …and is skipped when it would have come round to them.
    const skip = reduceRoom(
      kick.state,
      { type: 'SUBMIT_ANSWER', playerId: HOST, roundId: roundId(kicked.room), payload: { name: 'Pirlo' } },
      kicked.deps,
    );
    expect(currentRound(skip.state)?.turn?.activeIndex).toBe(2);
    expect(skip.events).toContainEqual({ type: 'TURN_CHANGED', roundId: roundId(kicked.room), playerId: P3 });
  });

  it('leaves the turn alone when a non-active player disconnects or reconnects', () => {
    const { room, deps } = start(CHAIN_ID);
    const away = reduceRoom(room, { type: 'PLAYER_DISCONNECTED', playerId: P3 }, deps);
    expect(currentRound(away.state)?.turn?.activeIndex).toBe(0);
    expect(away.events.some((event) => event.type === 'TURN_CHANGED')).toBe(false);
    const back = reduceRoom(away.state, { type: 'PLAYER_RECONNECTED', playerId: P3 }, deps);
    expect(currentRound(back.state)?.turn?.activeIndex).toBe(0);
  });

  it('ends the round when nobody who can take a turn remains', () => {
    const { room, deps } = start(CHAIN_ID, [P2, P3, P4]);
    const result = reduceAll(
      room,
      [
        { type: 'PLAYER_DISCONNECTED', playerId: P2 },
        { type: 'PLAYER_DISCONNECTED', playerId: P3 },
        { type: 'PLAYER_DISCONNECTED', playerId: P4 },
        { type: 'PLAYER_DISCONNECTED', playerId: HOST },
      ],
      deps,
    );
    expect(result.rejection).toBeNull();
    expect(result.state.phase).toBe('roundReveal');
    expect(currentRound(result.state)?.status).toBe('resolved');
  });
});

describe('module erasure', () => {
  it('validates config at the boundary and reports readable issues', () => {
    expect(bingoModule.parseConfig({ cardSize: 3 })).toEqual({ ok: true, config: { cardSize: 3 } });
    const bad = bingoModule.parseConfig({ cardSize: 99 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]).toContain('cardSize');
  });

  it('refuses to score a round that belongs to another game', () => {
    expect(() =>
      duelModule.scoreRound({
        config: {},
        round: {
          id: asRoundId('r1'),
          index: 0,
          startedAt: T0,
          answerWindowMs: null,
          deadlineAt: null,
          publicPayload: { eventTypes: ['CORNER'] },
          privatePayloads: {},
          solution: {},
          turn: null,
        },
        submissions: [],
        players: playerViews([HOST]),
        scoring: DEFAULT_SCORING,
        now: T0,
      }),
    ).toThrow(EngineInvariantError);
  });

  it('reports whether a module observes live events at all', () => {
    expect(bingoModule.supportsLiveEvents).toBe(true);
    expect(chainModule.supportsLiveEvents).toBe(false);
    expect(
      chainModule.observeEvents({
        config: {},
        round: {
          id: asRoundId('r1'),
          index: 0,
          startedAt: T0,
          answerWindowMs: null,
          deadlineAt: null,
          publicPayload: {},
          privatePayloads: {},
          solution: {},
          turn: null,
        },
        events: [],
        submissions: [],
        players: [],
        now: T0,
      }),
    ).toBeNull();
  });

  it('refuses a registry with two modules sharing an id', () => {
    expect(() => createModuleRegistry([bingoModule, bingoModule])).toThrow(EngineInvariantError);
  });
});
