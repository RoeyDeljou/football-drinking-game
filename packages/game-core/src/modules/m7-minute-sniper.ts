/**
 * M7 — Minute Sniper (matchday, `long-running-bet`, live events, `since-round-open` window)
 *
 * Catalog: "Pick the exact minute of the next goal. Closest wins, furthest from it drinks."
 *
 * ## Round lifecycle
 *
 * 1. **Open.** The round opens at any point of the match. Its live-event window (`live-window.ts`)
 *    gets a baseline: empty if built before the scheduled kickoff, otherwise the first event batch
 *    the transport delivers (the match as it stood at open). The baseline sets the **match clock**
 *    the picks are validated against, and the score at open (`scoreAtOpen`) for the UI.
 * 2. **Picks.** Each player picks one whole minute in `[minPick, 90]`, where `minPick` is one more
 *    than the latest match minute the feed has shown (`1` before kickoff, `46` at half-time). Picks
 *    may be changed until the pick window (`pickWindowMs`, the round's `deadlineAt`) closes. No pick
 *    is accepted until the round has its baseline (`clockKnown`), because until then the engine does
 *    not know what minute it is. Picks stay hidden from rivals until the reveal.
 * 3. **Waiting.** The round stays `open` (so live events keep flowing) after picks close, until the
 *    first **regulation-time goal after the round opened** — `GOAL`, `PENALTY_SCORED` or `OWN_GOAL`
 *    (credited per the provider convention in `match-events.ts`) — or the first `FULL_TIME`.
 * 4. **Settle.** The round resolves itself on that event; the host may also reveal manually.
 *
 * ## Rules chosen for the open questions
 *
 * - **Minute of a goal** is its scoreboard minute without stoppage: `45+2'` counts as **45**,
 *   `90+4'` as **90** (standard minute-market convention). So `45` and `90` are the "stoppage" picks.
 * - **Distance** = `|pick − goal minute|`. Closest pick(s) win (ties share the win); the furthest
 *   pick(s) drink `furthestSips` (reason `DISTANCE_FROM_TARGET`, `meta { distance, furthest: true }`)
 *   — only when there is a spread (≥ 2 pickers and not all tied), so a lone picker never drinks.
 * - **No goal before full time** (regulation `FULL_TIME` first): the round settles as `no-goal` and
 *   is measured against **90** — "it came late" was the closest call. Closest still wins and the
 *   furthest still drinks, but nobody counts as a correct answer for streaks (there was nothing to
 *   snipe). Extra time and shootouts never count; a goal listed after the whistle in the same batch
 *   is ignored.
 * - **Void** (no points, no drinks, streaks untouched): the baseline shows the match already over
 *   (`MATCH_OVER`) or at/after minute 90 with no pickable minute left (`NO_MINUTES_LEFT`) — the
 *   round resolves at once; or the host reveals before any goal or whistle (`ABANDONED`).
 * - **Half-time** needs no special case: the clock sits at 45(+n), so picks start at 46.
 * - **A goal in the same poll as the round opening** is part of the baseline: it happened before
 *   the round as far as the engine can tell (see `live-window.ts`), shows up in `scoreAtOpen`, and
 *   the round waits for the next one.
 * - **Not picking** drinks a drink roll (`NO_ANSWER`, `noAnswerSips` is the on/off switch) — but
 *   only if the pick window had closed before the round settled (a goal 20 seconds after the round
 *   opened does not punish players who were still choosing) **and** the player had at least
 *   `M7_MIN_PICK_WINDOW_MS` of it with a known match clock after joining (`clockKnownAt`): nobody
 *   drinks for a window in which every pick was refused as `MATCH_CLOCK_UNKNOWN`.
 * - **Points**: the shared scorer with accuracy `1 − distance / toleranceMinutes` (no speed bonus:
 *   picking early is not a skill here). Only an exact hit on a real goal counts as `correct`.
 *
 * Known limits, both from the feed: the match clock is the latest *event* minute, so it can trail
 * the real clock by the gap since the last published play; and a goal later ruled out by VAR has
 * already settled the round when the feed withdraws it.
 */

import type { MatchEvent } from '@fdg/football-data';
import { z } from 'zod';
import { asGameModuleId } from '../ids.js';
import type { LiveEventWindow } from '../live-window.js';
import type { MatchClock } from '../match-events.js';
import { clockOf, compareMatchClock, goalCreditedSide, isGoalEvent, matchClockSchema } from '../match-events.js';
import { defineGameModule } from '../module.js';
import type { PenaltyEvent } from '../penalties.js';
import { penalty } from '../penalties.js';
import { footballPlayerIdSchema, hadAnswerWindow, nonSubmitters, rolledSelfPenalties, scoreChoiceRound, teamIdSchema } from './helpers.js';

export const M7_ID = asGameModuleId('M7');

/** The last pickable minute: regulation time, stoppage included (`90+n` counts as 90). */
export const M7_LAST_MINUTE = 90;

const configSchema = z
  .object({
    /** How long picks stay open after the round opens. The round itself runs until it settles. */
    pickWindowMs: z.number().int().min(10_000).max(600_000),
    /** Distance (minutes) at which partial points reach zero. */
    toleranceMinutes: z.number().int().min(1).max(90),
    /** Fixed sips for the furthest pick(s); `0` disables. */
    furthestSips: z.number().int().min(0).max(10),
    /** On/off switch: `0` disables, any positive value enables a drink roll for not picking. */
    noAnswerSips: z.number().int().min(0).max(10),
  })
  .strict();

const scoreSchema = z.object({ home: z.number().int().min(0), away: z.number().int().min(0) }).strict();

const publicPayloadSchema = z
  .object({
    kind: z.literal('MINUTE_SNIPER'),
    fixtureId: z.string().min(1),
    homeTeamId: teamIdSchema,
    awayTeamId: teamIdSchema,
    /** `false` until the round knows the match clock (its live-event baseline); no pick is accepted before. */
    clockKnown: z.boolean(),
    /** Latest match clock the feed has shown; `null` before kickoff or while unknown. */
    matchClock: matchClockSchema.nullable(),
    /** Smallest minute a pick may name right now; `null` while the clock is unknown or no minute is left. */
    minPick: z.number().int().min(1).max(M7_LAST_MINUTE).nullable(),
    maxPick: z.literal(M7_LAST_MINUTE),
    /** Score when the round opened (from its baseline). `null` until known. */
    scoreAtOpen: scoreSchema.nullable(),
    /**
     * Engine time from which picks could be placed (the round learnt the match clock): the round's
     * start when baselined pre-kickoff, else when its baseline batch arrived. `null` = not yet.
     */
    clockKnownAt: z.number().nullable(),
  })
  .strict();

const goalSchema = z
  .object({
    eventId: z.string().min(1),
    type: z.enum(['GOAL', 'PENALTY_SCORED', 'OWN_GOAL']),
    minute: z.number().int().min(0),
    extraMinute: z.number().int().min(0).nullable(),
    /** The team the goal counts for (an own goal counts for the opponent of the event's `teamId`). */
    creditedSide: z.enum(['home', 'away']).nullable(),
    teamId: teamIdSchema.nullable(),
    playerId: footballPlayerIdSchema.nullable(),
    playerName: z.string().nullable(),
  })
  .strict();

const solutionSchema = z
  .object({
    outcome: z.enum(['pending', 'goal', 'no-goal', 'void']),
    voidReason: z.enum(['MATCH_OVER', 'NO_MINUTES_LEFT']).nullable(),
    /** The minute distances are measured to: the goal's minute, or 90 for `no-goal`. */
    targetMinute: z.number().int().min(0).max(M7_LAST_MINUTE).nullable(),
    goal: goalSchema.nullable(),
    /** Engine time the round settled at (for the "pick window had closed" rule). */
    settledAt: z.number().nullable(),
  })
  .strict();

const submissionSchema = z.object({ minute: z.number().int().min(1).max(M7_LAST_MINUTE) }).strict();

interface M7Shape {
  readonly config: z.infer<typeof configSchema>;
  readonly publicPayload: z.infer<typeof publicPayloadSchema>;
  readonly privatePayload: null;
  readonly solution: z.infer<typeof solutionSchema>;
  readonly submission: z.infer<typeof submissionSchema>;
}

export type M7PublicPayload = M7Shape['publicPayload'];
export type M7Solution = M7Shape['solution'];
export type M7Submission = M7Shape['submission'];
export type M7Outcome = M7Solution['outcome'];

/** The M7 config schema, for the host's editor and boundary checks. */
export const M7_CONFIG_SCHEMA = configSchema;

export const M7_DEFAULT_CONFIG: M7Shape['config'] = {
  pickWindowMs: 60_000,
  toleranceMinutes: 15,
  furthestSips: 3,
  noAnswerSips: 2,
};

/** Least usable pick time (after the clock became known and after joining) before not picking drinks. */
export const M7_MIN_PICK_WINDOW_MS = 10_000;

/** When picks became possible: the round start if baselined pre-kickoff, else the stored baseline time. */
const clockKnownSince = (round: {
  readonly startedAt: number;
  readonly liveWindow: LiveEventWindow | null;
  readonly publicPayload: M7PublicPayload;
}): number | null =>
  round.liveWindow?.baselineSource === 'pre-kickoff' ? round.startedAt : round.publicPayload.clockKnownAt;

const PENDING: M7Solution = { outcome: 'pending', voidReason: null, targetMinute: null, goal: null, settledAt: null };

/** The smallest pickable minute after `latest`, or `null` when no minute of regulation is left. */
export const m7MinPick = (latest: MatchClock | null): number | null => {
  const next = latest === null ? 1 : Math.max(1, latest.minute + 1);
  return next > M7_LAST_MINUTE ? null : next;
};

const clockFields = (
  window: LiveEventWindow | null,
): Pick<M7PublicPayload, 'clockKnown' | 'matchClock' | 'minPick'> => {
  const known = window !== null && window.baselineSource !== null;
  const latest = window?.latest ?? null;
  return { clockKnown: known, matchClock: known ? latest : null, minPick: known ? m7MinPick(latest) : null };
};

const scoreOf = (events: readonly MatchEvent[], homeTeamId: string, awayTeamId: string): z.infer<typeof scoreSchema> => {
  let home = 0;
  let away = 0;
  for (const event of events) {
    const side = goalCreditedSide(event, homeTeamId, awayTeamId);
    if (side === 'home') home += 1;
    if (side === 'away') away += 1;
  }
  return { home, away };
};

/**
 * The event that settles a round in this batch: the earliest regulation goal before the batch's
 * first `FULL_TIME` (batch order decides the whistle, clock order decides "earliest"), else that
 * `FULL_TIME`, else nothing.
 */
export const m7SettlingEvent = (
  events: readonly MatchEvent[],
): { readonly kind: 'goal' | 'full-time'; readonly event: MatchEvent } | null => {
  const whistleIndex = events.findIndex((event) => event.type === 'FULL_TIME');
  const beforeWhistle = whistleIndex === -1 ? events : events.slice(0, whistleIndex);
  const goals = beforeWhistle
    .map((event, index) => ({ event, index }))
    .filter((entry) => isGoalEvent(entry.event) && entry.event.minute <= M7_LAST_MINUTE)
    .sort((a, b) => compareMatchClock(clockOf(a.event), clockOf(b.event)) || a.index - b.index);
  const first = goals[0];
  if (first !== undefined) return { kind: 'goal', event: first.event };
  const whistle = whistleIndex === -1 ? undefined : events[whistleIndex];
  return whistle === undefined ? null : { kind: 'full-time', event: whistle };
};

export const m7MinuteSniper = defineGameModule<M7Shape>({
  id: M7_ID,
  category: 'matchday',
  kind: 'long-running-bet',
  dataRequirements: ['hasLiveEvents'],
  minPlayers: 1,
  maxPlayers: null,
  // A pick may be changed while the pick window is open (each change re-validated against the clock).
  allowResubmission: true,
  liveEventWindow: 'since-round-open',
  defaultConfig: M7_DEFAULT_CONFIG,
  configSchema,
  publicPayloadSchema,
  privatePayloadSchema: z.null(),
  solutionSchema,
  submissionSchema,

  generateRound: (ctx) => {
    const fixture = ctx.data.fixture;
    if (fixture === null) return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'no fixture' };
    // POSTPONED is not refused: providers use it for a delayed kickoff or a suspended match, which the
    // live loop keeps watching until play resumes. The live window's baseline handles "already over".
    if (fixture.status === 'FINISHED' || fixture.status === 'CANCELLED') {
      return { ok: false, reason: 'WRONG_ROUND_CONTEXT', detail: `fixture ${fixture.status}` };
    }
    let contentKey = `${fixture.id}:next-goal:r${ctx.roundIndex + 1}`;
    for (let suffix = 2; ctx.usedContentKeys.includes(contentKey); suffix += 1) {
      contentKey = `${fixture.id}:next-goal:r${ctx.roundIndex + 1}-${suffix}`;
    }
    return {
      ok: true,
      round: {
        publicPayload: {
          kind: 'MINUTE_SNIPER',
          fixtureId: fixture.id,
          homeTeamId: fixture.homeTeam.id,
          awayTeamId: fixture.awayTeam.id,
          // The engine sets the round's live window after generation; projection reads it from there.
          clockKnown: false,
          matchClock: null,
          minPick: null,
          maxPick: M7_LAST_MINUTE,
          scoreAtOpen: null,
          clockKnownAt: null,
        },
        privatePayloads: {},
        solution: PENDING,
        contentKey,
        // Closes *picks*; the round itself stays open until a goal or the whistle.
        answerWindowMs: ctx.config.pickWindowMs,
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
    if (ctx.round.solution.outcome !== 'pending') {
      return { ok: false, code: 'MARKET_SETTLED', detail: ctx.round.solution.outcome };
    }
    const clock = clockFields(ctx.round.liveWindow);
    if (!clock.clockKnown) return { ok: false, code: 'NOT_ALLOWED', detail: 'MATCH_CLOCK_UNKNOWN' };
    if (clock.minPick === null) return { ok: false, code: 'NOT_ALLOWED', detail: 'NO_MINUTES_LEFT' };
    if (parsed.data.minute < clock.minPick) {
      return { ok: false, code: 'OUT_OF_RANGE', detail: `minute must be >= ${clock.minPick}` };
    }
    return { ok: true, payload: parsed.data };
  },

  observeEvents: (ctx) => {
    const payload = ctx.round.publicPayload;
    const unchanged = {
      publicPayload: payload,
      solution: ctx.round.solution,
      privatePayloads: {},
      penalties: [],
      scoreDeltas: [],
    };
    if (ctx.round.solution.outcome !== 'pending') return { ...unchanged, resolved: true };

    const clock = clockFields(ctx.round.liveWindow);
    const baselineCall = ctx.events.length === 0;
    const publicPayload: M7PublicPayload = {
      ...payload,
      ...clock,
      scoreAtOpen: baselineCall ? scoreOf(ctx.history, payload.homeTeamId, payload.awayTeamId) : payload.scoreAtOpen,
      clockKnownAt: clockKnownSince(ctx.round) ?? ctx.now,
    };

    if (baselineCall) {
      const over = ctx.history.some((event) => event.type === 'FULL_TIME');
      const voidReason = over ? 'MATCH_OVER' : clock.minPick === null ? 'NO_MINUTES_LEFT' : null;
      if (voidReason === null) return { ...unchanged, publicPayload, resolved: false };
      return {
        ...unchanged,
        publicPayload,
        solution: { ...PENDING, outcome: 'void', voidReason, settledAt: ctx.now },
        resolved: true,
      };
    }

    const settling = m7SettlingEvent(ctx.events);
    if (settling === null) return { ...unchanged, publicPayload, resolved: false };

    if (settling.kind === 'full-time') {
      return {
        ...unchanged,
        publicPayload,
        solution: { ...PENDING, outcome: 'no-goal', targetMinute: M7_LAST_MINUTE, settledAt: ctx.now },
        resolved: true,
      };
    }

    const event = settling.event;
    const type = event.type === 'PENALTY_SCORED' || event.type === 'OWN_GOAL' ? event.type : 'GOAL';
    return {
      ...unchanged,
      publicPayload,
      solution: {
        outcome: 'goal',
        voidReason: null,
        targetMinute: Math.min(Math.max(event.minute, 0), M7_LAST_MINUTE),
        goal: {
          eventId: event.id,
          type,
          minute: event.minute,
          extraMinute: event.extraMinute,
          creditedSide: goalCreditedSide(event, payload.homeTeamId, payload.awayTeamId),
          teamId: event.teamId,
          playerId: event.playerId,
          playerName: event.playerName,
        },
        settledAt: ctx.now,
      },
      resolved: true,
    };
  },

  scoreRound: (ctx) => {
    const solution = ctx.round.solution;
    const target = solution.targetMinute;
    if ((solution.outcome !== 'goal' && solution.outcome !== 'no-goal') || target === null) {
      return {
        scores: [],
        winnerIds: [],
        penalties: [],
        summary: {
          outcome: 'void',
          voidReason: solution.outcome === 'void' ? solution.voidReason : 'ABANDONED',
          targetMinute: null,
          goal: null,
          picks: ctx.submissions.map((submission) => ({
            playerId: submission.playerId,
            minute: submission.payload.minute,
            distance: null,
          })),
        },
      };
    }

    const isGoal = solution.outcome === 'goal';
    const distanceOf = (minute: number): number => Math.abs(minute - target);
    const scores = scoreChoiceRound<M7Shape>({
      players: ctx.players,
      submissions: ctx.submissions,
      isCorrect: (submission) => distanceOf(submission.payload.minute) < ctx.config.toleranceMinutes,
      accuracyFactor: (submission) =>
        Math.max(0, 1 - distanceOf(submission.payload.minute) / ctx.config.toleranceMinutes),
      countsAsCorrect: (submission) => isGoal && distanceOf(submission.payload.minute) === 0,
      meta: (submission) => ({ minute: submission.payload.minute, distance: distanceOf(submission.payload.minute) }),
      windowMs: null,
      scoring: ctx.scoring,
    });

    const distances = ctx.submissions.map((submission) => distanceOf(submission.payload.minute));
    const best = distances.length === 0 ? null : Math.min(...distances);
    const worst = distances.length === 0 ? null : Math.max(...distances);
    const winnerIds =
      best === null
        ? []
        : ctx.submissions.filter((_, index) => distances[index] === best).map((submission) => submission.playerId);

    // Not picking drinks only if the pick window had closed before the round settled AND the player
    // had a real chance to pick: picks are refused until the clock is known, so the usable window runs
    // from the later of "clock known" and joining, to the deadline.
    const penalties: PenaltyEvent[] = [];
    const deadline = ctx.round.deadlineAt;
    const pickWindowClosed = deadline !== null && solution.settledAt !== null && solution.settledAt >= deadline;
    const knownAt = clockKnownSince(ctx.round);
    const silent = pickWindowClosed
      ? nonSubmitters<M7Shape>(ctx.players, ctx.submissions).filter((playerId) => {
          const player = ctx.players.find((entry) => entry.id === playerId);
          return player !== undefined && hadAnswerWindow(player, knownAt, deadline, M7_MIN_PICK_WINDOW_MS);
        })
      : [];
    penalties.push(...rolledSelfPenalties(ctx.rng, silent, 'NO_ANSWER', ctx.config.noAnswerSips > 0));
    if (ctx.config.furthestSips > 0 && best !== null && worst !== null && worst > best) {
      ctx.submissions.forEach((submission, index) => {
        const distance = distances[index];
        if (distance === worst) {
          penalties.push(
            penalty(submission.playerId, 'self', ctx.config.furthestSips, 'DISTANCE_FROM_TARGET', {
              distance,
              furthest: true,
            }),
          );
        }
      });
    }

    return {
      scores,
      winnerIds,
      penalties,
      summary: {
        outcome: solution.outcome,
        voidReason: null,
        targetMinute: target,
        goal: solution.goal,
        bestDistance: best,
        worstDistance: worst,
        picks: ctx.submissions.map((submission, index) => ({
          playerId: submission.playerId,
          minute: submission.payload.minute,
          distance: distances[index] ?? null,
        })),
      },
    };
  },

  projectRound: (ctx) => ({
    // The clock fields are always read from the engine's live window, so they are current even for a
    // round baselined at build time (pre-kickoff), which never receives a baseline observation.
    publicPayload: {
      ...ctx.round.publicPayload,
      ...clockFields(ctx.round.liveWindow),
      scoreAtOpen:
        ctx.round.publicPayload.scoreAtOpen ??
        (ctx.round.liveWindow?.baselineSource === 'pre-kickoff' ? { home: 0, away: 0 } : null),
      clockKnownAt: clockKnownSince(ctx.round),
    },
    privatePayload: null,
    solution: ctx.visibility === 'revealed' ? ctx.round.solution : null,
  }),
});
