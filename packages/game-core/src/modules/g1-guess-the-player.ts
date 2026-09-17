/**
 * G1 — Guess the Player (general, `simultaneous-answer`)
 *
 * Clues unlock one at a time: nationality → position → age → club history → shirt number. Guess
 * early and you keep more of the base points; every extra clue costs `cluePenalty`.
 *
 * Clue unlocking is derived from the injected clock rather than stored, so it needs no extra
 * action, replays identically, and `projectRound` can never emit a clue the player has not earned.
 */

import { z } from 'zod';
import { asGameModuleId } from '../ids.js';
import { defineGameModule } from '../module.js';
import type { PenaltyEvent } from '../penalties.js';
import { penalty } from '../penalties.js';
import { pickRoundWinners } from '../scoring.js';
import {
  buildOptions,
  footballPlayerIdSchema,
  nonSubmitters,
  positionSchema,
  scoreChoiceRound,
  selfPenalties,
} from './helpers.js';

export const G1_ID = asGameModuleId('G1');

const clueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('NATIONALITY'), value: z.string() }).strict(),
  z.object({ kind: z.literal('POSITION'), value: positionSchema }).strict(),
  z.object({ kind: z.literal('AGE'), value: z.number().int() }).strict(),
  z.object({ kind: z.literal('CAREER'), clubs: z.array(z.string()).min(1) }).strict(),
  z.object({ kind: z.literal('SHIRT_NUMBER'), value: z.number().int() }).strict(),
]);

export type G1Clue = z.infer<typeof clueSchema>;

const optionSchema = z.object({ playerId: footballPlayerIdSchema, name: z.string() }).strict();

const configSchema = z
  .object({
    answerWindowMs: z.number().int().min(5_000).max(300_000),
    clueIntervalMs: z.number().int().min(1_000).max(60_000),
    optionCount: z.number().int().min(2).max(12),
    /** Fraction of the base lost per extra clue revealed. */
    cluePenalty: z.number().min(0).max(0.5),
    minCredit: z.number().min(0).max(1),
    wrongAnswerSips: z.number().int().min(0).max(10),
    noAnswerSips: z.number().int().min(0).max(10),
    /** Sips everyone else owes when somebody solves it on the first clue. */
    firstClueBonusSips: z.number().int().min(0).max(10),
  })
  .strict();

const publicPayloadSchema = z
  .object({
    kind: z.literal('GUESS_PLAYER'),
    clues: z.array(clueSchema).min(1),
    options: z.array(optionSchema).min(2),
    clueIntervalMs: z.number().int(),
  })
  .strict();

const solutionSchema = z
  .object({ playerId: footballPlayerIdSchema, name: z.string(), clueCount: z.number().int() })
  .strict();

const submissionSchema = z.object({ playerId: footballPlayerIdSchema }).strict();

interface G1Shape {
  readonly config: z.infer<typeof configSchema>;
  readonly publicPayload: z.infer<typeof publicPayloadSchema>;
  readonly privatePayload: null;
  readonly solution: z.infer<typeof solutionSchema>;
  readonly submission: z.infer<typeof submissionSchema>;
}

export const G1_DEFAULT_CONFIG: G1Shape['config'] = {
  answerWindowMs: 45_000,
  clueIntervalMs: 8_000,
  optionCount: 4,
  cluePenalty: 0.15,
  minCredit: 0.25,
  wrongAnswerSips: 2,
  noAnswerSips: 3,
  firstClueBonusSips: 1,
};

/** Clues unlocked after `elapsedMs`: one immediately, then one per interval. */
export const visibleClueCount = (elapsedMs: number, clueIntervalMs: number, totalClues: number): number => {
  if (totalClues <= 0) return 0;
  const unlocked = 1 + Math.floor(Math.max(0, elapsedMs) / Math.max(1, clueIntervalMs));
  return Math.min(totalClues, Math.max(1, unlocked));
};

export const g1GuessThePlayer = defineGameModule<G1Shape>({
  id: G1_ID,
  category: 'general',
  kind: 'simultaneous-answer',
  dataRequirements: ['hasCareerHistory'],
  minPlayers: 1,
  maxPlayers: null,
  allowResubmission: false,
  defaultConfig: G1_DEFAULT_CONFIG,
  configSchema,
  publicPayloadSchema,
  privatePayloadSchema: z.null(),
  solutionSchema,
  submissionSchema,

  generateRound: (ctx) => {
    const usable = ctx.data.profiles.filter(
      (profile) =>
        profile.player.nationality !== null && profile.player.age !== null && profile.career.length > 0,
    );
    if (usable.length < ctx.config.optionCount) {
      return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'not enough player profiles' };
    }

    const fresh = usable.filter((profile) => !ctx.usedContentKeys.includes(profile.player.id));
    if (fresh.length === 0) {
      return { ok: false, reason: 'NO_UNUSED_CONTENT', detail: 'every profile already used' };
    }

    const chosen = ctx.rng.pick(fresh);
    if (chosen === undefined) {
      return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'empty pool' };
    }

    const clues: G1Clue[] = [];
    if (chosen.player.nationality !== null) {
      clues.push({ kind: 'NATIONALITY', value: chosen.player.nationality });
    }
    clues.push({ kind: 'POSITION', value: chosen.player.position });
    if (chosen.player.age !== null) clues.push({ kind: 'AGE', value: chosen.player.age });
    clues.push({
      kind: 'CAREER',
      clubs: chosen.career.map((entry) => entry.teamName),
    });
    if (chosen.player.shirtNumber !== null) {
      clues.push({ kind: 'SHIRT_NUMBER', value: chosen.player.shirtNumber });
    }

    const answerOption = { playerId: chosen.player.id, name: chosen.player.name };
    const options = buildOptions(
      answerOption,
      usable.map((profile) => ({ playerId: profile.player.id, name: profile.player.name })),
      ctx.config.optionCount,
      ctx.rng.shuffle,
      (a, b) => a.playerId === b.playerId,
    );

    return {
      ok: true,
      round: {
        publicPayload: {
          kind: 'GUESS_PLAYER',
          clues,
          options: options.slice(),
          clueIntervalMs: ctx.config.clueIntervalMs,
        },
        privatePayloads: {},
        solution: {
          playerId: chosen.player.id,
          name: chosen.player.name,
          clueCount: clues.length,
        },
        contentKey: chosen.player.id,
        answerWindowMs: ctx.config.answerWindowMs,
        turnOrder: null,
      },
    };
  },

  validateSubmission: (ctx) => {
    const parsed = submissionSchema.safeParse(ctx.raw);
    if (!parsed.success) return { ok: false, code: 'SCHEMA', detail: parsed.error.message };
    const known = ctx.round.publicPayload.options.some((option) => option.playerId === parsed.data.playerId);
    if (!known) return { ok: false, code: 'UNKNOWN_OPTION', detail: parsed.data.playerId };
    return { ok: true, payload: parsed.data };
  },

  scoreRound: (ctx) => {
    const answerId = ctx.round.solution.playerId;
    const clueCount = ctx.round.publicPayload.clues.length;
    const cluesUsedBy = (elapsedMs: number): number =>
      visibleClueCount(elapsedMs, ctx.config.clueIntervalMs, clueCount);

    const scores = scoreChoiceRound<G1Shape>({
      players: ctx.players,
      submissions: ctx.submissions,
      isCorrect: (submission) => submission.payload.playerId === answerId,
      accuracyFactor: (submission) =>
        Math.max(ctx.config.minCredit, 1 - (cluesUsedBy(submission.elapsedMs) - 1) * ctx.config.cluePenalty),
      meta: (submission) => ({
        pickedPlayerId: submission.payload.playerId,
        cluesUsed: cluesUsedBy(submission.elapsedMs),
      }),
      windowMs: ctx.round.answerWindowMs,
      scoring: ctx.scoring,
    });

    const correct = ctx.submissions.filter((submission) => submission.payload.playerId === answerId);
    const penalties: PenaltyEvent[] = [
      ...selfPenalties(
        ctx.submissions
          .filter((submission) => submission.payload.playerId !== answerId)
          .map((submission) => submission.playerId),
        ctx.config.wrongAnswerSips,
        'WRONG_ANSWER',
      ),
      ...selfPenalties(
        nonSubmitters<G1Shape>(ctx.players, ctx.submissions),
        ctx.config.noAnswerSips,
        'NO_ANSWER',
      ),
    ];

    for (const submission of correct) {
      if (cluesUsedBy(submission.elapsedMs) === 1 && ctx.config.firstClueBonusSips > 0) {
        penalties.push(
          penalty(submission.playerId, 'others', ctx.config.firstClueBonusSips, 'ROUND_WON', {
            cluesUsed: 1,
          }),
        );
      }
    }

    return {
      scores,
      winnerIds: pickRoundWinners(scores),
      penalties,
      summary: { answerPlayerId: answerId, correctCount: correct.length, clueCount },
    };
  },

  projectRound: (ctx) => {
    const payload = ctx.round.publicPayload;
    if (ctx.visibility === 'revealed') {
      return { publicPayload: payload, privatePayload: null, solution: ctx.round.solution };
    }
    const visible = visibleClueCount(
      ctx.now - ctx.round.startedAt,
      ctx.config.clueIntervalMs,
      payload.clues.length,
    );
    return {
      publicPayload: { ...payload, clues: payload.clues.slice(0, visible) },
      privatePayload: null,
      solution: null,
    };
  },
});
