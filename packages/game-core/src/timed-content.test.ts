/**
 * Time-driven projection content (G1's clue ladder, and any future module whose `projectRound` reads
 * `ctx.now`) must reach clients without an unrelated action to trigger a broadcast.
 *
 * The transport rebroadcasts only when a dispatch returns a *different* state object (see
 * apps/api/src/engine/dispatch.ts). Before this fix `TICK` returned the identical state until the
 * answer deadline, so clues unlocked in `projectRound` were never pushed: players saw clue 1 until
 * somebody submitted. These tests model that exact rule — `changed = next !== previous` — and assert:
 *
 *  - no stale view: whenever a TICK leaves the state untouched, every viewer's projection is
 *    byte-identical to the last broadcast one;
 *  - no spam: the state only changes at content boundaries (and the deadline), never per tick;
 *  - no gameplay drift: ticking changes nothing about scoring, penalties, standings or RNG.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RoomAction } from './actions.js';
import { EngineInvariantError } from './errors.js';
import type { GameModuleId, PlayerId } from './ids.js';
import { asGameModuleId } from './ids.js';
import type { RoundKind } from './module.js';
import { defineGameModule } from './module.js';
import { G1_DEFAULT_CONFIG, G1_ID, nextClueUnlockAt, visibleClueCount } from './modules/g1-guess-the-player.js';
import { G3_ID } from './modules/g3-career-path.js';
import { G_MIX_ID, M_MIX_ID } from './modules/mixed.js';
import { createModuleRegistry, PHASE_1_MODULES } from './modules/registry.js';
import { projectFor, projectForHostScreen } from './projection.js';
import type { EngineDeps } from './reducer.js';
import { reduceAll, reduceRoom } from './reducer.js';
import type { RoomState } from './state.js';
import { currentRound } from './state.js';
import type { Harness } from './harness.test-utils.js';
import { HOST, makeHarness, newRoom, P2, P3, T0 } from './harness.test-utils.js';

const INTERVAL = G1_DEFAULT_CONFIG.clueIntervalMs;
const WINDOW = G1_DEFAULT_CONFIG.answerWindowMs;

const start = (moduleId: GameModuleId, harness: Harness = makeHarness(), seed = 7): RoomState => {
  const actions: readonly RoomAction[] = [
    { type: 'PLAYER_JOIN', playerId: P2, nickname: 'Bea', isGuest: true },
    { type: 'PLAYER_JOIN', playerId: P3, nickname: 'Cal', isGuest: true },
    { type: 'SELECT_GAME', actorId: HOST, moduleId, config: null },
    { type: 'START_SESSION', actorId: HOST },
  ];
  const result = reduceAll(newRoom(T0, seed), actions, harness.deps);
  expect(result.rejection).toBeNull();
  expect(result.state.phase).toBe('playing');
  return result.state;
};

const tick = (room: RoomState, deps: EngineDeps) => reduceRoom(room, { type: 'TICK' }, deps);

/** Everything the transport would send: each player's projection plus the shared screen. */
const broadcastSnapshot = (room: RoomState, deps: EngineDeps): string =>
  JSON.stringify([
    ...[HOST, P2, P3].map((viewer: PlayerId) => projectFor(room, viewer, deps)),
    projectForHostScreen(room, deps),
  ]);

const visibleClues = (room: RoomState, deps: EngineDeps): number =>
  (projectFor(room, HOST, deps).round?.publicPayload as { clues: readonly unknown[] }).clues.length;

const storedClueCount = (room: RoomState): number =>
  (currentRound(room)?.publicPayload as { clues: readonly unknown[] }).clues.length;

/**
 * Drive a 1 s tick loop exactly like the gateway does, applying its broadcast rule, and assert that
 * no viewer is ever left looking at a stale projection. Returns how many broadcasts it took.
 */
const runTickLoop = (
  room: RoomState,
  harness: Harness,
  durationMs: number,
  stepMs = 1_000,
): { readonly state: RoomState; readonly broadcasts: number; readonly broadcastAt: readonly number[] } => {
  const { deps, clock } = harness;
  let state = room;
  let lastBroadcast = broadcastSnapshot(state, deps);
  const broadcastAt: number[] = [];
  for (let elapsed = stepMs; elapsed <= durationMs; elapsed += stepMs) {
    clock.advance(stepMs);
    const result = tick(state, deps);
    expect(result.rejection).toBeNull();
    const changed = result.state !== state;
    state = result.state;
    const current = broadcastSnapshot(state, deps);
    if (changed) {
      broadcastAt.push(clock.now() - T0);
      lastBroadcast = current;
    } else {
      // The heart of the bug: an unchanged TICK must mean nobody's view has moved on.
      expect(current).toBe(lastBroadcast);
    }
  }
  return { state, broadcasts: broadcastAt.length, broadcastAt };
};

/* ------------------------------ G1: the unit ------------------------------ */

describe('nextClueUnlockAt (G1)', () => {
  it('points at the next interval boundary while clues remain', () => {
    expect(nextClueUnlockAt(T0, T0, 8_000, 5)).toBe(T0 + 8_000);
    expect(nextClueUnlockAt(T0 + 7_999, T0, 8_000, 5)).toBe(T0 + 8_000);
    expect(nextClueUnlockAt(T0 + 8_000, T0, 8_000, 5)).toBe(T0 + 16_000);
    expect(nextClueUnlockAt(T0 + 31_999, T0, 8_000, 5)).toBe(T0 + 32_000);
  });

  it('is null once every clue is visible, and for a single-clue round', () => {
    expect(nextClueUnlockAt(T0 + 32_000, T0, 8_000, 5)).toBeNull();
    expect(nextClueUnlockAt(T0 + 999_999, T0, 8_000, 5)).toBeNull();
    expect(nextClueUnlockAt(T0, T0, 8_000, 1)).toBeNull();
    expect(nextClueUnlockAt(T0, T0, 8_000, 0)).toBeNull();
  });

  it('skips straight to the next future boundary after a gap', () => {
    expect(nextClueUnlockAt(T0 + 17_500, T0, 8_000, 5)).toBe(T0 + 24_000);
  });

  it('agrees with visibleClueCount: the count rises exactly at the returned instant', () => {
    for (let now = T0; now < T0 + 40_000; now += 500) {
      const next = nextClueUnlockAt(now, T0, 8_000, 5);
      if (next === null) {
        expect(visibleClueCount(now - T0, 8_000, 5)).toBe(5);
        continue;
      }
      expect(next).toBeGreaterThan(now);
      expect(visibleClueCount(next - 1 - T0, 8_000, 5)).toBe(visibleClueCount(now - T0, 8_000, 5));
      expect(visibleClueCount(next - T0, 8_000, 5)).toBe(visibleClueCount(now - T0, 8_000, 5) + 1);
    }
  });

  it('declares timed content on the erased module for G1, G3 and the Mixed rotations (which delegate) only', () => {
    const timed = new Set<GameModuleId>([G1_ID, G3_ID, G_MIX_ID, M_MIX_ID]);
    for (const module of PHASE_1_MODULES) {
      expect(module.hasTimedContent).toBe(timed.has(module.id));
    }
  });
});

/* ---------------------------- G1: reducer level ---------------------------- */

describe('G1 clue unlocks through TICK', () => {
  it('schedules the first unlock when the round starts', () => {
    const room = start(G1_ID);
    expect(storedClueCount(room)).toBeGreaterThan(1);
    expect(currentRound(room)?.contentChangeAt).toBe(T0 + INTERVAL);
  });

  it('leaves the state identical on every TICK before the first clue boundary', () => {
    const harness = makeHarness();
    const room = start(G1_ID, harness);
    for (const at of [1, 1_000, 4_000, INTERVAL - 1]) {
      harness.clock.set(T0 + at);
      const result = tick(room, harness.deps);
      expect(result.state).toBe(room);
      expect(result.events).toEqual([]);
      expect(visibleClues(room, harness.deps)).toBe(1);
    }
  });

  it('commits a new state with ROUND_UPDATED exactly at the clue boundary', () => {
    const harness = makeHarness();
    const room = start(G1_ID, harness);
    harness.clock.set(T0 + INTERVAL);
    const result = tick(room, harness.deps);

    expect(result.rejection).toBeNull();
    expect(result.state).not.toBe(room);
    expect(result.state.version).toBe(room.version + 1);
    expect(result.state.phase).toBe('playing');
    expect(result.events).toEqual([{ type: 'ROUND_UPDATED', roundId: currentRound(room)?.id }]);
    expect(currentRound(result.state)?.contentChangeAt).toBe(T0 + 2 * INTERVAL);
    expect(visibleClues(result.state, harness.deps)).toBe(2);

    // And the very next tick inside the same clue window is quiet again.
    harness.clock.set(T0 + INTERVAL + 1_000);
    expect(tick(result.state, harness.deps).state).toBe(result.state);
  });

  it('collapses several missed boundaries into a single commit', () => {
    const harness = makeHarness();
    const room = start(G1_ID, harness);
    harness.clock.set(T0 + 2 * INTERVAL + 1_500);
    const result = tick(room, harness.deps);
    expect(result.state.version).toBe(room.version + 1);
    expect(currentRound(result.state)?.contentChangeAt).toBe(T0 + 3 * INTERVAL);
    expect(visibleClues(result.state, harness.deps)).toBe(Math.min(3, storedClueCount(room)));
  });

  it('broadcasts once per unlocked clue plus the reveal, and never leaves a viewer stale', () => {
    const harness = makeHarness();
    const room = start(G1_ID, harness);
    const clues = storedClueCount(room);
    const unlocksBeforeDeadline = Array.from({ length: clues - 1 }, (_, i) => (i + 1) * INTERVAL).filter(
      (at) => at < WINDOW,
    );

    const { state, broadcasts, broadcastAt } = runTickLoop(room, harness, WINDOW + 5_000);

    expect(broadcastAt).toEqual([...unlocksBeforeDeadline, WINDOW]);
    expect(broadcasts).toBe(unlocksBeforeDeadline.length + 1);
    expect(state.phase).toBe('roundReveal');
    // Far fewer broadcasts than ticks: this is not a rebroadcast-every-second fix.
    expect(broadcasts).toBeLessThan((WINDOW + 5_000) / 1_000 / 4);
  });

  it('stops scheduling once every clue is out, and the deadline still reveals', () => {
    const harness = makeHarness();
    let room = start(G1_ID, harness);
    const clues = storedClueCount(room);
    harness.clock.set(T0 + (clues - 1) * INTERVAL);
    room = tick(room, harness.deps).state;
    expect(currentRound(room)?.contentChangeAt).toBeNull();
    expect(visibleClues(room, harness.deps)).toBe(clues);

    harness.clock.set(T0 + WINDOW - 1);
    expect(tick(room, harness.deps).state).toBe(room);

    harness.clock.set(T0 + WINDOW);
    const revealed = tick(room, harness.deps);
    expect(revealed.state.phase).toBe('roundReveal');
    expect(revealed.events.map((event) => event.type)).toContain('ROUND_REVEALED');
    expect(revealed.events.map((event) => event.type)).not.toContain('ROUND_UPDATED');
  });

  it('prefers the reveal when a clue boundary and the deadline are crossed by the same TICK', () => {
    const harness = makeHarness();
    const room = start(G1_ID, harness);
    expect(currentRound(room)?.contentChangeAt).not.toBeNull();
    harness.clock.set(T0 + WINDOW + 60_000);
    const result = tick(room, harness.deps);
    expect(result.state.phase).toBe('roundReveal');
    expect(result.events.map((event) => event.type)).not.toContain('ROUND_UPDATED');
  });

  it('does nothing once the round is no longer open', () => {
    const harness = makeHarness();
    const revealed = reduceRoom(start(G1_ID, harness), { type: 'REVEAL_ROUND', actorId: HOST }, harness.deps).state;
    harness.clock.set(T0 + INTERVAL);
    expect(tick(revealed, harness.deps).state).toBe(revealed);
  });

  it('keeps unlocking for rounds after the first', () => {
    const harness = makeHarness();
    let room = reduceRoom(start(G1_ID, harness), { type: 'REVEAL_ROUND', actorId: HOST }, harness.deps).state;
    harness.clock.advance(3_000);
    room = reduceRoom(room, { type: 'ADVANCE', actorId: HOST }, harness.deps).state;
    room = reduceRoom(room, { type: 'ADVANCE', actorId: HOST }, harness.deps).state;
    expect(room.phase).toBe('playing');
    const startedAt = currentRound(room)?.startedAt ?? 0;
    expect(currentRound(room)?.index).toBe(1);
    expect(currentRound(room)?.contentChangeAt).toBe(startedAt + INTERVAL);

    harness.clock.set(startedAt + INTERVAL);
    const next = tick(room, harness.deps);
    expect(next.state).not.toBe(room);
    expect(visibleClues(next.state, harness.deps)).toBe(2);
  });
});

/* ------------------- every registered module: no stale views ------------------- */

describe('TICK never leaves any Phase-1 module showing a stale projection', () => {
  for (const module of PHASE_1_MODULES) {
    it(`${module.id}: an unchanged TICK means an unchanged broadcast`, () => {
      const harness = makeHarness();
      const room = start(module.id, harness);
      const { broadcasts } = runTickLoop(room, harness, 90_000);
      // A Mixed module declares the hook but only schedules when this round's sub-game is timed.
      if (currentRound(room)?.contentChangeAt !== null) {
        expect(module.hasTimedContent).toBe(true);
        expect(broadcasts).toBeGreaterThan(1);
      } else {
        // Untimed modules only ever change on a tick at their deadline (or never, without one).
        expect(broadcasts).toBeLessThanOrEqual(1);
      }
    });
  }
});

/* ------------- the mechanism is generic: a second, non-G1 timed module ------------- */

const stagedConfigSchema = z
  .object({ unlockOffsetsMs: z.array(z.number().int().min(1)), answerWindowMs: z.number().int().nullable() })
  .strict();
const stagedPublicSchema = z.object({ steps: z.array(z.string()) }).strict();
const stagedAnswerSchema = z.object({ value: z.number().int() }).strict();

interface StagedShape {
  readonly config: z.infer<typeof stagedConfigSchema>;
  readonly publicPayload: z.infer<typeof stagedPublicSchema>;
  readonly privatePayload: null;
  readonly solution: z.infer<typeof stagedAnswerSchema>;
  readonly submission: z.infer<typeof stagedAnswerSchema>;
}

/** Irregular reveal schedule (not a fixed interval), so nothing here leans on G1's arithmetic. */
const stagedModule = (
  id: string,
  kind: RoundKind,
  config: StagedShape['config'],
  schedule?: (now: number, startedAt: number, offsets: readonly number[]) => number | null,
) =>
  defineGameModule<StagedShape>({
    id: asGameModuleId(id),
    category: 'general',
    kind,
    dataRequirements: [],
    minPlayers: 1,
    maxPlayers: null,
    allowResubmission: false,
    defaultConfig: config,
    configSchema: stagedConfigSchema,
    publicPayloadSchema: stagedPublicSchema,
    privatePayloadSchema: z.null(),
    solutionSchema: stagedAnswerSchema,
    submissionSchema: stagedAnswerSchema,
    generateRound: (ctx) => ({
      ok: true,
      round: {
        publicPayload: { steps: ['a', ...ctx.config.unlockOffsetsMs.map((_, i) => `s${i}`)] },
        privatePayloads: {},
        solution: { value: 1 },
        contentKey: `k${ctx.roundIndex}`,
        answerWindowMs: ctx.config.answerWindowMs,
        turnOrder: null,
      },
    }),
    validateSubmission: (ctx) => {
      const parsed = stagedAnswerSchema.safeParse(ctx.raw);
      return parsed.success ? { ok: true, payload: parsed.data } : { ok: false, code: 'SCHEMA', detail: null };
    },
    scoreRound: () => ({ scores: [], winnerIds: [], penalties: [], summary: null }),
    projectRound: (ctx) => {
      const elapsed = ctx.now - ctx.round.startedAt;
      const shown = 1 + ctx.config.unlockOffsetsMs.filter((offset) => offset <= elapsed).length;
      return {
        publicPayload: { steps: ctx.round.publicPayload.steps.slice(0, shown) },
        privatePayload: null,
        solution: ctx.visibility === 'revealed' ? ctx.round.solution : null,
      };
    },
    ...(schedule === undefined
      ? {}
      : {
          nextContentChangeAt: (ctx) => schedule(ctx.now, ctx.round.startedAt, ctx.config.unlockOffsetsMs),
        }),
  });

const nextOffset = (now: number, startedAt: number, offsets: readonly number[]): number | null => {
  const upcoming = offsets.map((offset) => startedAt + offset).filter((at) => at > now);
  return upcoming.length === 0 ? null : Math.min(...upcoming);
};

describe('timed content is a module capability, not a G1 special case', () => {
  it('rebroadcasts an irregular simultaneous-answer schedule exactly at its own instants', () => {
    const staged = stagedModule('STAGED', 'simultaneous-answer', {
      unlockOffsetsMs: [2_000, 7_000, 7_500, 19_000],
      answerWindowMs: 30_000,
    }, nextOffset);
    const harness = makeHarness({ modules: createModuleRegistry([staged]) });
    const room = start(staged.id, harness);
    expect(currentRound(room)?.contentChangeAt).toBe(T0 + 2_000);

    // 500 ms ticks so the two unlocks 500 ms apart are distinguishable.
    const { state, broadcastAt } = runTickLoop(room, harness, 32_000, 500);
    expect(broadcastAt).toEqual([2_000, 7_000, 7_500, 19_000, 30_000]);
    expect(state.phase).toBe('roundReveal');
  });

  it('keeps working for a round kind the deadline does not end, and for rounds with no deadline', () => {
    const noDeadline = stagedModule('STAGED_BET', 'long-running-bet', {
      unlockOffsetsMs: [5_000, 60_000],
      answerWindowMs: null,
    }, nextOffset);
    const harness = makeHarness({ modules: createModuleRegistry([noDeadline]) });
    const { state, broadcastAt } = runTickLoop(start(noDeadline.id, harness), harness, 90_000);
    expect(broadcastAt).toEqual([5_000, 60_000]);
    expect(state.phase).toBe('playing');
    expect(currentRound(state)?.contentChangeAt).toBeNull();
  });

  it('never schedules anything for a module that declares no timed content', () => {
    const untimed = stagedModule('UNTIMED', 'simultaneous-answer', { unlockOffsetsMs: [], answerWindowMs: 10_000 });
    expect(untimed.hasTimedContent).toBe(false);
    expect(untimed.nextContentChangeAt({ config: untimed.defaultConfig, round: {} as never, now: T0 })).toBeNull();
    const harness = makeHarness({ modules: createModuleRegistry([untimed]) });
    const room = start(untimed.id, harness);
    expect(currentRound(room)?.contentChangeAt).toBeNull();
    const { broadcastAt } = runTickLoop(room, harness, 12_000);
    expect(broadcastAt).toEqual([10_000]);
  });

  it('rejects a schedule that is not strictly in the future (it would mean a broadcast every tick)', () => {
    const config = { unlockOffsetsMs: [1_000], answerWindowMs: 10_000 };
    for (const bad of [(now: number) => now, (now: number) => now - 1, () => Number.NaN, () => Infinity]) {
      const broken = stagedModule('BROKEN', 'simultaneous-answer', config, bad);
      const harness = makeHarness({ modules: createModuleRegistry([broken]) });
      expect(() => start(broken.id, harness)).toThrow(EngineInvariantError);
    }
  });
});

/* ------------------ regression: ticking never changes the game ------------------ */

/**
 * The same G1 round played twice with identical submissions at identical times — once with nobody
 * ticking, once with the gateway's 1 s tick loop running throughout — must score identically.
 */
const playG1Round = (withTicks: boolean, seed: number): RoomState => {
  const harness = makeHarness();
  let room = start(G1_ID, harness, seed);
  const options = (currentRound(room)?.publicPayload as { options: { playerId: string }[] }).options;
  const solution = (currentRound(room)?.solution as { playerId: string }).playerId;
  const wrong = options.find((option) => option.playerId !== solution)?.playerId ?? solution;
  const plan: readonly { at: number; playerId: PlayerId; pick: string }[] = [
    { at: 3_000, playerId: HOST, pick: solution }, // clue 1
    { at: 17_000, playerId: P2, pick: solution }, // clue 3
    { at: 26_000, playerId: P3, pick: wrong }, // clue 4
  ];

  let elapsed = 0;
  const advanceTo = (target: number): void => {
    while (elapsed < target) {
      const step = withTicks ? Math.min(1_000, target - elapsed) : target - elapsed;
      harness.clock.advance(step);
      elapsed += step;
      if (withTicks) room = tick(room, harness.deps).state;
    }
  };

  for (const entry of plan) {
    advanceTo(entry.at);
    const result = reduceRoom(
      room,
      {
        type: 'SUBMIT_ANSWER',
        playerId: entry.playerId,
        roundId: currentRound(room)?.id ?? (room.id as never),
        payload: { playerId: entry.pick },
      },
      harness.deps,
    );
    expect(result.rejection).toBeNull();
    room = result.state;
  }
  expect(room.phase).toBe('roundReveal'); // everyone answered, so the round resolved itself
  return room;
};

const gameplayOf = (room: RoomState) => ({
  phase: room.phase,
  players: room.players,
  penalties: room.penalties,
  rngState: room.rngState,
  round: { ...currentRound(room), contentChangeAt: undefined },
});

describe('ticking changes only what is broadcast and when — never the outcome', () => {
  for (const seed of [7, 11, 2024]) {
    it(`seed ${seed}: identical scores, penalties, standings and RNG with or without ticks`, () => {
      const quiet = playG1Round(false, seed);
      const ticked = playG1Round(true, seed);
      expect(gameplayOf(ticked)).toEqual(gameplayOf(quiet));
      // The ticked run did commit the clue unlocks it passed through…
      expect(ticked.version).toBeGreaterThan(quiet.version);
      // …and the clue-count-based scoring saw the same clues either way.
      const outcome = currentRound(ticked)?.outcome;
      expect(outcome?.winnerIds).toContain(HOST);
      const hostMeta = outcome?.scores.find((score) => score.playerId === HOST)?.meta as { cluesUsed: number };
      expect(hostMeta.cluesUsed).toBe(1);
    });
  }

  it('replays deterministically with ticks interleaved', () => {
    expect(playG1Round(true, 99)).toEqual(playG1Round(true, 99));
  });
});
