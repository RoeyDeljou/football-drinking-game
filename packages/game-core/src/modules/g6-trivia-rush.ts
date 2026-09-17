/**
 * G6 — Trivia Rush (general, `simultaneous-answer`)
 *
 * Rapid-fire multiple choice generated from season data. Kahoot-style speed scoring.
 *
 * Every question is *derived*, never authored: option labels are data values (player names, team
 * names, nationalities), so the engine ships no question text of its own. A question is only
 * emitted when its answer is unambiguous — a "most goals" question with a tied top scorer is
 * discarded rather than served.
 *
 * Pre-reveal the question names its subject by `subjectName` only; the footballer id is withheld
 * until reveal (in the solution) so no id can be joined against player data to shortcut the answer.
 *
 * "Last correct" rule (off by default, see `lastCorrectPlayer`): the slowest correct answer drinks,
 * even when it is the only correct answer — unless that player was the only one who answered.
 */

import type { FootballPlayerId } from '@fdg/football-data';
import { z } from 'zod';
import { asGameModuleId } from '../ids.js';
import { defineGameModule } from '../module.js';
import type { PenaltyEvent } from '../penalties.js';
import { penalty } from '../penalties.js';
import { pickRoundWinners } from '../scoring.js';
import {
  footballPlayerIdSchema,
  lastCorrectPlayer,
  nonSubmitters,
  scoreChoiceRound,
  selfPenalties,
} from './helpers.js';

export const G6_ID = asGameModuleId('G6');

const questionKindSchema = z.enum([
  'MOST_GOALS',
  'MOST_ASSISTS',
  'MOST_APPEARANCES',
  'NATIONALITY_OF',
  'TEAM_OF',
]);

export type G6QuestionKind = z.infer<typeof questionKindSchema>;

const optionSchema = z.object({ id: z.string().min(1), label: z.string() }).strict();

const configSchema = z
  .object({
    answerWindowMs: z.number().int().min(3_000).max(60_000),
    optionCount: z.number().int().min(2).max(6),
    questionKinds: z.array(questionKindSchema).min(1),
    wrongAnswerSips: z.number().int().min(0).max(10),
    noAnswerSips: z.number().int().min(0).max(10),
    lastCorrectSips: z.number().int().min(0).max(10),
  })
  .strict();

const publicPayloadSchema = z
  .object({
    kind: z.literal('TRIVIA'),
    question: z
      .object({
        kind: questionKindSchema,
        subjectName: z.string().nullable(),
      })
      .strict(),
    options: z.array(optionSchema).min(2),
  })
  .strict();

const solutionSchema = z
  .object({
    optionId: z.string().min(1),
    label: z.string(),
    subjectPlayerId: footballPlayerIdSchema.nullable(),
  })
  .strict();

const submissionSchema = z.object({ optionId: z.string().min(1) }).strict();

interface G6Shape {
  readonly config: z.infer<typeof configSchema>;
  readonly publicPayload: z.infer<typeof publicPayloadSchema>;
  readonly privatePayload: null;
  readonly solution: z.infer<typeof solutionSchema>;
  readonly submission: z.infer<typeof submissionSchema>;
}

export const G6_DEFAULT_CONFIG: G6Shape['config'] = {
  answerWindowMs: 12_000,
  optionCount: 4,
  questionKinds: ['MOST_GOALS', 'MOST_ASSISTS', 'MOST_APPEARANCES', 'NATIONALITY_OF', 'TEAM_OF'],
  wrongAnswerSips: 2,
  noAnswerSips: 2,
  lastCorrectSips: 0,
};

interface StatTotals {
  readonly goals: number;
  readonly assists: number;
  readonly appearances: number;
}

interface GeneratedQuestion {
  readonly kind: G6QuestionKind;
  readonly subjectPlayerId: FootballPlayerId | null;
  readonly subjectName: string | null;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly answerId: string;
  readonly answerLabel: string;
  readonly contentKey: string;
}

export const g6TriviaRush = defineGameModule<G6Shape>({
  id: G6_ID,
  category: 'general',
  kind: 'simultaneous-answer',
  dataRequirements: ['hasPlayerSeasonStats'],
  minPlayers: 1,
  maxPlayers: null,
  allowResubmission: false,
  defaultConfig: G6_DEFAULT_CONFIG,
  configSchema,
  publicPayloadSchema,
  privatePayloadSchema: z.null(),
  solutionSchema,
  submissionSchema,

  generateRound: (ctx) => {
    const totals = new Map<FootballPlayerId, StatTotals>();
    for (const stat of ctx.data.seasonStats) {
      const current = totals.get(stat.playerId) ?? { goals: 0, assists: 0, appearances: 0 };
      totals.set(stat.playerId, {
        goals: current.goals + stat.goals,
        assists: current.assists + stat.assists,
        appearances: current.appearances + stat.appearances,
      });
    }

    const teamNames = new Map(ctx.data.teams.map((team) => [team.id, team.name]));
    const optionCount = ctx.config.optionCount;

    const statQuestion = (
      kind: 'MOST_GOALS' | 'MOST_ASSISTS' | 'MOST_APPEARANCES',
      field: keyof StatTotals,
    ): GeneratedQuestion | null => {
      const pool = ctx.data.players.filter((player) => totals.has(player.id));
      if (pool.length < optionCount) return null;
      const picked = ctx.rng.sample(pool, optionCount);
      if (picked.length < optionCount) return null;

      const scored = picked.map((player) => ({
        player,
        value: totals.get(player.id)?.[field] ?? 0,
      }));
      const best = Math.max(...scored.map((entry) => entry.value));
      const leaders = scored.filter((entry) => entry.value === best);
      if (leaders.length !== 1) return null;
      const leader = leaders[0];
      if (leader === undefined) return null;

      return {
        kind,
        subjectPlayerId: null,
        subjectName: null,
        options: picked.map((player) => ({ id: player.id, label: player.name })),
        answerId: leader.player.id,
        answerLabel: leader.player.name,
        contentKey: `${kind}:${picked
          .map((player) => player.id)
          .slice()
          .sort()
          .join('|')}`,
      };
    };

    const attributeQuestion = (kind: 'NATIONALITY_OF' | 'TEAM_OF'): GeneratedQuestion | null => {
      const labelOf = (playerId: FootballPlayerId): { id: string; label: string } | null => {
        const player = ctx.data.players.find((candidate) => candidate.id === playerId);
        if (player === undefined) return null;
        if (kind === 'NATIONALITY_OF') {
          return player.nationality === null ? null : { id: player.nationality, label: player.nationality };
        }
        const name = teamNames.get(player.teamId);
        return name === undefined ? null : { id: player.teamId, label: name };
      };

      const subjects = ctx.data.players.filter((player) => labelOf(player.id) !== null);
      const subject = ctx.rng.pick(subjects);
      if (subject === undefined) return null;
      const answer = labelOf(subject.id);
      if (answer === null) return null;

      const distractorPool = new Map<string, string>();
      for (const player of subjects) {
        const option = labelOf(player.id);
        if (option !== null && option.id !== answer.id) distractorPool.set(option.id, option.label);
      }
      const distractors = ctx.rng
        .sample(
          [...distractorPool.entries()].map(([id, label]) => ({ id, label })),
          optionCount - 1,
        )
        .slice();
      if (distractors.length < optionCount - 1) return null;

      return {
        kind,
        subjectPlayerId: subject.id,
        subjectName: subject.name,
        options: ctx.rng.shuffle([answer, ...distractors]).slice(),
        answerId: answer.id,
        answerLabel: answer.label,
        contentKey: `${kind}:${subject.id}`,
      };
    };

    const kinds = ctx.rng.shuffle(ctx.config.questionKinds);
    for (const kind of kinds) {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const question =
          kind === 'MOST_GOALS'
            ? statQuestion(kind, 'goals')
            : kind === 'MOST_ASSISTS'
              ? statQuestion(kind, 'assists')
              : kind === 'MOST_APPEARANCES'
                ? statQuestion(kind, 'appearances')
                : attributeQuestion(kind);
        if (question === null) continue;
        if (ctx.usedContentKeys.includes(question.contentKey)) continue;

        return {
          ok: true,
          round: {
            publicPayload: {
              kind: 'TRIVIA',
              question: {
                kind: question.kind,
                subjectName: question.subjectName,
              },
              options: question.options.slice(),
            },
            privatePayloads: {},
            solution: {
              optionId: question.answerId,
              label: question.answerLabel,
              subjectPlayerId: question.subjectPlayerId,
            },
            contentKey: question.contentKey,
            answerWindowMs: Math.min(ctx.config.answerWindowMs, ctx.defaultAnswerWindowMs),
            turnOrder: null,
          },
        };
      }
    }

    return {
      ok: false,
      reason: ctx.data.players.length === 0 ? 'INSUFFICIENT_DATA' : 'NO_UNUSED_CONTENT',
      detail: 'no unambiguous unused question could be generated',
    };
  },

  validateSubmission: (ctx) => {
    const parsed = submissionSchema.safeParse(ctx.raw);
    if (!parsed.success) return { ok: false, code: 'SCHEMA', detail: parsed.error.message };
    const known = ctx.round.publicPayload.options.some((option) => option.id === parsed.data.optionId);
    if (!known) return { ok: false, code: 'UNKNOWN_OPTION', detail: parsed.data.optionId };
    return { ok: true, payload: parsed.data };
  },

  scoreRound: (ctx) => {
    const answerId = ctx.round.solution.optionId;
    const isCorrect = (submission: { payload: G6Shape['submission'] }): boolean =>
      submission.payload.optionId === answerId;

    const scores = scoreChoiceRound<G6Shape>({
      players: ctx.players,
      submissions: ctx.submissions,
      isCorrect,
      windowMs: ctx.round.answerWindowMs,
      scoring: ctx.scoring,
      meta: (submission) => ({ pickedOptionId: submission.payload.optionId }),
    });

    const correct = ctx.submissions.filter(isCorrect);
    const penalties: PenaltyEvent[] = [
      ...selfPenalties(
        ctx.submissions
          .filter((submission) => !isCorrect(submission))
          .map((submission) => submission.playerId),
        ctx.config.wrongAnswerSips,
        'WRONG_ANSWER',
      ),
      ...selfPenalties(
        nonSubmitters<G6Shape>(ctx.players, ctx.submissions),
        ctx.config.noAnswerSips,
        'NO_ANSWER',
      ),
    ];

    const slowest = lastCorrectPlayer<G6Shape>(correct, ctx.submissions.length);
    if (slowest !== null && ctx.config.lastCorrectSips > 0) {
      penalties.push(penalty(slowest, 'self', ctx.config.lastCorrectSips, 'LAST_CORRECT', null));
    }

    return {
      scores,
      winnerIds: pickRoundWinners(scores),
      penalties,
      summary: {
        questionKind: ctx.round.publicPayload.question.kind,
        answerOptionId: answerId,
        correctCount: correct.length,
      },
    };
  },

  projectRound: (ctx) => ({
    publicPayload: ctx.round.publicPayload,
    privatePayload: null,
    solution: ctx.visibility === 'revealed' ? ctx.round.solution : null,
  }),
});
