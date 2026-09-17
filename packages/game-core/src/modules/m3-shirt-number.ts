/**
 * M3 — Shirt Number (matchday, `simultaneous-answer`)
 *
 * Guess a pitch player's squad number. Closest wins; you drink the distance, capped.
 *
 * Two deliberate rules:
 *  - only an exact guess counts as `correct` (so streaks mean "nailed it"), while near misses still
 *    earn partial points through `accuracyFactor` — without the streak multiplier, and a near miss
 *    breaks the streak;
 *  - the winner is decided by *distance*, not by points, so a slow perfect guess still ties with a
 *    fast perfect guess. Every player on the minimum distance shares the win.
 *
 * The public target carries no footballer id and no shirt number: an id could be joined against
 * lineup data to read the number off. The UI renders the target from name, team and position; the
 * id arrives with the solution at reveal.
 */

import { z } from 'zod';
import { asGameModuleId } from '../ids.js';
import { defineGameModule } from '../module.js';
import type { PenaltyEvent } from '../penalties.js';
import { penalty } from '../penalties.js';
import {
  footballPlayerIdSchema,
  nonSubmitters,
  pitchPlayers,
  positionSchema,
  scoreChoiceRound,
  selfPenalties,
  teamIdSchema,
} from './helpers.js';

export const M3_ID = asGameModuleId('M3');

const configSchema = z
  .object({
    answerWindowMs: z.number().int().min(3_000).max(120_000),
    /** Distance at which partial credit reaches zero. */
    toleranceRange: z.number().int().min(1).max(99),
    maxDistanceSips: z.number().int().min(0).max(10),
    noAnswerSips: z.number().int().min(0).max(10),
    includeSubstitutes: z.boolean(),
  })
  .strict();

const publicPayloadSchema = z
  .object({
    kind: z.literal('SHIRT_NUMBER'),
    target: z
      .object({
        name: z.string(),
        teamId: teamIdSchema,
        position: positionSchema,
        isStarter: z.boolean(),
      })
      .strict(),
  })
  .strict();

const solutionSchema = z
  .object({ playerId: footballPlayerIdSchema, shirtNumber: z.number().int().min(1).max(99) })
  .strict();

const submissionSchema = z.object({ guess: z.number().int().min(1).max(99) }).strict();

interface M3Shape {
  readonly config: z.infer<typeof configSchema>;
  readonly publicPayload: z.infer<typeof publicPayloadSchema>;
  readonly privatePayload: null;
  readonly solution: z.infer<typeof solutionSchema>;
  readonly submission: z.infer<typeof submissionSchema>;
}

export const M3_DEFAULT_CONFIG: M3Shape['config'] = {
  answerWindowMs: 15_000,
  toleranceRange: 10,
  maxDistanceSips: 5,
  noAnswerSips: 5,
  includeSubstitutes: false,
};

export const m3ShirtNumber = defineGameModule<M3Shape>({
  id: M3_ID,
  category: 'matchday',
  kind: 'simultaneous-answer',
  dataRequirements: ['hasLineups', 'hasShirtNumbers'],
  minPlayers: 1,
  maxPlayers: null,
  allowResubmission: false,
  defaultConfig: M3_DEFAULT_CONFIG,
  configSchema,
  publicPayloadSchema,
  privatePayloadSchema: z.null(),
  solutionSchema,
  submissionSchema,

  generateRound: (ctx) => {
    const candidates = pitchPlayers(ctx.data.lineups, ctx.config.includeSubstitutes).filter(
      (entry) =>
        entry.shirtNumber !== null &&
        entry.shirtNumber >= 1 &&
        entry.shirtNumber <= 99 &&
        !ctx.usedContentKeys.includes(entry.playerId),
    );
    if (candidates.length === 0) {
      return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'no shirt numbers available' };
    }

    const target = ctx.rng.pick(candidates);
    if (target === undefined || target.shirtNumber === null) {
      return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'no target' };
    }

    return {
      ok: true,
      round: {
        publicPayload: {
          kind: 'SHIRT_NUMBER',
          // Neither the number nor the footballer id: either would give the answer away.
          target: {
            name: target.name,
            teamId: target.teamId,
            position: target.position,
            isStarter: target.isStarter,
          },
        },
        privatePayloads: {},
        solution: { playerId: target.playerId, shirtNumber: target.shirtNumber },
        contentKey: target.playerId,
        answerWindowMs: Math.min(ctx.config.answerWindowMs, ctx.defaultAnswerWindowMs),
        turnOrder: null,
      },
    };
  },

  validateSubmission: (ctx) => {
    const parsed = submissionSchema.safeParse(ctx.raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const code = issue?.code === 'invalid_type' ? 'SCHEMA' : 'OUT_OF_RANGE';
      return { ok: false, code, detail: parsed.error.message };
    }
    return { ok: true, payload: parsed.data };
  },

  scoreRound: (ctx) => {
    const answer = ctx.round.solution.shirtNumber;
    const distanceOf = (guess: number): number => Math.abs(guess - answer);

    const scores = scoreChoiceRound<M3Shape>({
      players: ctx.players,
      submissions: ctx.submissions,
      // Every guess earns something inside the tolerance range, so `isCorrect` gates the points…
      isCorrect: (submission) => distanceOf(submission.payload.guess) < ctx.config.toleranceRange,
      accuracyFactor: (submission) =>
        Math.max(0, 1 - distanceOf(submission.payload.guess) / ctx.config.toleranceRange),
      // …while only an exact hit counts as a correct answer for streaks.
      countsAsCorrect: (submission) => distanceOf(submission.payload.guess) === 0,
      meta: (submission) => ({
        guess: submission.payload.guess,
        distance: distanceOf(submission.payload.guess),
      }),
      windowMs: ctx.round.answerWindowMs,
      scoring: ctx.scoring,
    });

    let bestDistance: number | null = null;
    for (const submission of ctx.submissions) {
      const distance = distanceOf(submission.payload.guess);
      if (bestDistance === null || distance < bestDistance) bestDistance = distance;
    }
    const winnerIds =
      bestDistance === null
        ? []
        : ctx.submissions
            .filter((submission) => distanceOf(submission.payload.guess) === bestDistance)
            .map((submission) => submission.playerId);

    const penalties: PenaltyEvent[] = [
      ...selfPenalties(
        nonSubmitters<M3Shape>(ctx.players, ctx.submissions),
        ctx.config.noAnswerSips,
        'NO_ANSWER',
      ),
    ];
    for (const submission of ctx.submissions) {
      const distance = distanceOf(submission.payload.guess);
      const sips = Math.min(distance, ctx.config.maxDistanceSips);
      if (sips > 0) {
        penalties.push(penalty(submission.playerId, 'self', sips, 'DISTANCE_FROM_TARGET', { distance }));
      }
    }

    return {
      scores,
      winnerIds,
      penalties,
      summary: {
        shirtNumber: answer,
        playerId: ctx.round.solution.playerId,
        bestDistance: bestDistance ?? -1,
      },
    };
  },

  projectRound: (ctx) => ({
    publicPayload: ctx.round.publicPayload,
    privatePayload: null,
    solution: ctx.visibility === 'revealed' ? ctx.round.solution : null,
  }),
});
