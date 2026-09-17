/**
 * Shared, pure helpers for game modules. Nothing here reaches outside the engine.
 *
 * `@fdg/football-data` is imported **type-only**, so branded football ids are re-branded here with
 * local cast helpers rather than by calling the data package at runtime.
 */

import type { FixtureLineups, FootballPlayerId, PlayerPosition, TeamId } from '@fdg/football-data';
import { z } from 'zod';
import type { PlayerId } from '../ids.js';
import type { RoundPlayerView, TypedSubmission, ModuleShape } from '../module.js';
import type { PenaltyEvent, PenaltyReason } from '../penalties.js';
import { penalty } from '../penalties.js';
import type { RoundScore, ScoringConfig } from '../scoring.js';
import { scoreAnswer, scoreNoAnswer } from '../scoring.js';

export const footballPlayerIdSchema = z
  .string()
  .min(1)
  .transform((value): FootballPlayerId => value as FootballPlayerId);

export const teamIdSchema = z
  .string()
  .min(1)
  .transform((value): TeamId => value as TeamId);

export const positionSchema = z.enum(['GK', 'DF', 'MF', 'FW', 'UNKNOWN']);

/** A footballer on the pitch, flattened from the lineup structure. */
export interface PitchPlayer {
  readonly playerId: FootballPlayerId;
  readonly name: string;
  readonly teamId: TeamId;
  readonly shirtNumber: number | null;
  readonly position: PlayerPosition;
  readonly isStarter: boolean;
}

export const pitchPlayerSchema = z
  .object({
    playerId: footballPlayerIdSchema,
    name: z.string(),
    teamId: teamIdSchema,
    shirtNumber: z.number().int().nullable(),
    position: positionSchema,
    isStarter: z.boolean(),
  })
  .strict();

/** All 22 starters (plus substitutes when `includeSubstitutes`), home team first. */
export const pitchPlayers = (
  lineups: FixtureLineups | null,
  includeSubstitutes = false,
): readonly PitchPlayer[] => {
  if (lineups === null) return [];
  const sides = [lineups.home, lineups.away];
  const out: PitchPlayer[] = [];
  for (const side of sides) {
    const roster = includeSubstitutes ? [...side.startingXI, ...side.substitutes] : side.startingXI;
    for (const entry of roster) {
      out.push({
        playerId: entry.playerId,
        name: entry.name,
        teamId: side.teamId,
        shirtNumber: entry.shirtNumber,
        position: entry.position,
        isStarter: entry.isStarter,
      });
    }
  }
  return out;
};

/** Room participants who did not submit anything this round. */
export const nonSubmitters = <S extends ModuleShape>(
  players: readonly RoundPlayerView[],
  submissions: readonly TypedSubmission<S>[],
): readonly PlayerId[] =>
  players
    .filter((player) => !submissions.some((submission) => submission.playerId === player.id))
    .map((player) => player.id);

/** One `self` penalty per player in `playerIds`. */
export const selfPenalties = (
  playerIds: readonly PlayerId[],
  sips: number,
  reason: PenaltyReason,
  meta: Readonly<Record<string, string | number | boolean>> | null = null,
): readonly PenaltyEvent[] =>
  sips <= 0 ? [] : playerIds.map((playerId) => penalty(playerId, 'self', sips, reason, meta));

/**
 * The player who answered correctly last, for "last to answer correctly drinks" mechanics.
 *
 * Rule (shared by M2 and G6):
 *  - nobody correct → nobody drinks for this;
 *  - the slowest correct answer drinks, **including a lone correct answer** — being the only one to
 *    get it right still makes you the last one to get it right;
 *  - exception: when that player was the *only* player who answered at all, there was no race to
 *    lose, so nobody drinks for this.
 *
 * Ties on `elapsedMs` go to the later submission in list order (the reducer stores submissions in
 * arrival order), which keeps the result deterministic.
 */
export const lastCorrectPlayer = <S extends ModuleShape>(
  correct: readonly TypedSubmission<S>[],
  answeredCount: number,
): PlayerId | null => {
  if (correct.length === 0) return null;
  if (correct.length === 1 && answeredCount <= 1) return null;
  let slowest: TypedSubmission<S> | null = null;
  for (const submission of correct) {
    if (slowest === null || submission.elapsedMs >= slowest.elapsedMs) slowest = submission;
  }
  return slowest === null ? null : slowest.playerId;
};

/** Deterministic multiple-choice option order: the answer plus distractors, shuffled by the seeded RNG. */
export const buildOptions = <T>(
  answer: T,
  pool: readonly T[],
  optionCount: number,
  shuffle: (items: readonly T[]) => readonly T[],
  isSame: (a: T, b: T) => boolean,
): readonly T[] => {
  const distractors = shuffle(pool.filter((candidate) => !isSame(candidate, answer))).slice(
    0,
    Math.max(0, optionCount - 1),
  );
  return shuffle([answer, ...distractors]);
};

export interface ChoiceScoringInput<S extends ModuleShape> {
  readonly players: readonly RoundPlayerView[];
  readonly submissions: readonly TypedSubmission<S>[];
  readonly isCorrect: (submission: TypedSubmission<S>) => boolean;
  /** Partial credit in [0, 1]. Defaults to 1 for a correct answer. */
  readonly accuracyFactor?: (submission: TypedSubmission<S>) => number;
  /** Overrides the `correct` flag (streak semantics) independently of the points earned. */
  readonly countsAsCorrect?: (submission: TypedSubmission<S>) => boolean;
  readonly meta?: (
    submission: TypedSubmission<S>,
  ) => Readonly<Record<string, string | number | boolean>> | null;
  readonly windowMs: number | null;
  readonly scoring: ScoringConfig;
}

/**
 * The one scoring path every answer-based module uses, so speed decay and streak multipliers can
 * never drift between games. Players who did not answer receive an explicit zero score, which is
 * what resets their streak in the reducer.
 */
export const scoreChoiceRound = <S extends ModuleShape>(
  input: ChoiceScoringInput<S>,
): readonly RoundScore[] =>
  input.players.map((player) => {
    const submission = input.submissions.find((entry) => entry.playerId === player.id);
    if (submission === undefined) {
      return scoreNoAnswer({ playerId: player.id, config: input.scoring, meta: { answered: false } });
    }

    const correct = input.isCorrect(submission);
    const accuracy = correct ? (input.accuracyFactor?.(submission) ?? 1) : 0;
    const counts = input.countsAsCorrect?.(submission);
    return scoreAnswer({
      playerId: player.id,
      correct,
      elapsedMs: submission.elapsedMs,
      windowMs: input.windowMs,
      streakBefore: player.streak,
      accuracyFactor: accuracy,
      config: input.scoring,
      ...(counts === undefined ? {} : { countsAsCorrect: counts }),
      ...(input.meta === undefined ? {} : { meta: input.meta(submission) ?? {} }),
    });
  });

/** Values that appear exactly once in `values` — used to guarantee a fact identifies one player. */
export const uniqueValues = <T extends string | number>(values: readonly T[]): ReadonlySet<T> => {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const unique = new Set<T>();
  for (const [value, count] of counts) if (count === 1) unique.add(value);
  return unique;
};
