import { describe, expect, it } from 'vitest';
import { asPlayerId } from './ids.js';
import type { RankablePlayer } from './scoring.js';
import {
  buildLeaderboard,
  compareRankable,
  DEFAULT_SCORING,
  isFullTie,
  pickRoundWinners,
  scoreAnswer,
  speedBonus,
  speedBonusFraction,
  streakMultiplier,
} from './scoring.js';

const A = asPlayerId('a');
const B = asPlayerId('b');
const C = asPlayerId('c');

const rankable = (overrides: Partial<RankablePlayer> & { id: RankablePlayer['id'] }): RankablePlayer => ({
  nickname: overrides.id,
  score: 0,
  correctAnswers: 0,
  totalResponseMs: 0,
  roundsWon: 0,
  sips: 0,
  streak: 0,
  bestStreak: 0,
  joinedAt: 0,
  ...overrides,
});

describe('speed bonus', () => {
  it('is full at zero elapsed and zero at the deadline', () => {
    expect(speedBonusFraction(DEFAULT_SCORING, 0, 10_000)).toBe(1);
    expect(speedBonusFraction(DEFAULT_SCORING, 10_000, 10_000)).toBe(0);
  });

  it('decays quadratically by default and linearly when configured', () => {
    expect(speedBonusFraction(DEFAULT_SCORING, 5_000, 10_000)).toBeCloseTo(0.25);
    expect(speedBonusFraction({ ...DEFAULT_SCORING, speedCurve: 'linear' }, 5_000, 10_000)).toBeCloseTo(0.5);
  });

  it('clamps out-of-range elapsed times and disappears without a window', () => {
    expect(speedBonusFraction(DEFAULT_SCORING, -500, 10_000)).toBe(1);
    expect(speedBonusFraction(DEFAULT_SCORING, 99_000, 10_000)).toBe(0);
    expect(speedBonus(DEFAULT_SCORING, 0, null)).toBe(0);
    expect(speedBonus(DEFAULT_SCORING, 0, 0)).toBe(0);
  });
});

describe('streak multiplier', () => {
  it('starts at 1 and grows from the second consecutive correct answer', () => {
    expect(streakMultiplier(DEFAULT_SCORING, 0)).toBe(1);
    expect(streakMultiplier(DEFAULT_SCORING, 1)).toBe(1);
    expect(streakMultiplier(DEFAULT_SCORING, 3)).toBeCloseTo(1.2);
  });

  it('is capped', () => {
    expect(streakMultiplier(DEFAULT_SCORING, 500)).toBe(DEFAULT_SCORING.streakMax);
  });
});

describe('scoreAnswer', () => {
  it('awards base plus speed bonus times the streak multiplier', () => {
    const score = scoreAnswer({
      playerId: A,
      correct: true,
      elapsedMs: 0,
      windowMs: 10_000,
      streakBefore: 2,
      config: DEFAULT_SCORING,
    });
    // (1000 + 500) * 1.2
    expect(score.points).toBe(1800);
    expect(score.breakdown.streakMultiplier).toBeCloseTo(1.2);
    expect(score.correct).toBe(true);
  });

  it('gives a wrong answer the configured consolation points and no bonus', () => {
    const score = scoreAnswer({
      playerId: A,
      correct: false,
      elapsedMs: 0,
      windowMs: 10_000,
      streakBefore: 5,
      config: DEFAULT_SCORING,
    });
    expect(score.points).toBe(0);
    expect(score.breakdown.speedBonus).toBe(0);
    expect(score.breakdown.streakMultiplier).toBe(1);
  });

  it('scales partial credit through accuracyFactor and clamps it to [0,1]', () => {
    const half = scoreAnswer({
      playerId: A,
      correct: true,
      elapsedMs: 10_000,
      windowMs: 10_000,
      streakBefore: 0,
      accuracyFactor: 0.5,
      config: DEFAULT_SCORING,
    });
    expect(half.points).toBe(500);

    const over = scoreAnswer({
      playerId: A,
      correct: true,
      elapsedMs: 10_000,
      windowMs: 10_000,
      streakBefore: 0,
      accuracyFactor: 9,
      config: DEFAULT_SCORING,
    });
    expect(over.points).toBe(1000);
  });
});

describe('round winners', () => {
  it('shares the win between every player on the top score', () => {
    const scores = [
      scoreAnswer({
        playerId: A,
        correct: true,
        elapsedMs: 0,
        windowMs: null,
        streakBefore: 0,
        config: DEFAULT_SCORING,
      }),
      scoreAnswer({
        playerId: B,
        correct: true,
        elapsedMs: 0,
        windowMs: null,
        streakBefore: 0,
        config: DEFAULT_SCORING,
      }),
      scoreAnswer({
        playerId: C,
        correct: false,
        elapsedMs: 0,
        windowMs: null,
        streakBefore: 0,
        config: DEFAULT_SCORING,
      }),
    ];
    expect(pickRoundWinners(scores)).toEqual([A, B]);
  });

  it('has no winner when nobody scored', () => {
    const scores = [
      scoreAnswer({
        playerId: A,
        correct: false,
        elapsedMs: 0,
        windowMs: null,
        streakBefore: 0,
        config: DEFAULT_SCORING,
      }),
    ];
    expect(pickRoundWinners(scores)).toEqual([]);
  });
});

describe('leaderboard tie rules', () => {
  it('orders by score, then correct answers, then response time', () => {
    const rows = buildLeaderboard([
      rankable({ id: A, score: 100, correctAnswers: 1, totalResponseMs: 5_000 }),
      rankable({ id: B, score: 100, correctAnswers: 2, totalResponseMs: 9_000 }),
      rankable({ id: C, score: 300 }),
    ]);
    expect(rows.map((row) => row.playerId)).toEqual([C, B, A]);
    expect(rows.map((row) => row.rank)).toEqual([1, 2, 3]);
    expect(rows.every((row) => !row.tied)).toBe(true);
  });

  it('shares a rank on a full tie and skips the next rank', () => {
    const rows = buildLeaderboard([
      rankable({ id: A, score: 100 }),
      rankable({ id: B, score: 100 }),
      rankable({ id: C, score: 50 }),
    ]);
    expect(rows.map((row) => row.rank)).toEqual([1, 1, 3]);
    expect(rows.map((row) => row.tied)).toEqual([true, true, false]);
  });

  it('breaks a points tie by fewer sips and then by join order', () => {
    expect(
      compareRankable(rankable({ id: A, score: 10, sips: 2 }), rankable({ id: B, score: 10, sips: 5 })),
    ).toBeLessThan(0);
    expect(
      compareRankable(
        rankable({ id: A, score: 10, joinedAt: 1 }),
        rankable({ id: B, score: 10, joinedAt: 2 }),
      ),
    ).toBeLessThan(0);
  });

  it('treats indistinguishable players as fully tied and orders them deterministically by id', () => {
    const x = rankable({ id: asPlayerId('zz'), score: 10 });
    const y = rankable({ id: asPlayerId('aa'), score: 10 });
    expect(isFullTie(x, y)).toBe(true);
    expect(buildLeaderboard([x, y]).map((row) => row.playerId)).toEqual([y.id, x.id]);
  });

  it('handles an empty roster', () => {
    expect(buildLeaderboard([])).toEqual([]);
  });
});
