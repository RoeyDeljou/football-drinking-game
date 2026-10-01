/**
 * M9 — Flash Rounds (matchday, `long-running-bet`, live events, `since-round-open` window)
 *
 * **Redesigned (approved):** the catalog's "will this corner produce a shot on target?" cannot work —
 * the feed lags TV by 15–60 s, so by the time the engine sees the corner, anyone watching knows the
 * answer. Flash Rounds are instead short **predictions about the next window of match time**, answered
 * in ~20 s and settled later from the live feed. Nobody can know the answer when asked.
 *
 * ## One round = one question
 *
 * - **Type** (generated): one of `QUESTION_TYPES`, drawn by the seeded RNG from `config.types`, never
 *   the same as the previous round's (so many rounds per match stay varied). Only kinds the feed
 *   emits are used (`live-event-kinds.ts`).
 *
 *   | type               | question                                                   | options              |
 *   |--------------------|------------------------------------------------------------|----------------------|
 *   | `GOAL_IN_WINDOW`   | a goal between `startMinute`' and `endMinute`'?           | YES / NO             |
 *   | `NEXT_GOAL_SIDE`   | the next goal: home, away, or none before `endMinute`'?    | HOME / AWAY / NONE   |
 *   | `NEXT_CARD_SIDE`   | the next card: home, away, or none before `endMinute`'?    | HOME / AWAY / NONE   |
 *   | `CORNERS_OVER`     | more than `line` corners in the window?                    | YES / NO             |
 *   | `TEAM_SHOT_ON_TARGET` | `side` has a shot on target (or scores) in the window?  | YES / NO             |
 *
 * - **The window** is built when the round learns the match clock (its live baseline; at generation
 *   for a round opened before kickoff): `[startMinute, endMinute)` in scoreboard minutes.
 *   - `startMinute` = latest feed minute + `leadMinutes` (default 2): the window starts after the
 *     answers close *even for someone watching TV a minute ahead of the feed*; events between the
 *     feed's "now" and `startMinute` never count. Before kickoff, `startMinute` is 0.
 *   - The length comes from the fixture's **live pace** (history so far blended with a prior worth
 *     45 minutes of a typical match) so answers are not one-sided: e.g. the goal window is the
 *     length with a ~50% chance of a goal (`ln 2 / rate`), jittered ±2' by a pre-drawn seeded number,
 *     and the corners line is the expected count's floor. Pace always comes from events *before*
 *     the question, never after.
 *   - `endMinute` never passes 90 (stoppage is not in any window: the first 90+ event ends it). A
 *     window may span half-time: 45+n is still minute 45, the second half starts at 46.
 *   - Fewer than `MIN_WINDOW_MINUTES` left before 90 → **void** (`NO_WINDOW`).
 * - **Answers** (`{ answer }`, one per player, no changes) are open for `answerWindowMs` from the
 *   moment the question exists (`questionAt` → `answersCloseAt`); before that the round has no
 *   question and refuses answers (`NOT_ALLOWED`/`NO_QUESTION_YET`), after it `ANSWERS_CLOSED`.
 * - **Settles as soon as the outcome is certain**: the first qualifying event inside the window
 *   (a goal → YES / its side; a card → its side; corners beyond the line → YES; the team's shot on
 *   target or goal → YES), else at the window's end (the first event at or past `endMinute`, or the
 *   regulation `FULL_TIME`) with NO / NONE.
 * - **Scoring**: right = points with a speed bonus measured from `questionAt`; wrong = drink roll
 *   (`WRONG_ANSWER`, `wrongAnswerSips` is the on/off switch, as in every quiz); winners = everyone
 *   right. Not answering drinks a roll (`NO_ANSWER`) **only** for a player who had at least
 *   `M9_MIN_ANSWER_MS` of the answer window after joining (an early settle or a late join shortens it).
 * - **Void** (no points, no drinks): opened after full time (`MATCH_OVER`), no window left
 *   (`NO_WINDOW`), or revealed by the host before it settled (`ABANDONED`).
 *
 * Standalone only: a live round waits on the match, so it is not mixable into Shuffle.
 */

import type { MatchEvent } from '@fdg/football-data';
import { z } from 'zod';
import type { PlayerId } from '../ids.js';
import { asGameModuleId } from '../ids.js';
import { initialLiveWindow } from '../live-window.js';
import type { LiveEventWindow } from '../live-window.js';
import { matchClockSchema } from '../match-events.js';
import type { RoundView } from '../module.js';
import { defineGameModule } from '../module.js';
import type { PenaltyEvent } from '../penalties.js';
import { hadAnswerWindow, nonSubmitters, rolledSelfPenalties, teamIdSchema } from './helpers.js';
import { liveEventKindOf, liveEventSideOf, orderLiveBatch, sideSchema } from './live-event-kinds.js';
import { scoreAnswer, scoreNoAnswer } from '../scoring.js';

export const M9_ID = asGameModuleId('M9');

export const QUESTION_TYPES = [
  'GOAL_IN_WINDOW',
  'NEXT_GOAL_SIDE',
  'NEXT_CARD_SIDE',
  'CORNERS_OVER',
  'TEAM_SHOT_ON_TARGET',
] as const;
export type M9QuestionType = (typeof QUESTION_TYPES)[number];
const questionTypeSchema = z.enum(QUESTION_TYPES);

export const ANSWERS = ['YES', 'NO', 'HOME', 'AWAY', 'NONE'] as const;
export type M9Answer = (typeof ANSWERS)[number];
const answerSchema = z.enum(ANSWERS);

/** The last minute a window may reach (exclusive end). */
export const M9_LAST_MINUTE = 90;
/** Shortest window worth asking about. */
export const MIN_WINDOW_MINUTES = 3;
/** Least answer time (after joining) before not answering drinks. */
export const M9_MIN_ANSWER_MS = 5_000;

const configSchema = z
  .object({
    answerWindowMs: z.number().int().min(10_000).max(60_000),
    leadMinutes: z.number().int().min(0).max(5),
    /** On/off switches for the drink roll (see `rollDrinkSips`). */
    wrongAnswerSips: z.number().int().min(0).max(10),
    noAnswerSips: z.number().int().min(0).max(10),
    types: z
      .array(questionTypeSchema)
      .min(1)
      .refine((types) => new Set(types).size === types.length, 'types must be distinct'),
  })
  .strict();

const questionSchema = z
  .object({
    type: questionTypeSchema,
    startMinute: z.number().int().min(0).max(M9_LAST_MINUTE),
    endMinute: z.number().int().min(1).max(M9_LAST_MINUTE),
    options: z.array(answerSchema).min(2),
    /** `CORNERS_OVER`: YES needs more than this many. */
    line: z.number().int().min(0).nullable(),
    /** `TEAM_SHOT_ON_TARGET`: the team asked about. */
    side: sideSchema.nullable(),
  })
  .strict();

const publicPayloadSchema = z
  .object({
    kind: z.literal('FLASH_ROUND'),
    fixtureId: z.string().min(1),
    homeTeamId: teamIdSchema,
    awayTeamId: teamIdSchema,
    questionType: questionTypeSchema,
    /** `null` until the round knows the match clock. */
    question: questionSchema.nullable(),
    questionAt: z.number().nullable(),
    answersCloseAt: z.number().nullable(),
    /** Qualifying events seen inside the window so far (corners for `CORNERS_OVER`, else 0/1). */
    windowCount: z.number().int().min(0),
    clockKnown: z.boolean(),
    matchClock: matchClockSchema.nullable(),
  })
  .strict();

const solutionSchema = z
  .object({
    outcome: z.enum(['pending', 'settled', 'void']),
    answer: answerSchema.nullable(),
    settledBy: z.enum(['EVENT', 'WINDOW_END', 'FULL_TIME']).nullable(),
    eventId: z.string().nullable(),
    voidReason: z.enum(['MATCH_OVER', 'NO_WINDOW']).nullable(),
    settledAt: z.number().nullable(),
    /** Seeded uniform draws taken at generation, used to build the question deterministically. */
    draws: z.array(z.number().min(0).max(1)).length(3),
  })
  .strict();

const submissionSchema = z.object({ answer: answerSchema }).strict();

interface M9Shape {
  readonly config: z.infer<typeof configSchema>;
  readonly publicPayload: z.infer<typeof publicPayloadSchema>;
  readonly privatePayload: null;
  readonly solution: z.infer<typeof solutionSchema>;
  readonly submission: z.infer<typeof submissionSchema>;
}

export type M9PublicPayload = M9Shape['publicPayload'];
export type M9Solution = M9Shape['solution'];
export type M9Question = z.infer<typeof questionSchema>;

export const M9_DEFAULT_CONFIG: M9Shape['config'] = {
  answerWindowMs: 20_000,
  leadMinutes: 2,
  wrongAnswerSips: 2,
  noAnswerSips: 2,
  types: [...QUESTION_TYPES],
};

export const m9ContentKey = (fixtureId: string, type: M9QuestionType, roundNumber: number): string =>
  `${fixtureId}:flash:${type}:r${roundNumber}`;

const typeOfKey = (key: string): M9QuestionType | null => {
  const match = /:flash:([A-Z_]+):r\d+/.exec(key);
  const parsed = questionTypeSchema.safeParse(match?.[1]);
  return parsed.success ? parsed.data : null;
};

/* ---------------------------------- pace ---------------------------------- */

interface Pace {
  readonly elapsed: number;
  readonly goals: number;
  readonly cards: number;
  readonly corners: number;
  readonly shotsOnTarget: { readonly home: number; readonly away: number };
}

/** Prior: 45 minutes of a typical match, blended with what has happened so far. */
const PRIOR_MINUTES = 45;
const PRIOR = { goals: 1.35, cards: 2, corners: 4.5, shotsOnTargetPerTeam: 2 };

const paceOf = (history: readonly MatchEvent[], elapsed: number, homeTeamId: string, awayTeamId: string): Pace => {
  let goals = 0;
  let cards = 0;
  let corners = 0;
  const sot = { home: 0, away: 0 };
  for (const event of history) {
    const kind = liveEventKindOf(event);
    if (kind === 'GOAL') goals += 1;
    if (kind === 'CARD') cards += 1;
    if (kind === 'CORNER') corners += 1;
    if (isTeamShotOnTarget(event)) {
      const side = liveEventSideOf(event, homeTeamId, awayTeamId);
      if (side !== null) sot[side] += 1;
    }
  }
  return { elapsed, goals, cards, corners, shotsOnTarget: sot };
};

const ratePerMinute = (count: number, prior: number, elapsed: number): number =>
  (count + prior) / (elapsed + PRIOR_MINUTES);

/** A shot on target *by* a team: shots on target, saves, and goals (not own goals). */
const isTeamShotOnTarget = (event: MatchEvent): boolean =>
  liveEventKindOf(event) === 'SHOT_ON_TARGET' || event.type === 'GOAL' || event.type === 'PENALTY_SCORED';

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** The window length with ~50% chance of at least one event at this rate. */
const evenOddsMinutes = (rate: number): number => Math.round(Math.LN2 / rate);

/**
 * Build the question for `type` from the pace so far. Pure and deterministic: all randomness comes
 * from `draws` (taken at generation). `null` when there is not enough regulation time left.
 */
export const buildM9Question = (input: {
  readonly type: M9QuestionType;
  readonly draws: readonly number[];
  readonly history: readonly MatchEvent[];
  /** Latest feed minute, or `null` before kickoff. */
  readonly latestMinute: number | null;
  readonly leadMinutes: number;
  readonly homeTeamId: string;
  readonly awayTeamId: string;
}): M9Question | null => {
  const elapsed = input.latestMinute ?? 0;
  const startMinute = input.latestMinute === null ? 0 : input.latestMinute + input.leadMinutes;
  const room = M9_LAST_MINUTE - startMinute;
  if (room < MIN_WINDOW_MINUTES) return null;
  const pace = paceOf(input.history, elapsed, input.homeTeamId, input.awayTeamId);
  const jitter = Math.floor((input.draws[0] ?? 0) * 5) - 2; // -2..+2 minutes
  const length = (min: number, max: number, base: number): number => Math.min(room, clamp(base + jitter, min, max));

  switch (input.type) {
    case 'GOAL_IN_WINDOW': {
      const minutes = length(5, 25, evenOddsMinutes(ratePerMinute(pace.goals, PRIOR.goals, elapsed)));
      return { type: input.type, startMinute, endMinute: startMinute + minutes, options: ['YES', 'NO'], line: null, side: null };
    }
    case 'NEXT_GOAL_SIDE': {
      const minutes = length(8, 30, evenOddsMinutes(ratePerMinute(pace.goals, PRIOR.goals, elapsed)));
      return {
        type: input.type,
        startMinute,
        endMinute: startMinute + minutes,
        options: ['HOME', 'AWAY', 'NONE'],
        line: null,
        side: null,
      };
    }
    case 'NEXT_CARD_SIDE': {
      const minutes = length(8, 30, evenOddsMinutes(ratePerMinute(pace.cards, PRIOR.cards, elapsed)));
      return {
        type: input.type,
        startMinute,
        endMinute: startMinute + minutes,
        options: ['HOME', 'AWAY', 'NONE'],
        line: null,
        side: null,
      };
    }
    case 'CORNERS_OVER': {
      const minutes = length(8, 20, 10);
      const expected = ratePerMinute(pace.corners, PRIOR.corners, elapsed) * minutes;
      return {
        type: input.type,
        startMinute,
        endMinute: startMinute + minutes,
        options: ['YES', 'NO'],
        line: Math.max(0, Math.floor(expected)),
        side: null,
      };
    }
    case 'TEAM_SHOT_ON_TARGET': {
      const side = (input.draws[1] ?? 0) < 0.5 ? 'home' : 'away';
      const minutes = length(3, 20, evenOddsMinutes(ratePerMinute(pace.shotsOnTarget[side], PRIOR.shotsOnTargetPerTeam, elapsed)));
      return { type: input.type, startMinute, endMinute: startMinute + minutes, options: ['YES', 'NO'], line: null, side };
    }
    default: {
      const exhaustive: never = input.type;
      return exhaustive;
    }
  }
};

export interface M9Settlement {
  readonly count: number;
  readonly answer: M9Answer | null;
  readonly settledBy: 'EVENT' | 'WINDOW_END' | 'FULL_TIME' | null;
  readonly eventId: string | null;
}

/**
 * Pure: apply a batch to a question. Events before `startMinute` are the lead zone and never count;
 * the first event at or past `endMinute` (or the batch's regulation `FULL_TIME`) closes the window.
 */
export const settleM9 = (
  question: M9Question,
  count: number,
  events: readonly MatchEvent[],
  homeTeamId: string,
  awayTeamId: string,
): M9Settlement => {
  const { ordered, fullTime } = orderLiveBatch(events);
  let tally = count;
  const noAnswer: M9Answer = question.options.includes('NONE') ? 'NONE' : 'NO';
  for (const event of ordered) {
    if (event.minute >= question.endMinute) return { count: tally, answer: noAnswer, settledBy: 'WINDOW_END', eventId: event.id };
    if (event.minute < question.startMinute) continue;
    const kind = liveEventKindOf(event);
    const side = liveEventSideOf(event, homeTeamId, awayTeamId);
    switch (question.type) {
      case 'GOAL_IN_WINDOW':
        if (kind === 'GOAL') return { count: tally + 1, answer: 'YES', settledBy: 'EVENT', eventId: event.id };
        break;
      case 'NEXT_GOAL_SIDE':
      case 'NEXT_CARD_SIDE':
        if (kind === (question.type === 'NEXT_GOAL_SIDE' ? 'GOAL' : 'CARD') && side !== null) {
          return { count: tally + 1, answer: side === 'home' ? 'HOME' : 'AWAY', settledBy: 'EVENT', eventId: event.id };
        }
        break;
      case 'CORNERS_OVER':
        if (kind === 'CORNER') {
          tally += 1;
          if (tally > (question.line ?? 0)) return { count: tally, answer: 'YES', settledBy: 'EVENT', eventId: event.id };
        }
        break;
      case 'TEAM_SHOT_ON_TARGET':
        if (isTeamShotOnTarget(event) && side === question.side) {
          return { count: tally + 1, answer: 'YES', settledBy: 'EVENT', eventId: event.id };
        }
        break;
      default: {
        const exhaustive: never = question.type;
        return exhaustive;
      }
    }
  }
  return fullTime
    ? { count: tally, answer: noAnswer, settledBy: 'FULL_TIME', eventId: null }
    : { count: tally, answer: null, settledBy: null, eventId: null };
};

type M9Round = Pick<RoundView<M9Shape>, 'liveWindow'>;
const clockFields = (round: M9Round): Pick<M9PublicPayload, 'clockKnown' | 'matchClock'> => {
  const window: LiveEventWindow | null = round.liveWindow;
  const known = window !== null && window.baselineSource !== null;
  return { clockKnown: known, matchClock: known ? window.latest : null };
};

export const m9FlashRounds = defineGameModule<M9Shape>({
  id: M9_ID,
  category: 'matchday',
  kind: 'long-running-bet',
  dataRequirements: ['hasLiveEvents'],
  minPlayers: 1,
  maxPlayers: null,
  allowResubmission: false,
  liveEventWindow: 'since-round-open',
  defaultConfig: M9_DEFAULT_CONFIG,
  configSchema,
  publicPayloadSchema,
  privatePayloadSchema: z.null(),
  solutionSchema,
  submissionSchema,

  generateRound: (ctx) => {
    const fixture = ctx.data.fixture;
    if (fixture === null) return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'no fixture' };
    if (fixture.status === 'FINISHED' || fixture.status === 'CANCELLED') {
      return { ok: false, reason: 'WRONG_ROUND_CONTEXT', detail: `fixture ${fixture.status}` };
    }
    const previousKey = ctx.usedContentKeys[ctx.usedContentKeys.length - 1];
    const previous = previousKey === undefined ? null : typeOfKey(previousKey);
    const candidates = ctx.config.types.length > 1 ? ctx.config.types.filter((type) => type !== previous) : ctx.config.types;
    const type = ctx.rng.pick(candidates) ?? 'GOAL_IN_WINDOW';
    const draws = [ctx.rng.next(), ctx.rng.next(), ctx.rng.next()];

    // Opened before kickoff (the engine will baseline it at build time, by the same rule): the
    // question can be asked right away, from minute 0 at the prior's pace.
    const preKickoff = initialLiveWindow('since-round-open', fixture, ctx.now)?.baselineSource === 'pre-kickoff';
    const question = preKickoff
      ? buildM9Question({
          type,
          draws,
          history: [],
          latestMinute: null,
          leadMinutes: ctx.config.leadMinutes,
          homeTeamId: fixture.homeTeam.id,
          awayTeamId: fixture.awayTeam.id,
        })
      : null;

    let contentKey = m9ContentKey(fixture.id, type, ctx.roundIndex + 1);
    for (let suffix = 2; ctx.usedContentKeys.includes(contentKey); suffix += 1) {
      contentKey = `${m9ContentKey(fixture.id, type, ctx.roundIndex + 1)}-${suffix}`;
    }
    return {
      ok: true,
      round: {
        publicPayload: {
          kind: 'FLASH_ROUND',
          fixtureId: fixture.id,
          homeTeamId: fixture.homeTeam.id,
          awayTeamId: fixture.awayTeam.id,
          questionType: type,
          question,
          questionAt: question === null ? null : ctx.now,
          answersCloseAt: question === null ? null : ctx.now + ctx.config.answerWindowMs,
          windowCount: 0,
          clockKnown: false,
          matchClock: null,
        },
        privatePayloads: {},
        solution: { outcome: 'pending', answer: null, settledBy: null, eventId: null, voidReason: null, settledAt: null, draws },
        contentKey,
        // The answer window runs from the question (see `answersCloseAt`), which may come after the
        // round opens; the round itself runs until the window settles.
        answerWindowMs: null,
        turnOrder: null,
      },
    };
  },

  validateSubmission: (ctx) => {
    const parsed = submissionSchema.safeParse(ctx.raw);
    if (!parsed.success) return { ok: false, code: 'SCHEMA', detail: parsed.error.message };
    const payload = ctx.round.publicPayload;
    if (ctx.round.solution.outcome !== 'pending') return { ok: false, code: 'MARKET_SETTLED', detail: ctx.round.solution.outcome };
    if (payload.question === null || payload.answersCloseAt === null) {
      return { ok: false, code: 'NOT_ALLOWED', detail: 'NO_QUESTION_YET' };
    }
    if (ctx.submittedAt > payload.answersCloseAt) return { ok: false, code: 'NOT_ALLOWED', detail: 'ANSWERS_CLOSED' };
    if (!payload.question.options.includes(parsed.data.answer)) {
      return { ok: false, code: 'UNKNOWN_OPTION', detail: parsed.data.answer };
    }
    return { ok: true, payload: parsed.data };
  },

  observeEvents: (ctx) => {
    const payload = ctx.round.publicPayload;
    const solution = ctx.round.solution;
    const base = { privatePayloads: {}, scoreDeltas: [], penalties: [] };
    if (solution.outcome !== 'pending') return { ...base, publicPayload: payload, solution, resolved: true };
    const withClock = { ...payload, ...clockFields(ctx.round) };
    const voided = (voidReason: 'MATCH_OVER' | 'NO_WINDOW') => ({
      ...base,
      publicPayload: withClock,
      solution: { ...solution, outcome: 'void' as const, voidReason, settledAt: ctx.now },
      resolved: true,
    });

    if (ctx.events.length === 0) {
      if (ctx.history.some((event) => event.type === 'FULL_TIME')) return voided('MATCH_OVER');
      if (payload.question !== null) return { ...base, publicPayload: withClock, solution, resolved: false };
      const question = buildM9Question({
        type: payload.questionType,
        draws: solution.draws,
        history: ctx.history,
        latestMinute: ctx.round.liveWindow?.openedAt?.minute ?? null,
        leadMinutes: ctx.config.leadMinutes,
        homeTeamId: payload.homeTeamId,
        awayTeamId: payload.awayTeamId,
      });
      if (question === null) return voided('NO_WINDOW');
      return {
        ...base,
        publicPayload: { ...withClock, question, questionAt: ctx.now, answersCloseAt: ctx.now + ctx.config.answerWindowMs },
        solution,
        resolved: false,
      };
    }

    if (payload.question === null) return { ...base, publicPayload: withClock, solution, resolved: false };
    const settled = settleM9(payload.question, payload.windowCount, ctx.events, payload.homeTeamId, payload.awayTeamId);
    const publicPayload = { ...withClock, windowCount: settled.count };
    if (settled.answer === null) return { ...base, publicPayload, solution, resolved: false };
    return {
      ...base,
      publicPayload,
      solution: {
        ...solution,
        outcome: 'settled',
        answer: settled.answer,
        settledBy: settled.settledBy,
        eventId: settled.eventId,
        settledAt: ctx.now,
      },
      resolved: true,
    };
  },

  scoreRound: (ctx) => {
    const payload = ctx.round.publicPayload;
    const solution = ctx.round.solution;
    const answers = ctx.submissions.map((submission) => ({ playerId: submission.playerId, answer: submission.payload.answer }));
    if (solution.outcome !== 'settled' || solution.answer === null || payload.questionAt === null) {
      return {
        scores: [],
        winnerIds: [],
        penalties: [],
        summary: {
          outcome: 'void',
          voidReason: solution.outcome === 'void' ? solution.voidReason : 'ABANDONED',
          question: payload.question,
          answer: null,
          answers,
        },
      };
    }
    const questionAt = payload.questionAt;
    const closesAt = Math.min(payload.answersCloseAt ?? questionAt, solution.settledAt ?? Number.POSITIVE_INFINITY);
    const right = (answer: M9Answer): boolean => answer === solution.answer;

    const scores = ctx.players.map((player) => {
      const submission = ctx.submissions.find((entry) => entry.playerId === player.id);
      if (submission === undefined) return scoreNoAnswer({ playerId: player.id, config: ctx.scoring, meta: { answered: false } });
      return scoreAnswer({
        playerId: player.id,
        correct: right(submission.payload.answer),
        elapsedMs: Math.max(0, submission.submittedAt - questionAt),
        windowMs: payload.answersCloseAt === null ? null : payload.answersCloseAt - questionAt,
        streakBefore: player.streak,
        config: ctx.scoring,
        meta: { answer: submission.payload.answer },
      });
    });

    const wrong = ctx.submissions.filter((submission) => !right(submission.payload.answer)).map((submission) => submission.playerId);
    const silent = nonSubmitters<M9Shape>(ctx.players, ctx.submissions).filter((playerId) => {
      const player = ctx.players.find((entry) => entry.id === playerId);
      return player !== undefined && hadAnswerWindow(player, questionAt, closesAt, M9_MIN_ANSWER_MS);
    });
    const penalties: PenaltyEvent[] = [
      ...rolledSelfPenalties(ctx.rng, wrong, 'WRONG_ANSWER', ctx.config.wrongAnswerSips > 0),
      ...rolledSelfPenalties(ctx.rng, silent, 'NO_ANSWER', ctx.config.noAnswerSips > 0),
    ];
    const winnerIds: PlayerId[] = ctx.submissions
      .filter((submission) => right(submission.payload.answer))
      .map((submission) => submission.playerId);

    return {
      scores,
      winnerIds,
      penalties,
      summary: {
        outcome: 'settled',
        voidReason: null,
        question: payload.question,
        answer: solution.answer,
        settledBy: solution.settledBy,
        eventId: solution.eventId,
        windowCount: payload.windowCount,
        answers,
      },
    };
  },

  projectRound: (ctx) => ({
    publicPayload: { ...ctx.round.publicPayload, ...clockFields(ctx.round) },
    privatePayload: null,
    solution: ctx.visibility === 'revealed' ? ctx.round.solution : null,
  }),
});
