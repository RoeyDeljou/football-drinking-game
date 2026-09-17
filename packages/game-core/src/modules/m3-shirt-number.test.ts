import { describe, expect, it } from 'vitest';
import { EMPTY_DATA_CONTEXT } from '../data.js';
import {
  ALL_BUILT,
  asRoundView,
  generateWith,
  HOST,
  LINEUPS,
  mustGenerate,
  P2,
  P3,
  playerViews,
  sampleData,
  sub,
  T0,
} from '../harness.test-utils.js';
import { DEFAULT_SCORING } from '../scoring.js';
import { M3_DEFAULT_CONFIG, m3ShirtNumber as module } from './m3-shirt-number.js';

interface M3Public {
  readonly target: Readonly<Record<string, unknown>> & { readonly name: string };
}
interface M3Solution {
  readonly playerId: string;
  readonly shirtNumber: number;
}

const generated = mustGenerate(module);
const round = asRoundView(generated);
const answer = (generated.solution as M3Solution).shirtNumber;

const score = (submissions: readonly ReturnType<typeof sub>[], config: unknown = M3_DEFAULT_CONFIG) =>
  module.scoreRound({
    config,
    round,
    submissions,
    players: playerViews([HOST, P2, P3]),
    scoring: DEFAULT_SCORING,
    now: T0,
  });

describe('M3 metadata and generation', () => {
  it('declares the shirt-number data requirement', () => {
    expect(module.id).toBe('M3');
    expect(module.dataRequirements).toEqual(['hasLineups', 'hasShirtNumbers']);
  });

  it('targets a real pitch player and strips the number from the public payload', () => {
    const payload = generated.publicPayload as M3Public;
    const solution = generated.solution as M3Solution;
    // No number and no footballer id before reveal: an id could be joined against lineup data.
    expect(payload.target).not.toHaveProperty('shirtNumber');
    expect(payload.target).not.toHaveProperty('playerId');
    const real = ALL_BUILT.find((entry) => entry.player.id === solution.playerId);
    expect(payload.target.name).toBe(real?.player.name);
    expect(solution.shirtNumber).toBe(real?.lineup.shirtNumber);
  });

  it('skips players already used this session', () => {
    const first = mustGenerate(module, { seed: 2 });
    const second = mustGenerate(module, { seed: 2, usedContentKeys: [first.contentKey] });
    expect(second.contentKey).not.toBe(first.contentKey);
  });

  it('fails without lineups and when every shirt number is missing', () => {
    expect(generateWith(module, { data: EMPTY_DATA_CONTEXT }).ok).toBe(false);
    const stripped = generateWith(module, {
      data: sampleData({
        lineups: {
          ...LINEUPS,
          home: {
            ...LINEUPS.home,
            startingXI: LINEUPS.home.startingXI.map((entry) => ({ ...entry, shirtNumber: null })),
          },
          away: {
            ...LINEUPS.away,
            startingXI: LINEUPS.away.startingXI.map((entry) => ({ ...entry, shirtNumber: null })),
          },
        },
      }),
    });
    expect(stripped.ok).toBe(false);
  });
});

describe('M3 validation', () => {
  const validate = (raw: unknown) =>
    module.validateSubmission({
      config: M3_DEFAULT_CONFIG,
      round,
      playerId: HOST,
      raw,
      submittedAt: T0,
      elapsedMs: 0,
      alreadySubmitted: false,
    });

  it('accepts a number between 1 and 99', () => {
    expect(validate({ guess: 1 }).ok).toBe(true);
    expect(validate({ guess: 99 }).ok).toBe(true);
  });

  it('rejects out-of-range and non-integer guesses', () => {
    const low = validate({ guess: 0 });
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.code).toBe('OUT_OF_RANGE');
    expect(validate({ guess: 100 }).ok).toBe(false);
    expect(validate({ guess: 7.5 }).ok).toBe(false);
  });

  it('rejects a missing guess as a schema error', () => {
    const result = validate({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SCHEMA');
  });
});

describe('M3 scoring', () => {
  it('gives full credit only for an exact hit', () => {
    const outcome = score([sub(HOST, { guess: answer }, 0)]);
    const entry = outcome.scores.find((score_) => score_.playerId === HOST);
    expect(entry?.correct).toBe(true);
    expect(entry?.breakdown.accuracyFactor).toBe(1);
  });

  it('gives partial points for a near miss but does not count it as correct', () => {
    const near = answer + 2 <= 99 ? answer + 2 : answer - 2;
    const outcome = score([sub(HOST, { guess: near }, 0)]);
    const entry = outcome.scores.find((score_) => score_.playerId === HOST);
    expect(entry?.points).toBeGreaterThan(0);
    expect(entry?.correct).toBe(false);
    expect(entry?.breakdown.accuracyFactor).toBeCloseTo(0.8);
  });

  it('gives nothing beyond the tolerance range', () => {
    const far = answer > 50 ? 1 : 99;
    const outcome = score([sub(HOST, { guess: far }, 0)]);
    expect(outcome.scores.find((score_) => score_.playerId === HOST)?.points).toBe(0);
  });

  it('wins the round on distance, not on speed', () => {
    const near = answer + 1 <= 99 ? answer + 1 : answer - 1;
    const outcome = score([
      sub(HOST, { guess: near }, 0), // fast but one away
      sub(P2, { guess: answer }, 12_000), // slow but exact
    ]);
    expect(outcome.winnerIds).toEqual([P2]);
  });

  it('shares the win between equal distances', () => {
    const above = Math.min(99, answer + 3);
    const below = Math.max(1, answer - 3);
    const outcome = score([sub(HOST, { guess: above }, 0), sub(P2, { guess: below }, 0)]);
    expect([...outcome.winnerIds].sort()).toEqual([HOST, P2].sort());
  });

  it('charges the distance in sips, capped', () => {
    const far = answer > 50 ? 1 : 99;
    const outcome = score([sub(HOST, { guess: far }, 0), sub(P2, { guess: answer }, 0)]);
    const host = outcome.penalties.find((event) => event.playerId === HOST);
    expect(host?.reason).toBe('DISTANCE_FROM_TARGET');
    expect(host?.sips).toBe(M3_DEFAULT_CONFIG.maxDistanceSips);
    expect(host?.meta).toEqual({ distance: Math.abs(far - answer) });
    // An exact guess drinks nothing.
    expect(outcome.penalties.some((event) => event.playerId === P2)).toBe(false);
  });

  it('charges non-answers the full penalty and reports no winner', () => {
    const outcome = score([]);
    expect(outcome.penalties).toHaveLength(3);
    expect(outcome.penalties.every((event) => event.reason === 'NO_ANSWER')).toBe(true);
    expect(outcome.winnerIds).toEqual([]);
    expect(outcome.summary).toMatchObject({ bestDistance: -1 });
  });

  it('respects a custom tolerance and sip cap', () => {
    const config = { ...M3_DEFAULT_CONFIG, toleranceRange: 2, maxDistanceSips: 1 };
    const near = answer + 1 <= 99 ? answer + 1 : answer - 1;
    const outcome = score([sub(HOST, { guess: near }, 0)], config);
    expect(outcome.scores.find((score_) => score_.playerId === HOST)?.breakdown.accuracyFactor).toBeCloseTo(
      0.5,
    );
    expect(
      outcome.penalties.find((event) => event.playerId === HOST && event.reason === 'DISTANCE_FROM_TARGET')
        ?.sips,
    ).toBe(1);
  });
});
