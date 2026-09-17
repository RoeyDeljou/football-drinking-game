/**
 * Scoring service: correctness, a decaying speed bonus, a streak multiplier, explicit tie rules
 * and the cumulative leaderboard.
 *
 * Every function here is pure and takes its inputs explicitly — no clock, no randomness.
 */

import { z } from 'zod';
import type { PlayerId } from './ids.js';

export type SpeedCurve = 'linear' | 'quadratic';

export interface ScoringConfig {
  /** Points for a correct answer before speed bonus and multiplier. */
  readonly basePoints: number;
  /** Maximum additional points for answering instantly. */
  readonly speedBonusMax: number;
  /**
   * `linear` decays the bonus evenly across the answer window; `quadratic` front-loads it, so the
   * first few seconds are worth far more (Kahoot-style).
   */
  readonly speedCurve: SpeedCurve;
  /** Each consecutive correct answer beyond the first adds this much multiplier. */
  readonly streakStep: number;
  /** Hard ceiling on the streak multiplier. */
  readonly streakMax: number;
  /** Points awarded for a wrong-but-submitted answer (participation). */
  readonly wrongAnswerPoints: number;
  /** Points awarded for not answering at all. Deliberately separate from `wrongAnswerPoints`. */
  readonly noAnswerPoints: number;
}

export const DEFAULT_SCORING: ScoringConfig = {
  basePoints: 1000,
  speedBonusMax: 500,
  speedCurve: 'quadratic',
  streakStep: 0.1,
  streakMax: 2,
  wrongAnswerPoints: 0,
  noAnswerPoints: 0,
};

export const scoringConfigSchema = z
  .object({
    basePoints: z.number().int().min(0).max(100_000),
    speedBonusMax: z.number().int().min(0).max(100_000),
    speedCurve: z.enum(['linear', 'quadratic']),
    streakStep: z.number().min(0).max(5),
    streakMax: z.number().min(1).max(20),
    wrongAnswerPoints: z.number().int().min(0).max(100_000),
    noAnswerPoints: z.number().int().min(0).max(100_000),
  })
  .strict();

export interface ScoreBreakdown {
  readonly base: number;
  readonly speedBonus: number;
  readonly streakMultiplier: number;
  /** 1 for a clean correct answer; between 0 and 1 for proximity games (Shirt Number, Minute Sniper). */
  readonly accuracyFactor: number;
  readonly total: number;
}

export interface RoundScore {
  readonly playerId: PlayerId;
  readonly points: number;
  readonly correct: boolean;
  readonly breakdown: ScoreBreakdown;
  /** Structured, machine-readable detail for the reveal screen. Never a sentence. */
  readonly meta: Readonly<Record<string, string | number | boolean>> | null;
}

/**
 * Fraction of the speed bonus still available after `elapsedMs` of a `windowMs` answer window.
 * Returns 0 when there is no window (long-running rounds have no speed component).
 */
export const speedBonusFraction = (
  config: ScoringConfig,
  elapsedMs: number,
  windowMs: number | null,
): number => {
  if (windowMs === null || windowMs <= 0) return 0;
  const clamped = Math.min(Math.max(elapsedMs, 0), windowMs);
  const remaining = 1 - clamped / windowMs;
  return config.speedCurve === 'quadratic' ? remaining * remaining : remaining;
};

export const speedBonus = (config: ScoringConfig, elapsedMs: number, windowMs: number | null): number =>
  Math.round(config.speedBonusMax * speedBonusFraction(config, elapsedMs, windowMs));

/**
 * Multiplier for a run of `streakLength` consecutive correct answers.
 * A streak of 0 or 1 is 1.0 — the bonus starts on the second correct answer in a row.
 */
export const streakMultiplier = (config: ScoringConfig, streakLength: number): number => {
  const steps = Math.max(0, streakLength - 1);
  return Math.min(config.streakMax, 1 + steps * config.streakStep);
};

export interface ScoreAnswerInput {
  readonly playerId: PlayerId;
  readonly correct: boolean;
  readonly elapsedMs: number;
  readonly windowMs: number | null;
  /** The player's streak *before* this answer. */
  readonly streakBefore: number;
  /** 0..1. Use < 1 for partial credit; ignored when `correct` is false. */
  readonly accuracyFactor?: number;
  /**
   * Whether this answer counts as correct for streaks. Defaults to `correct`. Set it to `false` for
   * partial credit (a near miss earns points but neither extends a streak nor gets the streak
   * multiplier) — the returned score then has `correct: false`.
   */
  readonly countsAsCorrect?: boolean;
  readonly config: ScoringConfig;
  readonly meta?: Readonly<Record<string, string | number | boolean>>;
}

/** Score for a player who did not answer at all: `noAnswerPoints`, never `wrongAnswerPoints`. */
export const scoreNoAnswer = (input: {
  readonly playerId: PlayerId;
  readonly config: ScoringConfig;
  readonly meta?: Readonly<Record<string, string | number | boolean>>;
}): RoundScore => ({
  playerId: input.playerId,
  points: input.config.noAnswerPoints,
  correct: false,
  breakdown: {
    base: input.config.noAnswerPoints,
    speedBonus: 0,
    streakMultiplier: 1,
    accuracyFactor: 0,
    total: input.config.noAnswerPoints,
  },
  meta: input.meta ?? null,
});

/** The single place where points are computed. Modules must not invent their own formula. */
export const scoreAnswer = (input: ScoreAnswerInput): RoundScore => {
  const accuracyFactor = Math.min(Math.max(input.accuracyFactor ?? 1, 0), 1);
  const config = input.config;
  const countsAsCorrect = input.correct && (input.countsAsCorrect ?? true);

  if (!input.correct) {
    return {
      playerId: input.playerId,
      points: config.wrongAnswerPoints,
      correct: false,
      breakdown: {
        base: config.wrongAnswerPoints,
        speedBonus: 0,
        streakMultiplier: 1,
        accuracyFactor: 0,
        total: config.wrongAnswerPoints,
      },
      meta: input.meta ?? null,
    };
  }

  const base = Math.round(config.basePoints * accuracyFactor);
  const bonus = Math.round(speedBonus(config, input.elapsedMs, input.windowMs) * accuracyFactor);
  const multiplier = countsAsCorrect ? streakMultiplier(config, input.streakBefore + 1) : 1;
  const total = Math.round((base + bonus) * multiplier);

  return {
    playerId: input.playerId,
    points: total,
    correct: countsAsCorrect,
    breakdown: { base, speedBonus: bonus, streakMultiplier: multiplier, accuracyFactor, total },
    meta: input.meta ?? null,
  };
};

/**
 * Round winners. The highest positive score wins; every player on that exact score shares the win.
 * A round where nobody scored has no winner (rather than everybody winning).
 */
export const pickRoundWinners = (scores: readonly RoundScore[]): readonly PlayerId[] => {
  let best = 0;
  for (const score of scores) {
    if (score.points > best) best = score.points;
  }
  if (best <= 0) return [];
  return scores.filter((score) => score.points === best).map((score) => score.playerId);
};

/** Anything the leaderboard can rank. `PlayerState` satisfies this structurally. */
export interface RankablePlayer {
  readonly id: PlayerId;
  readonly nickname: string;
  readonly score: number;
  readonly correctAnswers: number;
  /** Sum of answer latencies, used as a tiebreaker (faster wins). */
  readonly totalResponseMs: number;
  readonly roundsWon: number;
  readonly sips: number;
  readonly streak: number;
  readonly bestStreak: number;
  readonly joinedAt: number;
}

export interface LeaderboardRow {
  /** Standard competition ranking: fully tied players share a rank and the next rank skips. */
  readonly rank: number;
  readonly tied: boolean;
  readonly playerId: PlayerId;
  readonly nickname: string;
  readonly score: number;
  readonly correctAnswers: number;
  readonly roundsWon: number;
  readonly sips: number;
  readonly streak: number;
  readonly bestStreak: number;
}

/**
 * Tie rules, applied in order:
 *  1. higher score
 *  2. more correct answers
 *  3. lower total response time (faster)
 *  4. more rounds won
 *  5. fewer sips
 *  6. joined earlier
 *  7. player id ascending — only to make the output order deterministic; players equal through
 *     rule 6 are reported as `tied: true` and share a rank.
 */
export const compareRankable = (a: RankablePlayer, b: RankablePlayer): number => {
  if (a.score !== b.score) return b.score - a.score;
  if (a.correctAnswers !== b.correctAnswers) return b.correctAnswers - a.correctAnswers;
  if (a.totalResponseMs !== b.totalResponseMs) return a.totalResponseMs - b.totalResponseMs;
  if (a.roundsWon !== b.roundsWon) return b.roundsWon - a.roundsWon;
  if (a.sips !== b.sips) return a.sips - b.sips;
  if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** True when two players are indistinguishable under every meaningful tiebreaker. */
export const isFullTie = (a: RankablePlayer, b: RankablePlayer): boolean =>
  a.score === b.score &&
  a.correctAnswers === b.correctAnswers &&
  a.totalResponseMs === b.totalResponseMs &&
  a.roundsWon === b.roundsWon &&
  a.sips === b.sips &&
  a.joinedAt === b.joinedAt;

export const buildLeaderboard = (players: readonly RankablePlayer[]): readonly LeaderboardRow[] => {
  const sorted = players.slice().sort(compareRankable);
  const rows: LeaderboardRow[] = [];

  let currentRank = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const player = sorted[index];
    if (player === undefined) continue;
    const previous = index > 0 ? sorted[index - 1] : undefined;
    const sharesWithPrevious = previous !== undefined && isFullTie(player, previous);
    if (!sharesWithPrevious) currentRank = index + 1;

    const next = sorted[index + 1];
    const tied = sharesWithPrevious || (next !== undefined && isFullTie(player, next));

    rows.push({
      rank: currentRank,
      tied,
      playerId: player.id,
      nickname: player.nickname,
      score: player.score,
      correctAnswers: player.correctAnswers,
      roundsWon: player.roundsWon,
      sips: player.sips,
      streak: player.streak,
      bestStreak: player.bestStreak,
    });
  }

  return rows;
};
