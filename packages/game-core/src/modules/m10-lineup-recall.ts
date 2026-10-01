/**
 * M10 — Lineup Recall (matchday, `simultaneous-answer`)
 *
 * Catalog: "name the starting XI from memory, against the clock; one sip per player missed."
 *
 * **Round shape.** One round = one team's confirmed starting XI (so a fixture yields two rounds,
 * home and away, in RNG order; then `NO_UNUSED_CONTENT`). Players see the team, its opponent, the
 * formation and how many starters play in each position line — never a name, id or shirt number —
 * and type up to one name per starter before the window closes, then submit once.
 *
 * **Free text, deliberately — not multiple choice.** A list of names to tick turns *recall* into
 * *recognition* (and any decoy list either leaks the bench or is trivially guessable), which is not
 * the game the catalog describes. Free text is made fair by the engine's pure matcher
 * (`name-matching.ts`): accents/case/punctuation never matter, surnames, compound surnames with or
 * without the particle, mononyms and first names all count, small typos are tolerated by length,
 * and an ambiguous surname never costs a player a name they got (maximum matching). A guess that
 * better matches one of the team's substitutes or an opponent is not credited.
 *
 * **No spamming.** At most one guess per starter (`maxGuesses` = XI size), so listing the whole
 * squad is impossible; a wrong name simply wastes a slot.
 *
 * **Scoring.** `found / XI` is the accuracy factor on the shared scorer, with the speed bonus of the
 * single submission (finish early, score more). Only a perfect XI counts as `correct` for streaks.
 * Winners: everyone with the most names found (> 0); speed only separates their points.
 *
 * **Drinks.** One sip per starter missed (`sipsPerMiss`, fixed — a per-player count, not a drink
 * roll), reason `WRONG_ANSWER` with `meta { missed, found }`. Not submitting misses the whole XI:
 * reason `NO_ANSWER`, `meta { missed }`. The usual per-penalty/per-round caps apply on top (a full
 * miss of 11 is capped to 10 by the defaults).
 *
 * **Leaks.** The public payload carries no footballer data at all; the XI (names, ids, positions)
 * arrives only with the solution at reveal, and it carries no shirt numbers, so a Mixed rotation
 * containing M3 is never spoiled by an M10 reveal.
 */

import type { FixtureLineups, PlayerPosition, Team, TeamId, TeamLineup } from '@fdg/football-data';
import { z } from 'zod';
import type { PlayerId } from '../ids.js';
import { asGameModuleId } from '../ids.js';
import { defineGameModule } from '../module.js';
import type { NameCandidate } from '../name-matching.js';
import { assignGuesses } from '../name-matching.js';
import type { PenaltyEvent } from '../penalties.js';
import { penalty } from '../penalties.js';
import { footballPlayerIdSchema, fairNonSubmitters, positionSchema, scoreChoiceRound, teamIdSchema } from './helpers.js';

export const M10_ID = asGameModuleId('M10');

/** Longest guess accepted, after trimming. */
export const M10_MAX_GUESS_LENGTH = 60;

const configSchema = z
  .object({
    answerWindowMs: z.number().int().min(20_000).max(300_000),
    /** Sips per starter missed; `0` disables the drinks. */
    sipsPerMiss: z.number().int().min(0).max(3),
    /** Allow a projected (unconfirmed) XI. Off by default: a wrong answer key is worse than no round. */
    allowProjectedLineups: z.boolean(),
  })
  .strict();

const teamRefSchema = z
  .object({ teamId: teamIdSchema, name: z.string(), crestUrl: z.string().nullable() })
  .strict();

const shapeSchema = z
  .object({
    GK: z.number().int().min(0),
    DF: z.number().int().min(0),
    MF: z.number().int().min(0),
    FW: z.number().int().min(0),
    UNKNOWN: z.number().int().min(0),
  })
  .strict();

const publicPayloadSchema = z
  .object({
    kind: z.literal('LINEUP_RECALL'),
    fixtureId: z.string().min(1),
    side: z.enum(['home', 'away']),
    team: teamRefSchema,
    opponent: teamRefSchema,
    formation: z.string().nullable(),
    /** Starters to name (normally 11). */
    slots: z.number().int().min(1).max(11),
    /** Starters per position line — a shape hint, no names. */
    shape: shapeSchema,
    /** Most guesses one submission may contain (= `slots`). */
    maxGuesses: z.number().int().min(1).max(11),
  })
  .strict();

const lineupEntrySchema = z
  .object({ playerId: footballPlayerIdSchema, name: z.string().min(1), position: positionSchema })
  .strict();

const solutionSchema = z
  .object({
    teamId: teamIdSchema,
    /** The XI in lineup order. */
    starters: z.array(lineupEntrySchema).min(1).max(11),
    /** Decoys: the team's substitutes and the opponent's matchday squad, so their names are never credited. */
    decoys: z.array(z.object({ playerId: footballPlayerIdSchema, name: z.string().min(1) }).strict()),
  })
  .strict();

const guessSchema = z.string().trim().min(1).max(M10_MAX_GUESS_LENGTH);
const submissionSchema = z.object({ guesses: z.array(guessSchema).min(1).max(11) }).strict();

interface M10Shape {
  readonly config: z.infer<typeof configSchema>;
  readonly publicPayload: z.infer<typeof publicPayloadSchema>;
  readonly privatePayload: null;
  readonly solution: z.infer<typeof solutionSchema>;
  readonly submission: z.infer<typeof submissionSchema>;
}

export type M10PublicPayload = M10Shape['publicPayload'];
export type M10Solution = M10Shape['solution'];
export type M10Submission = M10Shape['submission'];

export const M10_DEFAULT_CONFIG: M10Shape['config'] = {
  answerWindowMs: 90_000,
  sipsPerMiss: 1,
  allowProjectedLineups: false,
};

export const m10ContentKey = (fixtureId: string, teamId: string): string => `${fixtureId}:xi:${teamId}`;

const teamRef = (teamId: TeamId, known: readonly Team[]): z.infer<typeof teamRefSchema> => {
  const team = known.find((candidate) => candidate.id === teamId);
  return { teamId, name: team?.name ?? '', crestUrl: team?.crestUrl ?? null };
};

const shapeOf = (lineup: TeamLineup): z.infer<typeof shapeSchema> => {
  const shape: Record<PlayerPosition, number> = { GK: 0, DF: 0, MF: 0, FW: 0, UNKNOWN: 0 };
  for (const entry of lineup.startingXI) shape[entry.position] += 1;
  return shape;
};

const usableStarters = (lineup: TeamLineup): boolean =>
  lineup.startingXI.length >= 1 &&
  lineup.startingXI.length <= 11 &&
  lineup.startingXI.every((entry) => entry.name.trim().length > 0);

/** The sides whose XI can be played with this config (none without lineups or an allowed XI). */
const usableSides = (
  lineups: FixtureLineups | null,
  config: M10Shape['config'],
): readonly ('home' | 'away')[] =>
  lineups === null || (!lineups.confirmed && !config.allowProjectedLineups)
    ? []
    : (['home', 'away'] as const).filter((side) => usableStarters(lineups[side]));

/** Per-submission grading, shared by scoring and the reveal summary. */
export const gradeLineupGuesses = (
  guesses: readonly string[],
  solution: M10Solution,
): ReturnType<typeof assignGuesses> => {
  const targets: NameCandidate[] = solution.starters.map((entry) => ({ id: entry.playerId, name: entry.name }));
  const decoys: NameCandidate[] = solution.decoys.map((entry) => ({ id: entry.playerId, name: entry.name }));
  return assignGuesses(guesses, targets, decoys);
};

export const m10LineupRecall = defineGameModule<M10Shape>({
  id: M10_ID,
  category: 'matchday',
  kind: 'simultaneous-answer',
  dataRequirements: ['hasLineups'],
  minPlayers: 1,
  maxPlayers: null,
  allowResubmission: false,
  // Two starting XIs per fixture: the session ends after them instead of failing to deal a third…
  maxRoundsPerSession: 2,
  // …or after one, when only one XI is usable (projected lineups, a side with no XI).
  plannedRounds: (ctx) => usableSides(ctx.data.lineups, ctx.config).length,
  defaultConfig: M10_DEFAULT_CONFIG,
  configSchema,
  publicPayloadSchema,
  privatePayloadSchema: z.null(),
  solutionSchema,
  submissionSchema,

  generateRound: (ctx) => {
    const lineups: FixtureLineups | null = ctx.data.lineups;
    if (lineups === null) return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'no lineups' };
    if (!lineups.confirmed && !ctx.config.allowProjectedLineups) {
      return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'lineups not confirmed' };
    }

    const sides = usableSides(lineups, ctx.config);
    if (sides.length === 0) return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'no usable starting XI' };
    const unused = sides.filter(
      (side) => !ctx.usedContentKeys.includes(m10ContentKey(lineups.fixtureId, lineups[side].teamId)),
    );
    const side = ctx.rng.pick(unused);
    if (side === undefined) return { ok: false, reason: 'NO_UNUSED_CONTENT', detail: 'both XIs played' };

    const lineup = lineups[side];
    const opponentLineup = lineups[side === 'home' ? 'away' : 'home'];
    const knownTeams: readonly Team[] = [
      ...ctx.data.teams,
      ...(ctx.data.fixture === null ? [] : [ctx.data.fixture.homeTeam, ctx.data.fixture.awayTeam]),
    ];
    const slots = lineup.startingXI.length;

    return {
      ok: true,
      round: {
        publicPayload: {
          kind: 'LINEUP_RECALL',
          fixtureId: lineups.fixtureId,
          side,
          team: teamRef(lineup.teamId, knownTeams),
          opponent: teamRef(opponentLineup.teamId, knownTeams),
          formation: lineup.formation,
          slots,
          shape: shapeOf(lineup),
          maxGuesses: slots,
        },
        privatePayloads: {},
        solution: {
          teamId: lineup.teamId,
          starters: lineup.startingXI.map((entry) => ({
            playerId: entry.playerId,
            name: entry.name,
            position: entry.position,
          })),
          decoys: [...lineup.substitutes, ...opponentLineup.startingXI, ...opponentLineup.substitutes]
            .filter((entry) => entry.name.trim().length > 0)
            .map((entry) => ({ playerId: entry.playerId, name: entry.name })),
        },
        contentKey: m10ContentKey(lineups.fixtureId, lineup.teamId),
        // Naming eleven players needs longer than a quiz question: the module's own window, not the room's.
        answerWindowMs: ctx.config.answerWindowMs,
        turnOrder: null,
      },
    };
  },

  validateSubmission: (ctx) => {
    const parsed = submissionSchema.safeParse(ctx.raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const code = issue?.code === 'invalid_type' || issue?.code === 'unrecognized_keys' ? 'SCHEMA' : 'OUT_OF_RANGE';
      return { ok: false, code, detail: parsed.error.message };
    }
    const max = ctx.round.publicPayload.maxGuesses;
    if (parsed.data.guesses.length > max) {
      return { ok: false, code: 'OUT_OF_RANGE', detail: `at most ${max} guesses` };
    }
    return { ok: true, payload: parsed.data };
  },

  scoreRound: (ctx) => {
    const solution = ctx.round.solution;
    const slots = solution.starters.length;
    const grades = new Map(
      ctx.submissions.map((submission) => [
        submission.playerId,
        gradeLineupGuesses(submission.payload.guesses, solution),
      ]),
    );
    const foundBy = (playerId: PlayerId): number => grades.get(playerId)?.creditedIds.length ?? 0;

    const scores = scoreChoiceRound<M10Shape>({
      players: ctx.players,
      submissions: ctx.submissions,
      isCorrect: (submission) => foundBy(submission.playerId) > 0,
      accuracyFactor: (submission) => foundBy(submission.playerId) / slots,
      countsAsCorrect: (submission) => foundBy(submission.playerId) === slots,
      meta: (submission) => ({ found: foundBy(submission.playerId), missed: slots - foundBy(submission.playerId) }),
      windowMs: ctx.round.answerWindowMs,
      scoring: ctx.scoring,
    });

    let best = 0;
    for (const submission of ctx.submissions) best = Math.max(best, foundBy(submission.playerId));
    const winnerIds =
      best === 0
        ? []
        : ctx.submissions
            .filter((submission) => foundBy(submission.playerId) === best)
            .map((submission) => submission.playerId);

    const penalties: PenaltyEvent[] = [];
    if (ctx.config.sipsPerMiss > 0) {
      for (const submission of ctx.submissions) {
        const found = foundBy(submission.playerId);
        const missed = slots - found;
        if (missed > 0) {
          penalties.push(
            penalty(submission.playerId, 'self', missed * ctx.config.sipsPerMiss, 'WRONG_ANSWER', { missed, found }),
          );
        }
      }
      for (const playerId of fairNonSubmitters<M10Shape>(ctx.players, ctx.submissions, ctx.round)) {
        penalties.push(penalty(playerId, 'self', slots * ctx.config.sipsPerMiss, 'NO_ANSWER', { missed: slots }));
      }
    }

    return {
      scores,
      winnerIds,
      penalties,
      summary: {
        teamId: solution.teamId,
        slots,
        bestFound: best,
        starters: solution.starters.map((starter) => ({
          playerId: starter.playerId,
          name: starter.name,
          position: starter.position,
          foundBy: ctx.submissions
            .filter((submission) => grades.get(submission.playerId)?.creditedIds.includes(starter.playerId) === true)
            .map((submission) => submission.playerId),
        })),
        players: ctx.submissions.map((submission) => {
          const grade = grades.get(submission.playerId);
          return {
            playerId: submission.playerId,
            found: grade?.creditedIds.length ?? 0,
            guesses: (grade?.results ?? []).map((result) => ({
              guess: result.guess,
              status: result.status,
              playerId: result.targetId,
            })),
          };
        }),
      },
    };
  },

  projectRound: (ctx) => ({
    publicPayload: ctx.round.publicPayload,
    privatePayload: null,
    solution: ctx.visibility === 'revealed' ? ctx.round.solution : null,
  }),
});
