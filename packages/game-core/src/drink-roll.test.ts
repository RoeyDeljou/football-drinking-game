/**
 * The drink roll: the random magnitude of `WRONG_ANSWER` / `NO_ANSWER` penalties.
 *
 * Covers the roll itself (tiers, weighting, one draw per roll), the per-recipient helper, the
 * reducer's RNG threading into `scoreRound` (the replay-critical part: the draws must come from the
 * committed `RoomState.rngState` and the advanced state must be committed back), cap interaction,
 * and that nothing about a roll is visible before reveal.
 */

import { describe, expect, it } from 'vitest';
import type { RoomAction } from './actions.js';
import type { GameModuleId, PlayerId } from './ids.js';
import { asPlayerId, asRoundId, asSessionId } from './ids.js';
import { G1_ID } from './modules/g1-guess-the-player.js';
import { G3_ID } from './modules/g3-career-path.js';
import { G6_ID } from './modules/g6-trivia-rush.js';
import { G_MIX_ID, M_MIX_ID } from './modules/mixed.js';
import { ROLLED_PENALTY_META, rolledSelfPenalties, selfPenalties } from './modules/helpers.js';
import { M1_ID, M1_MIN_FILING_WINDOW_MS } from './modules/m1-match-markets.js';
import { M2_ID } from './modules/m2-who-is-that-player.js';
import { M3_ID } from './modules/m3-shirt-number.js';
import type { PenaltyCaps, RecordedPenalty } from './penalties.js';
import { applyPenalties, DEFAULT_PENALTY_CAPS, DRINK_ROLL_TABLE, penalty, rollDrinkSips } from './penalties.js';
import { createSeededRng } from './ports.js';
import { projectFor } from './projection.js';
import type { EngineDeps } from './reducer.js';
import { reduceAll, reduceRoom } from './reducer.js';
import type { RoomState } from './state.js';
import { currentRound } from './state.js';
import {
  drawFor,
  HOST,
  makeHarness,
  newRoom,
  P2,
  P3,
  rollsForSeed,
  scriptedRng,
  T0,
} from './harness.test-utils.js';

/**
 * The client's `drinkActionLabel` bands (apps/web/src/lib/drinkCopy.ts), restated here because the
 * engine cannot import the web layer. Each rolled value must land in exactly one of them.
 */
const WEB_BANDS: readonly { readonly label: string; readonly min: number; readonly max: number }[] = [
  { label: 'no drinking', min: -Infinity, max: 0 },
  { label: '1 sip', min: 1, max: 1 },
  { label: '2 sips', min: 2, max: 2 },
  { label: 'a chug', min: 3, max: 4 },
  { label: 'a shot', min: 5, max: 7 },
  { label: '2 shots', min: 8, max: Infinity },
];
const bandOf = (sips: number): string | undefined =>
  WEB_BANDS.find((band) => sips >= band.min && sips <= band.max)?.label;

const ROLL_VALUES = DRINK_ROLL_TABLE.map((tier) => tier.sips);
const TOP_TIER = Math.max(...ROLL_VALUES);

/** The generator state after `draws` calls to `next()` from `state` — what the reducer must commit. */
const stateAfter = (state: number, draws: number): number => {
  const rng = createSeededRng(state);
  for (let i = 0; i < draws; i += 1) rng.next();
  return rng.state();
};

/* ------------------------------- the roll -------------------------------- */

describe('the drink-roll table', () => {
  it('has six tiers, one per client display band, in ascending order', () => {
    expect(DRINK_ROLL_TABLE).toHaveLength(6);
    expect(ROLL_VALUES.map(bandOf)).toEqual(WEB_BANDS.map((band) => band.label));
    expect([...ROLL_VALUES].sort((a, b) => a - b)).toEqual(ROLL_VALUES);
  });

  it('gives every tier positive weight, sums to 100 and keeps "2 shots" the rarest', () => {
    const weights = DRINK_ROLL_TABLE.map((tier) => tier.weight);
    expect(weights.every((weight) => weight > 0 && Number.isInteger(weight))).toBe(true);
    expect(weights.reduce((sum, weight) => sum + weight, 0)).toBe(100);
    const top = DRINK_ROLL_TABLE.find((tier) => tier.sips === TOP_TIER);
    const others = DRINK_ROLL_TABLE.filter((tier) => tier.sips !== TOP_TIER);
    expect(others.every((tier) => tier.weight > (top?.weight ?? Infinity))).toBe(true);
  });

  it('puts most of the mass on 1-2 sips', () => {
    const light = DRINK_ROLL_TABLE.filter((tier) => tier.sips === 1 || tier.sips === 2);
    expect(light.reduce((sum, tier) => sum + tier.weight, 0)).toBeGreaterThanOrEqual(50);
  });

  it('fits under the default per-penalty cap, so the top tier is never truncated', () => {
    expect(DEFAULT_PENALTY_CAPS.perPenalty).toBeGreaterThanOrEqual(TOP_TIER);
    expect(DEFAULT_PENALTY_CAPS.perRound).toBeGreaterThanOrEqual(DEFAULT_PENALTY_CAPS.perPenalty);
    expect(DEFAULT_PENALTY_CAPS.perSession).toBeGreaterThanOrEqual(DEFAULT_PENALTY_CAPS.perRound);
  });
});

describe('rollDrinkSips', () => {
  it('maps the whole [0, 1) range onto the tiers, edges included', () => {
    expect(rollDrinkSips(scriptedRng([0]))).toBe(0);
    expect(rollDrinkSips(scriptedRng([0.1199]))).toBe(0);
    expect(rollDrinkSips(scriptedRng([0.12]))).toBe(1);
    expect(rollDrinkSips(scriptedRng([0.42]))).toBe(2);
    expect(rollDrinkSips(scriptedRng([0.7]))).toBe(3);
    expect(rollDrinkSips(scriptedRng([0.85]))).toBe(6);
    expect(rollDrinkSips(scriptedRng([0.95]))).toBe(9);
    expect(rollDrinkSips(scriptedRng([0.999999]))).toBe(9);
    for (const sips of ROLL_VALUES) expect(rollDrinkSips(scriptedRng([drawFor(sips)]))).toBe(sips);
  });

  it('falls back to the top tier for a non-conforming draw of 1', () => {
    expect(rollDrinkSips(scriptedRng([1]))).toBe(TOP_TIER);
  });

  it('consumes exactly one draw per roll', () => {
    const rolled = createSeededRng(99);
    const manual = createSeededRng(99);
    rollDrinkSips(rolled);
    manual.next();
    expect(rolled.state()).toBe(manual.state());
  });

  it('is deterministic for a seed', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      expect(rollsForSeed(seed, 5)).toEqual(rollsForSeed(seed, 5));
    }
  });

  it('produces real variety across 1000 seeds, roughly matching the weights', () => {
    const counts = new Map<number, number>();
    const SEEDS = 1000;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const sips = rollDrinkSips(createSeededRng(seed));
      counts.set(sips, (counts.get(sips) ?? 0) + 1);
    }
    // Every tier occurs, and nothing outside the table ever does.
    expect([...counts.keys()].sort((a, b) => a - b)).toEqual(ROLL_VALUES);
    for (const tier of DRINK_ROLL_TABLE) {
      const share = ((counts.get(tier.sips) ?? 0) / SEEDS) * 100;
      // Loose ±5 percentage points: a sanity check on the weighting, not a statistics test.
      expect(Math.abs(share - tier.weight)).toBeLessThan(5);
    }
    expect(counts.get(TOP_TIER) ?? 0).toBeLessThan((counts.get(1) ?? 0) / 3);
  });

  it('also varies along one long sequence (the way a session actually draws)', () => {
    const rng = createSeededRng(2024);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) seen.add(rollDrinkSips(rng));
    expect(seen.size).toBe(DRINK_ROLL_TABLE.length);
  });
});

/* ------------------------------- the helper ------------------------------- */

describe('rolledSelfPenalties', () => {
  const A = asPlayerId('a');
  const B = asPlayerId('b');
  const C = asPlayerId('c');

  it('rolls independently per player, in list order, marked as rolled', () => {
    const events = rolledSelfPenalties(scriptedRng([drawFor(9), drawFor(0), drawFor(2)]), [A, B, C], 'WRONG_ANSWER', true);
    expect(events).toEqual([
      penalty(A, 'self', 9, 'WRONG_ANSWER', ROLLED_PENALTY_META),
      penalty(B, 'self', 0, 'WRONG_ANSWER', ROLLED_PENALTY_META),
      penalty(C, 'self', 2, 'WRONG_ANSWER', ROLLED_PENALTY_META),
    ]);
  });

  it('emits a zero roll rather than dropping it: "no drinking" is an outcome worth announcing', () => {
    const events = rolledSelfPenalties(scriptedRng([drawFor(0)]), [A], 'NO_ANSWER', true);
    expect(events).toEqual([penalty(A, 'self', 0, 'NO_ANSWER', ROLLED_PENALTY_META)]);
  });

  it('matches a seeded sequence exactly', () => {
    const events = rolledSelfPenalties(createSeededRng(31), [A, B, C], 'NO_ANSWER', true);
    expect(events.map((event) => event.sips)).toEqual(rollsForSeed(31, 3));
  });

  it('emits nothing and draws nothing when disabled', () => {
    const rng = createSeededRng(31);
    const before = rng.state();
    expect(rolledSelfPenalties(rng, [A, B, C], 'WRONG_ANSWER', false)).toEqual([]);
    expect(rng.state()).toBe(before);
  });

  it('draws nothing for an empty bucket', () => {
    const rng = createSeededRng(31);
    const before = rng.state();
    expect(rolledSelfPenalties(rng, [], 'WRONG_ANSWER', true)).toEqual([]);
    expect(rng.state()).toBe(before);
  });

  it('leaves the fixed-magnitude selfPenalties untouched for deliberate uniform mechanics', () => {
    expect(selfPenalties([A, B], 3, 'WORST_SLIP')).toEqual([
      penalty(A, 'self', 3, 'WORST_SLIP'),
      penalty(B, 'self', 3, 'WORST_SLIP'),
    ]);
    expect(selfPenalties([A], 0, 'WORST_SLIP')).toEqual([]);
  });
});

/* ---------------------- the reducer threads the RNG ----------------------- */

const join = (playerId: PlayerId, nickname: string): RoomAction => ({
  type: 'PLAYER_JOIN',
  playerId,
  nickname,
  isGuest: true,
});

/** Host + two guests, `moduleId` started from a room seeded with `seed`. */
const started = (moduleId: GameModuleId, deps: EngineDeps, seed: number, config: unknown = null): RoomState => {
  const result = reduceAll(
    newRoom(T0, seed),
    [
      join(P2, 'Bea'),
      join(P3, 'Cal'),
      { type: 'SELECT_GAME', actorId: HOST, moduleId, config },
      { type: 'START_SESSION', actorId: HOST },
    ],
    deps,
  );
  expect(result.rejection).toBeNull();
  return result.state;
};

const rolledFor = (room: RoomState): readonly RecordedPenalty[] => {
  const roundId = currentRound(room)?.id;
  return room.penalties.filter(
    (entry) => entry.roundId === roundId && (entry.reason === 'WRONG_ANSWER' || entry.reason === 'NO_ANSWER'),
  );
};

const REVEAL: RoomAction = { type: 'REVEAL_ROUND', actorId: HOST };
const MODULES_WITH_ROLLS: readonly GameModuleId[] = [G1_ID, G3_ID, G6_ID, M1_ID, M2_ID, M3_ID, G_MIX_ID, M_MIX_ID];

describe('reducer: scoreRound draws from the committed RNG state and commits the advance', () => {
  it('rolls every silent player from the pre-reveal rngState and commits exactly those draws', () => {
    for (const moduleId of MODULES_WITH_ROLLS) {
      for (let seed = 1; seed <= 25; seed += 1) {
        const { deps, clock } = makeHarness();
        const room = started(moduleId, deps, seed);
        const before = room.rngState;
        // M1 only charges a missing slip after a real filing window (see M1_MIN_FILING_WINDOW_MS).
        if (moduleId === M1_ID) clock.advance(M1_MIN_FILING_WINDOW_MS);
        const revealed = reduceRoom(room, REVEAL, deps);
        expect(revealed.rejection).toBeNull();

        const rolled = rolledFor(revealed.state);
        // Nobody answered: one NO_ANSWER per player, in player order, and scoring drew nothing else.
        expect(rolled.map((entry) => entry.recipientId)).toEqual([HOST, P2, P3]);
        expect(rolled.map((entry) => entry.reason)).toEqual(['NO_ANSWER', 'NO_ANSWER', 'NO_ANSWER']);
        expect(rolled.map((entry) => entry.requestedSips)).toEqual(rollsForSeed(before, 3));
        // The advanced state is committed — never left behind (every round would roll the same) and
        // never re-derived from elsewhere (a replay would diverge).
        expect(revealed.state.rngState).toBe(stateAfter(before, 3));
        expect(revealed.state.rngState).not.toBe(before);
      }
    }
  });

  it('replays byte-for-byte from scratch, twice, for every module', () => {
    for (const moduleId of MODULES_WITH_ROLLS) {
      for (const seed of [3, 42, 1234, 99_999]) {
        const play = (): RoomState => {
          const { deps } = makeHarness();
          const room = started(moduleId, deps, seed);
          return reduceRoom(room, REVEAL, deps).state;
        };
        const first = play();
        const second = play();
        expect(second.rngState).toBe(first.rngState);
        expect(rolledFor(second)).toEqual(rolledFor(first));
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      }
    }
  });

  it('survives a JSON round-trip of the room right before the reveal', () => {
    for (const moduleId of MODULES_WITH_ROLLS) {
      const a = makeHarness();
      const room = started(moduleId, a.deps, 77);
      const straight = reduceRoom(room, REVEAL, a.deps).state;
      const b = makeHarness();
      const restored = reduceRoom(JSON.parse(JSON.stringify(room)) as RoomState, REVEAL, b.deps).state;
      expect(restored).toEqual(straight);
    }
  });

  it('gives different rounds of one session different rolls (the state really advances)', () => {
    const { deps } = makeHarness();
    let room = started(G6_ID, deps, 8);
    const perRound: number[][] = [];
    for (let round = 0; round < 5; round += 1) {
      room = reduceRoom(room, REVEAL, deps).state;
      perRound.push(rolledFor(room).map((entry) => entry.requestedSips));
      room = reduceAll(room, [{ type: 'ADVANCE', actorId: HOST }, { type: 'ADVANCE', actorId: HOST }], deps).state;
    }
    expect(new Set(perRound.map((rolls) => rolls.join(','))).size).toBeGreaterThan(1);
    expect(new Set(perRound.flat()).size).toBeGreaterThan(2);
  });

  it('shows real variety in actual gameplay: many seeds produce many tiers, not one fixed value', () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 60; seed += 1) {
      const { deps } = makeHarness();
      const revealed = reduceRoom(started(M2_ID, deps, seed), REVEAL, deps).state;
      for (const entry of rolledFor(revealed)) seen.add(entry.appliedSips);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual(ROLL_VALUES);
  });

  it('rolls on the auto-reveal path (last submission) from that dispatch\'s RNG state', () => {
    const { deps } = makeHarness();
    let room = started(G6_ID, deps, 5);
    const round = currentRound(room);
    const answer = (round?.solution as { optionId: string }).optionId;
    const wrong = (round?.publicPayload as { options: { id: string }[] }).options.find(
      (option) => option.id !== answer,
    )?.id;
    const submit = (playerId: PlayerId): RoomAction => ({
      type: 'SUBMIT_ANSWER',
      playerId,
      roundId: round?.id ?? asRoundId('missing'),
      payload: { optionId: wrong },
    });
    room = reduceAll(room, [submit(HOST), submit(P2)], deps).state;
    const before = room.rngState;
    const last = reduceRoom(room, submit(P3), deps).state;
    expect(last.phase).toBe('roundReveal');
    expect(rolledFor(last).map((entry) => [entry.recipientId, entry.reason])).toEqual([
      [HOST, 'WRONG_ANSWER'],
      [P2, 'WRONG_ANSWER'],
      [P3, 'WRONG_ANSWER'],
    ]);
    expect(rolledFor(last).map((entry) => entry.requestedSips)).toEqual(rollsForSeed(before, 3));
    expect(last.rngState).toBe(stateAfter(before, 3));
  });

  it('rolls on the deadline path (TICK) too', () => {
    const { deps, clock } = makeHarness();
    const room = started(M2_ID, deps, 6);
    const before = room.rngState;
    clock.advance(10 * 60_000);
    const ticked = reduceRoom(room, { type: 'TICK' }, deps).state;
    expect(ticked.phase).toBe('roundReveal');
    expect(rolledFor(ticked).map((entry) => entry.requestedSips)).toEqual(rollsForSeed(before, 3));
    expect(ticked.rngState).toBe(stateAfter(before, 3));
  });

  it('consumes no randomness on a rejected reveal', () => {
    const { deps } = makeHarness();
    const revealed = reduceRoom(started(M2_ID, deps, 4), REVEAL, deps).state;
    const again = reduceRoom(revealed, REVEAL, deps);
    expect(again.rejection).not.toBeNull();
    expect(again.state).toBe(revealed);
  });

  it('draws nothing when a module has the miss penalties switched off', () => {
    const { deps } = makeHarness();
    const room = started(M3_ID, deps, 4, {
      answerWindowMs: 15_000,
      toleranceRange: 10,
      maxDistanceSips: 5,
      noAnswerSips: 0,
      includeSubstitutes: false,
    });
    const revealed = reduceRoom(room, REVEAL, deps).state;
    expect(rolledFor(revealed)).toEqual([]);
    expect(revealed.rngState).toBe(room.rngState);
  });
});

/* --------------------------------- caps ---------------------------------- */

describe('caps with rolled magnitudes', () => {
  const A = asPlayerId('a');
  const B = asPlayerId('b');
  const C = asPlayerId('c');
  const apply = (events: Parameters<typeof applyPenalties>[0]['events'], caps: PenaltyCaps = DEFAULT_PENALTY_CAPS) =>
    applyPenalties({
      events,
      participantIds: [A, B, C],
      caps,
      sessionId: asSessionId('s'),
      roundId: asRoundId('r'),
      sessionSipsByPlayer: {},
      roundSipsByPlayer: {},
    });

  it('lets a top-tier roll reach the recipient uncapped under the default caps', () => {
    const result = apply([penalty(A, 'self', TOP_TIER, 'WRONG_ANSWER', ROLLED_PENALTY_META)]);
    expect(result.recorded[0]).toMatchObject({ requestedSips: TOP_TIER, appliedSips: TOP_TIER, cappedBy: 'none' });
  });

  it('still truncates a top-tier roll in a room that kept the old perPenalty of 6', () => {
    const result = apply([penalty(A, 'self', TOP_TIER, 'WRONG_ANSWER')], { perPenalty: 6, perRound: 10, perSession: 60 });
    expect(result.recorded[0]).toMatchObject({ appliedSips: 6, cappedBy: 'perPenalty' });
  });

  it('holds the per-round cap when a top-tier roll meets other penalties in one round', () => {
    // G1: A misses and rolls 2 shots; B and C both solve on the first clue ("everyone else drinks 1").
    const result = apply([
      penalty(A, 'self', 9, 'WRONG_ANSWER', ROLLED_PENALTY_META),
      penalty(B, 'others', 1, 'ROUND_WON'),
      penalty(C, 'others', 1, 'ROUND_WON'),
    ]);
    const forA = result.recorded.filter((entry) => entry.recipientId === A);
    expect(forA.map((entry) => [entry.appliedSips, entry.cappedBy])).toEqual([
      [9, 'none'],
      [1, 'none'],
      [0, 'perRound'],
    ]);
    expect(result.sipsByPlayer[A]).toBe(DEFAULT_PENALTY_CAPS.perRound);
  });

  it('never exceeds the per-round cap for any mix of rolls', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const rolls = rollsForSeed(seed, 4);
      const result = apply(rolls.map((sips) => penalty(A, 'self', sips, 'WRONG_ANSWER')));
      expect(result.sipsByPlayer[A] ?? 0).toBeLessThanOrEqual(DEFAULT_PENALTY_CAPS.perRound);
      expect(result.sipsByPlayer[A] ?? 0).toBe(Math.min(DEFAULT_PENALTY_CAPS.perRound, rolls.reduce((s, v) => s + v, 0)));
    }
  });

  it('records a zero roll as a zero-sip entry, not as a cap', () => {
    const result = apply([penalty(A, 'self', 0, 'NO_ANSWER', ROLLED_PENALTY_META)]);
    expect(result.recorded[0]).toMatchObject({ requestedSips: 0, appliedSips: 0, cappedBy: 'none' });
  });

  it('delivers a rolled top tier end-to-end through the reducer under default settings', () => {
    let found: RecordedPenalty | undefined;
    for (let seed = 1; seed <= 200 && found === undefined; seed += 1) {
      const { deps } = makeHarness();
      const revealed = reduceRoom(started(M2_ID, deps, seed), REVEAL, deps).state;
      found = rolledFor(revealed).find((entry) => entry.requestedSips === TOP_TIER);
    }
    expect(found).toMatchObject({ appliedSips: TOP_TIER, cappedBy: 'none' });
  });
});

/* ------------------------------ no answer leak ----------------------------- */

describe('the roll is invisible before reveal', () => {
  it('never exposes rngState, penalties or an outcome in a pre-reveal projection', () => {
    for (const moduleId of MODULES_WITH_ROLLS) {
      const { deps } = makeHarness();
      const room = started(moduleId, deps, 12);
      for (const viewer of [HOST, P2, null]) {
        const view = projectFor(room, viewer, deps);
        expect(view.round?.visibility).toBe('pre-reveal');
        expect(view.round).not.toHaveProperty('penalties');
        expect(view.round).not.toHaveProperty('outcome');
        expect(JSON.stringify(view)).not.toContain('rngState');
        expect(JSON.stringify(view)).not.toContain('"rolled"');
      }
    }
  });

  it('computes no roll until the reveal: the RNG state and penalties are untouched by submissions', () => {
    const { deps } = makeHarness();
    const room = started(M2_ID, deps, 12);
    const round = currentRound(room);
    const answer = (round?.solution as { playerId: string }).playerId;
    const wrong = (round?.publicPayload as { options: { playerId: string }[] }).options.find(
      (option) => option.playerId !== answer,
    )?.playerId;
    const submitted = reduceRoom(
      room,
      { type: 'SUBMIT_ANSWER', playerId: P2, roundId: round?.id ?? asRoundId('missing'), payload: { playerId: wrong } },
      deps,
    ).state;
    expect(submitted.phase).toBe('playing');
    expect(submitted.rngState).toBe(room.rngState);
    expect(submitted.penalties).toEqual([]);
  });

  it('exposes the rolled penalties after reveal', () => {
    const { deps } = makeHarness();
    const revealed = reduceRoom(started(M2_ID, deps, 12), REVEAL, deps).state;
    const view = projectFor(revealed, P2, deps);
    if (view.round?.visibility !== 'revealed') throw new Error('expected a revealed round');
    expect(view.round.penalties.filter((entry) => entry.reason === 'NO_ANSWER')).toHaveLength(3);
  });
});
