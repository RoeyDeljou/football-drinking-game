import { describe, expect, it } from 'vitest';
import { EMPTY_DATA_CONTEXT } from '../data.js';
import {
  ALL_BUILT,
  asRoundView,
  generateWith,
  HOST,
  mustGenerate,
  P2,
  P3,
  playerViews,
  sampleData,
  sub,
  T0,
} from '../harness.test-utils.js';
import { DEFAULT_SCORING } from '../scoring.js';
import { G1_DEFAULT_CONFIG, g1GuessThePlayer as module, visibleClueCount } from './g1-guess-the-player.js';

interface G1Public {
  readonly clues: readonly { readonly kind: string }[];
  readonly options: readonly { readonly playerId: string }[];
  readonly clueIntervalMs: number;
}
interface G1Solution {
  readonly playerId: string;
  readonly clueCount: number;
}

const generated = mustGenerate(module);
const round = asRoundView(generated);
const answer = (generated.solution as G1Solution).playerId;
const payload = generated.publicPayload as G1Public;
const wrong = payload.options.find((option) => option.playerId !== answer)?.playerId;

const score = (submissions: readonly ReturnType<typeof sub>[], config: unknown = G1_DEFAULT_CONFIG) =>
  module.scoreRound({
    config,
    round,
    submissions,
    players: playerViews([HOST, P2, P3]),
    scoring: DEFAULT_SCORING,
    now: T0,
  });

describe('visibleClueCount', () => {
  it('shows one clue immediately and one more per interval', () => {
    expect(visibleClueCount(0, 8_000, 5)).toBe(1);
    expect(visibleClueCount(7_999, 8_000, 5)).toBe(1);
    expect(visibleClueCount(8_000, 8_000, 5)).toBe(2);
    expect(visibleClueCount(24_000, 8_000, 5)).toBe(4);
  });

  it('never exceeds the clue count, goes below one, or divides by zero', () => {
    expect(visibleClueCount(999_999, 8_000, 3)).toBe(3);
    expect(visibleClueCount(-100, 8_000, 3)).toBe(1);
    expect(visibleClueCount(10, 0, 3)).toBe(3);
    expect(visibleClueCount(10, 8_000, 0)).toBe(0);
  });
});

describe('G1 generation', () => {
  it('is a general game built on career history', () => {
    expect(module.id).toBe('G1');
    expect(module.category).toBe('general');
    expect(module.dataRequirements).toEqual(['hasCareerHistory']);
  });

  it('builds the clue ladder in order and includes the answer among the options', () => {
    expect(payload.clues.map((clue) => clue.kind)).toEqual([
      'NATIONALITY',
      'POSITION',
      'AGE',
      'CAREER',
      'SHIRT_NUMBER',
    ]);
    expect(payload.options).toHaveLength(G1_DEFAULT_CONFIG.optionCount);
    expect(payload.options.some((option) => option.playerId === answer)).toBe(true);
    expect((generated.solution as G1Solution).clueCount).toBe(payload.clues.length);
  });

  it('omits clues the data cannot support', () => {
    const generatedThin = mustGenerate(module, {
      data: sampleData({
        profiles: ALL_BUILT.map((entry) => ({
          player: { ...entry.player, shirtNumber: null },
          career: entry.profile.career,
        })),
      }),
    });
    const thin = generatedThin.publicPayload as G1Public;
    expect(thin.clues.map((clue) => clue.kind)).not.toContain('SHIRT_NUMBER');
  });

  it('fails without profiles and when every profile is used up', () => {
    expect(generateWith(module, { data: EMPTY_DATA_CONTEXT }).ok).toBe(false);
    const exhausted = generateWith(module, {
      usedContentKeys: ALL_BUILT.map((entry) => entry.player.id),
    });
    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) expect(exhausted.reason).toBe('NO_UNUSED_CONTENT');
  });

  it('runs a longer answer window than a snap round', () => {
    expect(generated.answerWindowMs).toBe(G1_DEFAULT_CONFIG.answerWindowMs);
  });
});

describe('G1 validation', () => {
  const validate = (raw: unknown) =>
    module.validateSubmission({
      config: G1_DEFAULT_CONFIG,
      round,
      playerId: HOST,
      raw,
      submittedAt: T0,
      elapsedMs: 0,
      alreadySubmitted: false,
    });

  it('accepts an offered player and rejects anything else', () => {
    expect(validate({ playerId: answer }).ok).toBe(true);
    const unknown = validate({ playerId: 'someone-else' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe('UNKNOWN_OPTION');
    const malformed = validate({ playerId: 42 });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.code).toBe('SCHEMA');
  });
});

describe('G1 scoring', () => {
  it('pays more for guessing on fewer clues', () => {
    const early = score([sub(HOST, { playerId: answer }, 1_000)]);
    const late = score([sub(HOST, { playerId: answer }, 33_000)]);
    const earlyPoints = early.scores.find((entry) => entry.playerId === HOST)?.points ?? 0;
    const latePoints = late.scores.find((entry) => entry.playerId === HOST)?.points ?? 0;
    expect(earlyPoints).toBeGreaterThan(latePoints);
    expect(early.scores.find((entry) => entry.playerId === HOST)?.meta).toMatchObject({ cluesUsed: 1 });
  });

  it('never pays less than the configured minimum credit', () => {
    const outcome = score([sub(HOST, { playerId: answer }, 44_000)]);
    const entry = outcome.scores.find((score_) => score_.playerId === HOST);
    expect(entry?.breakdown.accuracyFactor).toBeGreaterThanOrEqual(G1_DEFAULT_CONFIG.minCredit);
  });

  it('makes everyone else drink when solved on the first clue', () => {
    const outcome = score([sub(HOST, { playerId: answer }, 500)]);
    const bonus = outcome.penalties.find((event) => event.reason === 'ROUND_WON');
    expect(bonus?.target).toBe('others');
    expect(bonus?.playerId).toBe(HOST);
  });

  it('does not hand out the first-clue bonus for a later solve', () => {
    const outcome = score([sub(HOST, { playerId: answer }, 20_000)]);
    expect(outcome.penalties.some((event) => event.reason === 'ROUND_WON')).toBe(false);
  });

  it('charges wrong answers and silence differently', () => {
    const outcome = score([sub(HOST, { playerId: wrong }, 1_000)]);
    const host = outcome.penalties.find((event) => event.playerId === HOST);
    const quiet = outcome.penalties.find((event) => event.playerId === P2);
    expect(host?.reason).toBe('WRONG_ANSWER');
    expect(host?.sips).toBe(G1_DEFAULT_CONFIG.wrongAnswerSips);
    expect(quiet?.reason).toBe('NO_ANSWER');
    expect(quiet?.sips).toBe(G1_DEFAULT_CONFIG.noAnswerSips);
  });
});

describe('G1 projection', () => {
  it('only emits the clues unlocked so far, and all of them on reveal', () => {
    const project = (now: number, visibility: 'pre-reveal' | 'revealed') =>
      module.projectRound({ config: G1_DEFAULT_CONFIG, round, viewerId: HOST, visibility, now });

    const first = project(T0, 'pre-reveal').publicPayload as G1Public;
    expect(first.clues).toHaveLength(1);

    const third = project(T0 + 16_000, 'pre-reveal').publicPayload as G1Public;
    expect(third.clues).toHaveLength(3);

    const revealed = project(T0, 'revealed');
    expect((revealed.publicPayload as G1Public).clues).toHaveLength(payload.clues.length);
    expect(revealed.solution).toEqual(generated.solution);
  });
});
