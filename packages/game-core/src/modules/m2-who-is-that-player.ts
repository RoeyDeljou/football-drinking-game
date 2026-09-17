/**
 * M2 — Who's That Player? (matchday, `simultaneous-answer`)
 *
 * One structured fact about a footballer on the pitch; everyone picks which of the 22 it describes.
 * Facts are chosen only when their value is *unique* among the 22, so the round is always solvable.
 *
 * The fact is emitted as `{ kind, value }`, never as a sentence — the client turns
 * `{ kind: 'SEASON_GOALS', value: 12 }` into "has scored 12 league goals this season".
 *
 * Drink mechanic (catalog): wrong = drink; last to answer correctly = drink.
 *
 * "Last correct" rule (see `lastCorrectPlayer`): the slowest correct answer drinks, even when it is
 * the only correct answer — unless that player was the only one who answered at all.
 */

import type { FootballPlayerId } from '@fdg/football-data';
import { z } from 'zod';
import { asGameModuleId } from '../ids.js';
import { defineGameModule } from '../module.js';
import type { PenaltyEvent } from '../penalties.js';
import { penalty } from '../penalties.js';
import { pickRoundWinners } from '../scoring.js';
import type { PitchPlayer } from './helpers.js';
import {
  footballPlayerIdSchema,
  lastCorrectPlayer,
  nonSubmitters,
  pitchPlayerSchema,
  pitchPlayers,
  scoreChoiceRound,
  selfPenalties,
  uniqueValues,
  buildOptions,
} from './helpers.js';

export const M2_ID = asGameModuleId('M2');

const factKindSchema = z.enum([
  'NATIONALITY',
  'AGE',
  'HEIGHT_CM',
  'SEASON_GOALS',
  'SEASON_ASSISTS',
  'SEASON_APPEARANCES',
]);

export type M2FactKind = z.infer<typeof factKindSchema>;

const factSchema = z.object({ kind: factKindSchema, value: z.union([z.string(), z.number()]) }).strict();

const configSchema = z
  .object({
    optionCount: z.number().int().min(2).max(22),
    answerWindowMs: z.number().int().min(3_000).max(120_000),
    factKinds: z.array(factKindSchema).min(1),
    wrongAnswerSips: z.number().int().min(0).max(10),
    noAnswerSips: z.number().int().min(0).max(10),
    lastCorrectSips: z.number().int().min(0).max(10),
  })
  .strict();

const publicPayloadSchema = z
  .object({
    kind: z.literal('WHO_IS_IT'),
    fact: factSchema,
    options: z.array(pitchPlayerSchema).min(2),
  })
  .strict();

const solutionSchema = z
  .object({
    playerId: footballPlayerIdSchema,
    name: z.string(),
    fact: factSchema,
  })
  .strict();

const submissionSchema = z.object({ playerId: footballPlayerIdSchema }).strict();

interface M2Shape {
  readonly config: z.infer<typeof configSchema>;
  readonly publicPayload: z.infer<typeof publicPayloadSchema>;
  readonly privatePayload: null;
  readonly solution: z.infer<typeof solutionSchema>;
  readonly submission: z.infer<typeof submissionSchema>;
}

export const M2_DEFAULT_CONFIG: M2Shape['config'] = {
  optionCount: 6,
  answerWindowMs: 20_000,
  factKinds: ['NATIONALITY', 'AGE', 'HEIGHT_CM', 'SEASON_GOALS', 'SEASON_ASSISTS', 'SEASON_APPEARANCES'],
  wrongAnswerSips: 2,
  noAnswerSips: 2,
  lastCorrectSips: 1,
};

interface FactCandidate {
  readonly playerId: FootballPlayerId;
  readonly name: string;
  readonly kind: M2FactKind;
  readonly value: string | number;
}

/**
 * The `PitchPlayer` field, if any, that each fact kind would trivially leak the answer through if
 * left untouched on the option list (imagine a `SHIRT_NUMBER` fact sitting next to every option's
 * real shirt number). None of today's kinds touch a `PitchPlayer` field, so this is a no-op for all
 * of them — but it is a `Record`, not a `Partial`, so adding a member to `M2FactKind` without
 * deciding this is a compile error rather than a silent leak the day someone adds one that does
 * (e.g. `SHIRT_NUMBER` → `'shirtNumber'`, `POSITION` → `'position'`).
 */
export const FACT_KIND_LEAK_FIELD: Record<M2FactKind, 'shirtNumber' | 'position' | null> = {
  NATIONALITY: null,
  AGE: null,
  HEIGHT_CM: null,
  SEASON_GOALS: null,
  SEASON_ASSISTS: null,
  SEASON_APPEARANCES: null,
};

/** Redacts the leaking field (if any) for `kind` from every option, in place of the real value. */
export const redactOptionsForFact = (
  kind: M2FactKind,
  options: readonly PitchPlayer[],
): readonly PitchPlayer[] => {
  const field = FACT_KIND_LEAK_FIELD[kind];
  if (field === null) return options;
  return options.map((option) =>
    field === 'shirtNumber' ? { ...option, shirtNumber: null } : { ...option, position: 'UNKNOWN' },
  );
};

export const m2WhoIsThatPlayer = defineGameModule<M2Shape>({
  id: M2_ID,
  category: 'matchday',
  kind: 'simultaneous-answer',
  dataRequirements: ['hasLineups', 'hasPlayerSeasonStats'],
  minPlayers: 1,
  maxPlayers: null,
  allowResubmission: false,
  defaultConfig: M2_DEFAULT_CONFIG,
  configSchema,
  publicPayloadSchema,
  privatePayloadSchema: z.null(),
  solutionSchema,
  submissionSchema,

  generateRound: (ctx) => {
    const onThePitch = pitchPlayers(ctx.data.lineups);
    if (onThePitch.length < ctx.config.optionCount) {
      return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'lineups' };
    }

    const bio = new Map(ctx.data.players.map((player) => [player.id, player]));
    const totals = new Map<FootballPlayerId, { goals: number; assists: number; apps: number }>();
    for (const stat of ctx.data.seasonStats) {
      const current = totals.get(stat.playerId) ?? { goals: 0, assists: 0, apps: 0 };
      totals.set(stat.playerId, {
        goals: current.goals + stat.goals,
        assists: current.assists + stat.assists,
        apps: current.apps + stat.appearances,
      });
    }

    const rawValue = (playerId: FootballPlayerId, kind: M2FactKind): string | number | null => {
      const player = bio.get(playerId);
      const total = totals.get(playerId);
      switch (kind) {
        case 'NATIONALITY':
          return player?.nationality ?? null;
        case 'AGE':
          return player?.age ?? null;
        case 'HEIGHT_CM':
          return player?.heightCm ?? null;
        case 'SEASON_GOALS':
          return total?.goals ?? null;
        case 'SEASON_ASSISTS':
          return total?.assists ?? null;
        case 'SEASON_APPEARANCES':
          return total?.apps ?? null;
        default: {
          const exhaustive: never = kind;
          return exhaustive;
        }
      }
    };

    const candidates: FactCandidate[] = [];
    for (const kind of ctx.config.factKinds) {
      const values = onThePitch.map((entry) => rawValue(entry.playerId, kind));
      const defined = values.filter((value): value is string | number => value !== null);
      const unique = uniqueValues(defined);
      for (let index = 0; index < onThePitch.length; index += 1) {
        const entry = onThePitch[index];
        const value = values[index];
        if (entry === undefined || value === null || value === undefined) continue;
        if (!unique.has(value)) continue;
        candidates.push({ playerId: entry.playerId, name: entry.name, kind, value });
      }
    }

    const fresh = candidates.filter(
      (candidate) => !ctx.usedContentKeys.includes(`${candidate.playerId}:${candidate.kind}`),
    );
    if (fresh.length === 0) {
      return {
        ok: false,
        reason: candidates.length === 0 ? 'INSUFFICIENT_DATA' : 'NO_UNUSED_CONTENT',
        detail: 'no uniquely identifying fact available',
      };
    }

    const chosen = ctx.rng.pick(fresh);
    if (chosen === undefined) {
      return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'empty candidate pool' };
    }
    const answer = onThePitch.find((entry) => entry.playerId === chosen.playerId);
    if (answer === undefined) {
      return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'answer not on the pitch' };
    }

    const options = buildOptions(
      answer,
      onThePitch,
      ctx.config.optionCount,
      ctx.rng.shuffle,
      (a, b) => a.playerId === b.playerId,
    );

    return {
      ok: true,
      round: {
        publicPayload: {
          kind: 'WHO_IS_IT',
          fact: { kind: chosen.kind, value: chosen.value },
          options: redactOptionsForFact(chosen.kind, options).slice(),
        },
        privatePayloads: {},
        solution: {
          playerId: chosen.playerId,
          name: chosen.name,
          fact: { kind: chosen.kind, value: chosen.value },
        },
        contentKey: `${chosen.playerId}:${chosen.kind}`,
        answerWindowMs: Math.min(ctx.config.answerWindowMs, ctx.defaultAnswerWindowMs),
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
    const isCorrect = (submission: { payload: M2Shape['submission'] }): boolean =>
      submission.payload.playerId === answerId;

    const scores = scoreChoiceRound<M2Shape>({
      players: ctx.players,
      submissions: ctx.submissions,
      isCorrect,
      windowMs: ctx.round.answerWindowMs,
      scoring: ctx.scoring,
      meta: (submission) => ({ pickedPlayerId: submission.payload.playerId }),
    });

    const correctSubmissions = ctx.submissions.filter(isCorrect);
    const penalties: PenaltyEvent[] = [
      ...selfPenalties(
        ctx.submissions.filter((submission) => !isCorrect(submission)).map((s) => s.playerId),
        ctx.config.wrongAnswerSips,
        'WRONG_ANSWER',
      ),
      ...selfPenalties(
        nonSubmitters<M2Shape>(ctx.players, ctx.submissions),
        ctx.config.noAnswerSips,
        'NO_ANSWER',
      ),
    ];

    const slowest = lastCorrectPlayer<M2Shape>(correctSubmissions, ctx.submissions.length);
    if (slowest !== null && ctx.config.lastCorrectSips > 0) {
      penalties.push(penalty(slowest, 'self', ctx.config.lastCorrectSips, 'LAST_CORRECT', null));
    }

    return {
      scores,
      winnerIds: pickRoundWinners(scores),
      penalties,
      summary: {
        answerPlayerId: ctx.round.solution.playerId,
        correctCount: correctSubmissions.length,
      },
    };
  },

  projectRound: (ctx) => ({
    publicPayload: ctx.round.publicPayload,
    privatePayload: null,
    solution: ctx.visibility === 'revealed' ? ctx.round.solution : null,
  }),
});
