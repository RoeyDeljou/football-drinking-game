/**
 * M5 — Event Roulette (matchday, `private-card`, live events, `since-round-open` window)
 *
 * Catalog: "Each player is dealt a live match event. The event fires = the owner drinks, or everyone
 * else (host toggle)."
 *
 * ## Rules
 *
 * - **The deal.** When the round opens, every player in the room is dealt one event kind from the
 *   config's `eventKinds` (default: corner, offside, foul, card, substitution, shot on target, shot
 *   off target — goals are opt-in because they are rare). Kinds are dealt from a seeded shuffle, so
 *   the deal is distinct while there are at least as many kinds as players; beyond that a fresh
 *   shuffle is dealt for each further "lap" (a kind can then have several owners). Only what the
 *   feed actually emits is dealable (`live-event-kinds.ts`). The deal is **public**: the fun is
 *   watching whose event is coming; there is nothing to hide and nothing to submit.
 * - **The spin lasts `windowMinutes` of match time** from the minute the round opened (its live
 *   baseline; minute 0 when opened before kickoff). Every in-window event of your kind is a *fire*.
 *   The round ends at the first event at or past `startMinute + windowMinutes` (that event does not
 *   count), at the regulation `FULL_TIME`, or when the host reveals it. Half-time needs no special
 *   case: the window is counted in scoreboard minutes (45+3' is still minute 45; the second half
 *   starts at 46), so a spin opened at 40' runs to the first event at 50'.
 * - **A fire drinks at once** (`ASSIGNED_EVENT_FIRED`, `sipsPerFire`, meta
 *   `{ kind, eventId, minute }`): the owner (`drinker: 'owner'`, target `self`) or everyone else in
 *   the room (`drinker: 'others'`, target `others`). A kind with several owners fires once per owner.
 *   The per-penalty/per-round/per-session caps apply as always, so a foul-fest cannot run away.
 * - **Fairness.** No action is ever required, so nobody can miss one. A player who joins mid-round
 *   was not dealt and is never an owner (in `others` mode they drink with the table, like anyone
 *   present); an owner who left no longer drinks (a `self` penalty has no recipient once gone).
 * - **Void**: the round opened after full time (its baseline contains `FULL_TIME`) — resolves at
 *   once, nothing charged.
 * - **Result.** No points (pure chance must not move the quiz leaderboard). "Winners" for the reveal
 *   screen: in `owner` mode the players whose event fired least, in `others` mode the players whose
 *   event fired most (at least once).
 */

import { z } from 'zod';
import type { PlayerId } from '../ids.js';
import { asGameModuleId } from '../ids.js';
import type { LiveEventWindow } from '../live-window.js';
import { matchClockSchema } from '../match-events.js';
import type { RoundView } from '../module.js';
import { defineGameModule } from '../module.js';
import type { PenaltyEvent } from '../penalties.js';
import { penalty } from '../penalties.js';
import { teamIdSchema } from './helpers.js';
import type { LiveEventKind } from './live-event-kinds.js';
import { firedEventSchema, liveEventKindOf, liveEventKindSchema, orderLiveBatch, toFiredEvent } from './live-event-kinds.js';

export const M5_ID = asGameModuleId('M5');

export const M5_DEFAULT_EVENT_KINDS: readonly LiveEventKind[] = [
  'CORNER',
  'OFFSIDE',
  'FOUL',
  'CARD',
  'SUBSTITUTION',
  'SHOT_ON_TARGET',
  'SHOT_OFF_TARGET',
];

const configSchema = z
  .object({
    /** Match minutes one spin lasts. */
    windowMinutes: z.number().int().min(3).max(45),
    /** Host toggle: who drinks when a dealt event fires. */
    drinker: z.enum(['owner', 'others']),
    sipsPerFire: z.number().int().min(1).max(5),
    /** Kinds that can be dealt (distinct). */
    eventKinds: z
      .array(liveEventKindSchema)
      .min(1)
      .refine((kinds) => new Set(kinds).size === kinds.length, 'event kinds must be distinct'),
  })
  .strict();

const playerIdSchema = z.string().min(1).transform((value) => value as PlayerId);

const fireSchema = firedEventSchema.extend({ ownerIds: z.array(playerIdSchema) }).strict();

const publicPayloadSchema = z
  .object({
    kind: z.literal('EVENT_ROULETTE'),
    fixtureId: z.string().min(1),
    homeTeamId: teamIdSchema,
    awayTeamId: teamIdSchema,
    drinker: z.enum(['owner', 'others']),
    sipsPerFire: z.number().int().min(1),
    windowMinutes: z.number().int().min(1),
    /** Scoreboard minute the spin started at; `null` until the round knows the match clock. */
    startMinute: z.number().int().min(0).nullable(),
    /** First minute that ends the spin (`startMinute + windowMinutes`); `null` with `startMinute`. */
    endMinute: z.number().int().min(0).nullable(),
    /** `false` until the round has its live baseline. */
    clockKnown: z.boolean(),
    matchClock: matchClockSchema.nullable(),
    /** Who holds which event. Public. */
    deal: z.array(z.object({ playerId: playerIdSchema, event: liveEventKindSchema }).strict()),
    /** Every fire so far, in match order. */
    fires: z.array(fireSchema),
  })
  .strict();

const solutionSchema = z
  .object({
    status: z.enum(['running', 'ended', 'void']),
    endedBy: z.enum(['WINDOW_END', 'FULL_TIME', 'MATCH_OVER']).nullable(),
  })
  .strict();

/** Nothing to submit: the deal does the playing. */
const submissionSchema = z.object({}).strict();

interface M5Shape {
  readonly config: z.infer<typeof configSchema>;
  readonly publicPayload: z.infer<typeof publicPayloadSchema>;
  readonly privatePayload: null;
  readonly solution: z.infer<typeof solutionSchema>;
  readonly submission: z.infer<typeof submissionSchema>;
}

export type M5PublicPayload = M5Shape['publicPayload'];
export type M5Solution = M5Shape['solution'];
export type M5Fire = z.infer<typeof fireSchema>;

export const M5_DEFAULT_CONFIG: M5Shape['config'] = {
  windowMinutes: 10,
  drinker: 'owner',
  sipsPerFire: 1,
  eventKinds: [...M5_DEFAULT_EVENT_KINDS],
};

type M5Round = Pick<RoundView<M5Shape>, 'liveWindow' | 'publicPayload'>;

/** The spin's first minute: stored at baseline; 0 for a round baselined before kickoff. */
const startMinuteOf = (round: M5Round): number | null =>
  round.publicPayload.startMinute ?? (round.liveWindow?.baselineSource === 'pre-kickoff' ? 0 : null);

const clockFields = (
  round: M5Round,
): Pick<M5PublicPayload, 'clockKnown' | 'matchClock' | 'startMinute' | 'endMinute'> => {
  const window: LiveEventWindow | null = round.liveWindow;
  const known = window !== null && window.baselineSource !== null;
  const start = startMinuteOf(round);
  return {
    clockKnown: known,
    matchClock: known ? window.latest : null,
    startMinute: start,
    endMinute: start === null ? null : start + round.publicPayload.windowMinutes,
  };
};

/** Deal one kind per player: a seeded shuffle per lap of the kind list. */
export const dealEventKinds = (
  playerIds: readonly PlayerId[],
  kinds: readonly LiveEventKind[],
  shuffle: <T>(items: readonly T[]) => readonly T[],
): readonly { readonly playerId: PlayerId; readonly event: LiveEventKind }[] => {
  const out: { playerId: PlayerId; event: LiveEventKind }[] = [];
  let lap: readonly LiveEventKind[] = [];
  playerIds.forEach((playerId, index) => {
    const at = index % kinds.length;
    if (at === 0) lap = shuffle(kinds);
    const event = lap[at];
    if (event !== undefined) out.push({ playerId, event });
  });
  return out;
};

export const m5EventRoulette = defineGameModule<M5Shape>({
  id: M5_ID,
  category: 'matchday',
  kind: 'private-card',
  dataRequirements: ['hasLiveEvents'],
  minPlayers: 1,
  maxPlayers: null,
  allowResubmission: false,
  liveEventWindow: 'since-round-open',
  defaultConfig: M5_DEFAULT_CONFIG,
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
    if (ctx.players.length === 0) return { ok: false, reason: 'NOT_ENOUGH_PLAYERS', detail: null };
    let contentKey = `${fixture.id}:roulette:r${ctx.roundIndex + 1}`;
    for (let suffix = 2; ctx.usedContentKeys.includes(contentKey); suffix += 1) {
      contentKey = `${fixture.id}:roulette:r${ctx.roundIndex + 1}-${suffix}`;
    }
    return {
      ok: true,
      round: {
        publicPayload: {
          kind: 'EVENT_ROULETTE',
          fixtureId: fixture.id,
          homeTeamId: fixture.homeTeam.id,
          awayTeamId: fixture.awayTeam.id,
          drinker: ctx.config.drinker,
          sipsPerFire: ctx.config.sipsPerFire,
          windowMinutes: ctx.config.windowMinutes,
          startMinute: null,
          endMinute: null,
          clockKnown: false,
          matchClock: null,
          deal: [...dealEventKinds(ctx.players.map((player) => player.id), ctx.config.eventKinds, ctx.rng.shuffle)],
          fires: [],
        },
        privatePayloads: {},
        solution: { status: 'running', endedBy: null },
        contentKey,
        // No deadline: the spin ends on match time (see observeEvents).
        answerWindowMs: null,
        turnOrder: null,
      },
    };
  },

  validateSubmission: () => ({ ok: false, code: 'NOT_ALLOWED', detail: 'event roulette takes no submissions' }),

  observeEvents: (ctx) => {
    const payload = ctx.round.publicPayload;
    const base = { privatePayloads: {}, scoreDeltas: [] };
    if (ctx.round.solution.status !== 'running') {
      return { ...base, publicPayload: payload, solution: ctx.round.solution, penalties: [], resolved: true };
    }

    // Baseline call: learn the start minute; a match already over voids the spin.
    if (ctx.events.length === 0) {
      const startMinute = ctx.round.liveWindow?.openedAt?.minute ?? 0;
      const publicPayload = { ...payload, ...clockFields({ ...ctx.round, publicPayload: { ...payload, startMinute } }) };
      const over = ctx.history.some((event) => event.type === 'FULL_TIME');
      return {
        ...base,
        publicPayload,
        solution: over ? { status: 'void', endedBy: 'MATCH_OVER' } : ctx.round.solution,
        penalties: [],
        resolved: over,
      };
    }

    const start = startMinuteOf(ctx.round) ?? 0;
    const end = start + payload.windowMinutes;
    const { ordered, fullTime } = orderLiveBatch(ctx.events);
    const fires: M5Fire[] = [...payload.fires];
    const penalties: PenaltyEvent[] = [];
    let endedBy: M5Solution['endedBy'] = null;

    for (const event of ordered) {
      if (event.minute >= end) {
        endedBy = 'WINDOW_END';
        break;
      }
      const kind = liveEventKindOf(event);
      if (kind === null) continue;
      const owners = payload.deal.filter((entry) => entry.event === kind).map((entry) => entry.playerId);
      if (owners.length === 0) continue;
      fires.push({ ...toFiredEvent(event, kind, payload.homeTeamId, payload.awayTeamId), ownerIds: owners });
      for (const ownerId of owners) {
        penalties.push(
          penalty(ownerId, payload.drinker === 'owner' ? 'self' : 'others', payload.sipsPerFire, 'ASSIGNED_EVENT_FIRED', {
            kind,
            eventId: event.id,
            minute: event.minute,
          }),
        );
      }
    }
    if (endedBy === null && fullTime) endedBy = 'FULL_TIME';

    return {
      ...base,
      publicPayload: { ...payload, ...clockFields({ ...ctx.round, publicPayload: { ...payload, startMinute: start } }), fires },
      solution: endedBy === null ? ctx.round.solution : { status: 'ended', endedBy },
      penalties,
      resolved: endedBy !== null,
    };
  },

  scoreRound: (ctx) => {
    const payload = ctx.round.publicPayload;
    const firesFor = (playerId: PlayerId): number =>
      payload.fires.filter((fire) => fire.ownerIds.includes(playerId)).length;
    const present = payload.deal.filter((entry) => ctx.players.some((player) => player.id === entry.playerId));
    const counts = present.map((entry) => firesFor(entry.playerId));
    let winnerIds: PlayerId[] = [];
    if (ctx.round.solution.status !== 'void' && present.length > 0) {
      const target = payload.drinker === 'owner' ? Math.min(...counts) : Math.max(...counts);
      if (payload.drinker === 'owner' || target > 0) {
        winnerIds = present.filter((_, index) => counts[index] === target).map((entry) => entry.playerId);
      }
    }
    return {
      scores: [],
      winnerIds,
      // Every fire already drank mid-round; the reveal charges nothing more.
      penalties: [],
      summary: {
        status: ctx.round.solution.status === 'running' ? 'ended' : ctx.round.solution.status,
        endedBy: ctx.round.solution.status === 'running' ? 'HOST' : ctx.round.solution.endedBy,
        drinker: payload.drinker,
        startMinute: startMinuteOf(ctx.round),
        endMinute: clockFields(ctx.round).endMinute,
        totalFires: payload.fires.length,
        players: payload.deal.map((entry) => ({
          playerId: entry.playerId,
          event: entry.event,
          fires: firesFor(entry.playerId),
        })),
      },
    };
  },

  projectRound: (ctx) => ({
    publicPayload: { ...ctx.round.publicPayload, ...clockFields(ctx.round) },
    privatePayload: null,
    solution: ctx.visibility === 'revealed' ? ctx.round.solution : null,
  }),
});
