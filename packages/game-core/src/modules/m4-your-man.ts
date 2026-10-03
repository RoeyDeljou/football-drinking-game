/**
 * M4 — Your Man (draft) (matchday, `private-card`, live events, `since-round-open` window)
 *
 * Catalog: "Every player is randomly drafted a starter and lives with them all match. Your man
 * fouls/misses/booked = you drink; scores/assists = everyone else drinks."
 *
 * ## Rules
 *
 * - **The draft.** When the round opens, every player in the room is drafted one starter (outfield
 *   only unless `includeGoalkeepers`) from a seeded shuffle: distinct while starters last, then a fresh
 *   shuffled lap. Public — the table knows whose man is whose. No submissions.
 * - **Opened mid-match.** The round's baseline history (`live-window.ts`) is replayed for
 *   substitutions and sendings-off only — never for drinks — so a starter who has already gone off
 *   hands you his replacement straight away.
 * - **What your man does, from the moment the round opened** (per-player feed data: the event's
 *   `playerId`, and `relatedPlayerId` for the assist on a goal):
 *
 *   | his action                              | who drinks        | config        |
 *   |-----------------------------------------|-------------------|---------------|
 *   | commits a foul (`FOUL`)                 | you               | `foulSips`    |
 *   | misses — shot off target, penalty miss  | you               | `missSips`    |
 *   | yellow card                             | you               | `yellowSips`  |
 *   | red / second yellow (and he is off)     | you               | `redSips`     |
 *   | own goal                                | you               | `ownGoalSips` |
 *   | scores (`GOAL`, `PENALTY_SCORED`)       | everyone else     | `goalSips`    |
 *   | assists (`relatedPlayerId` of a goal)   | everyone else     | `assistSips`  |
 *
 *   Reason `ASSIGNED_EVENT_FIRED`, meta `{ action, eventId, footballerId }`; `0` disables a line.
 *   Caps apply as always.
 * - **Substitutions: you inherit the replacement.** "You live with them all match" is about the
 *   slot, not the man: when your man comes off, the player coming on is your man from then on (the
 *   chain is kept for the reveal). A sending-off leaves you with nobody for the rest of the round.
 * - **The round runs to the regulation `FULL_TIME`** (or a host reveal). Opened after full time: void.
 * - **Fairness.** Nothing to do, so nothing to miss. A player who joins mid-round was not drafted
 *   (they still drink with the table when someone's man scores); an owner who left no longer drinks.
 * - **Result.** No points (pure luck). Reveal "winners": the best net record — goals + assists minus
 *   everything that made their owner drink — among drafted players still in the room.
 */

import type { FootballPlayerId, MatchEvent } from '@fdg/football-data';
import { z } from 'zod';
import type { PlayerId } from '../ids.js';
import { asGameModuleId } from '../ids.js';
import type { LiveEventWindow } from '../live-window.js';
import { matchClockSchema } from '../match-events.js';
import type { RoundView } from '../module.js';
import { defineGameModule } from '../module.js';
import type { PenaltyEvent } from '../penalties.js';
import { penalty } from '../penalties.js';
import { footballPlayerIdSchema, pitchPlayers, positionSchema, teamIdSchema } from './helpers.js';
import { orderLiveBatch } from './live-event-kinds.js';

export const M4_ID = asGameModuleId('M4');

export const M4_ACTIONS = ['FOUL', 'MISS', 'YELLOW', 'RED', 'OWN_GOAL', 'GOAL', 'ASSIST'] as const;
export type M4Action = (typeof M4_ACTIONS)[number];

const sips = z.number().int().min(0).max(10);
const configSchema = z
  .object({
    foulSips: sips,
    missSips: sips,
    yellowSips: sips,
    redSips: sips,
    ownGoalSips: sips,
    goalSips: sips,
    assistSips: sips,
    includeGoalkeepers: z.boolean(),
  })
  .strict();

const playerIdSchema = z.string().min(1).transform((value) => value as PlayerId);

const rosterEntrySchema = z
  .object({ footballerId: footballPlayerIdSchema, name: z.string(), teamId: teamIdSchema, position: positionSchema })
  .strict();

const draftEntrySchema = z
  .object({
    playerId: playerIdSchema,
    /** Your man right now; `null` once he has been sent off (or replaced by nobody). */
    current: footballPlayerIdSchema.nullable(),
    /** Every man you have had, in order. */
    chain: z.array(
      z
        .object({
          footballerId: footballPlayerIdSchema,
          via: z.enum(['draft', 'substitution']),
          eventId: z.string().nullable(),
        })
        .strict(),
    ),
    sentOff: z.boolean(),
  })
  .strict();

const logEntrySchema = z
  .object({
    eventId: z.string().min(1),
    action: z.enum(M4_ACTIONS),
    footballerId: footballPlayerIdSchema,
    ownerIds: z.array(playerIdSchema),
    /** `self`: each owner drank; `others`: for each owner, everyone else in the room drank. */
    target: z.enum(['self', 'others']),
    minute: z.number().int().min(0),
    extraMinute: z.number().int().min(0).nullable(),
  })
  .strict();

const publicPayloadSchema = z
  .object({
    kind: z.literal('YOUR_MAN'),
    fixtureId: z.string().min(1),
    homeTeamId: teamIdSchema,
    awayTeamId: teamIdSchema,
    clockKnown: z.boolean(),
    matchClock: matchClockSchema.nullable(),
    sips: z.record(z.enum(M4_ACTIONS), z.number().int().min(0)),
    /** Everyone in the matchday squads (names for the replacements). */
    roster: z.array(rosterEntrySchema),
    draft: z.array(draftEntrySchema),
    log: z.array(logEntrySchema),
  })
  .strict();

const solutionSchema = z
  .object({
    status: z.enum(['running', 'ended', 'void']),
    endedBy: z.enum(['FULL_TIME', 'MATCH_OVER']).nullable(),
  })
  .strict();

const submissionSchema = z.object({}).strict();

interface M4Shape {
  readonly config: z.infer<typeof configSchema>;
  readonly publicPayload: z.infer<typeof publicPayloadSchema>;
  readonly privatePayload: null;
  readonly solution: z.infer<typeof solutionSchema>;
  readonly submission: z.infer<typeof submissionSchema>;
}

export type M4PublicPayload = M4Shape['publicPayload'];
export type M4Solution = M4Shape['solution'];
export type M4DraftEntry = z.infer<typeof draftEntrySchema>;
export type M4LogEntry = z.infer<typeof logEntrySchema>;

/** The M4 config schema, for the host's editor and boundary checks. */
export const M4_CONFIG_SCHEMA = configSchema;

export const M4_DEFAULT_CONFIG: M4Shape['config'] = {
  foulSips: 1,
  missSips: 1,
  yellowSips: 2,
  redSips: 4,
  ownGoalSips: 3,
  goalSips: 2,
  assistSips: 1,
  includeGoalkeepers: false,
};

const GOOD: readonly M4Action[] = ['GOAL', 'ASSIST'];

/** What `event` means for the footballers involved: `[footballer, action]` pairs, in order. */
export const m4ActionsOf = (event: MatchEvent): readonly (readonly [FootballPlayerId, M4Action])[] => {
  const actor = event.playerId;
  if (actor === null) return [];
  switch (event.type) {
    case 'FOUL':
      return [[actor, 'FOUL']];
    case 'SHOT_OFF_TARGET':
    case 'PENALTY_MISSED':
      return [[actor, 'MISS']];
    case 'YELLOW_CARD':
      return [[actor, 'YELLOW']];
    case 'SECOND_YELLOW':
    case 'RED_CARD':
      return [[actor, 'RED']];
    case 'OWN_GOAL':
      return [[actor, 'OWN_GOAL']];
    case 'GOAL':
    case 'PENALTY_SCORED':
      return event.relatedPlayerId === null || event.relatedPlayerId === actor
        ? [[actor, 'GOAL']]
        : [
            [actor, 'GOAL'],
            [event.relatedPlayerId, 'ASSIST'],
          ];
    default:
      return [];
  }
};

/** Substitutions and sendings-off: who each drafted player's man is after `event`. */
const moveMen = (draft: readonly M4DraftEntry[], event: MatchEvent): readonly M4DraftEntry[] => {
  if (event.playerId === null) return draft;
  if (event.type === 'SUBSTITUTION') {
    const on = event.relatedPlayerId;
    return draft.map((entry) =>
      entry.current !== event.playerId
        ? entry
        : {
            ...entry,
            current: on,
            chain: on === null ? entry.chain : [...entry.chain, { footballerId: on, via: 'substitution', eventId: event.id }],
          },
    );
  }
  if (event.type === 'RED_CARD' || event.type === 'SECOND_YELLOW') {
    return draft.map((entry) => (entry.current === event.playerId ? { ...entry, current: null, sentOff: true } : entry));
  }
  return draft;
};

/** Draft one starter per player: a seeded shuffle per lap of the pool. */
export const draftStarters = (
  playerIds: readonly PlayerId[],
  pool: readonly FootballPlayerId[],
  shuffle: <T>(items: readonly T[]) => readonly T[],
): readonly M4DraftEntry[] => {
  const out: M4DraftEntry[] = [];
  let lap: readonly FootballPlayerId[] = [];
  playerIds.forEach((playerId, index) => {
    const at = index % pool.length;
    if (at === 0) lap = shuffle(pool);
    const man = lap[at];
    if (man !== undefined) {
      out.push({ playerId, current: man, chain: [{ footballerId: man, via: 'draft', eventId: null }], sentOff: false });
    }
  });
  return out;
};

type M4Round = Pick<RoundView<M4Shape>, 'liveWindow'>;
const clockFields = (round: M4Round): Pick<M4PublicPayload, 'clockKnown' | 'matchClock'> => {
  const window: LiveEventWindow | null = round.liveWindow;
  const known = window !== null && window.baselineSource !== null;
  return { clockKnown: known, matchClock: known ? window.latest : null };
};

const sipsFor = (config: M4Shape['config']): Record<M4Action, number> => ({
  FOUL: config.foulSips,
  MISS: config.missSips,
  YELLOW: config.yellowSips,
  RED: config.redSips,
  OWN_GOAL: config.ownGoalSips,
  GOAL: config.goalSips,
  ASSIST: config.assistSips,
});

export const m4YourMan = defineGameModule<M4Shape>({
  id: M4_ID,
  category: 'matchday',
  kind: 'private-card',
  dataRequirements: ['hasLineups', 'hasLiveEvents'],
  minPlayers: 1,
  maxPlayers: null,
  allowResubmission: false,
  liveEventWindow: 'since-round-open',
  defaultConfig: M4_DEFAULT_CONFIG,
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
    const everyone = pitchPlayers(ctx.data.lineups, true);
    const pool = everyone
      .filter((entry) => entry.isStarter && (ctx.config.includeGoalkeepers || entry.position !== 'GK'))
      .map((entry) => entry.playerId);
    if (pool.length === 0) return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'no starters to draft' };
    if (ctx.players.length === 0) return { ok: false, reason: 'NOT_ENOUGH_PLAYERS', detail: null };
    let contentKey = `${fixture.id}:your-man:r${ctx.roundIndex + 1}`;
    for (let suffix = 2; ctx.usedContentKeys.includes(contentKey); suffix += 1) {
      contentKey = `${fixture.id}:your-man:r${ctx.roundIndex + 1}-${suffix}`;
    }
    const roster = everyone.map((entry): z.infer<typeof rosterEntrySchema> => ({
      footballerId: entry.playerId,
      name: entry.name,
      teamId: entry.teamId,
      position: entry.position,
    }));
    return {
      ok: true,
      round: {
        publicPayload: {
          kind: 'YOUR_MAN',
          fixtureId: fixture.id,
          homeTeamId: fixture.homeTeam.id,
          awayTeamId: fixture.awayTeam.id,
          clockKnown: false,
          matchClock: null,
          sips: sipsFor(ctx.config),
          roster,
          draft: [...draftStarters(ctx.players.map((player) => player.id), pool, ctx.rng.shuffle)],
          log: [],
        },
        privatePayloads: {},
        solution: { status: 'running', endedBy: null },
        contentKey,
        answerWindowMs: null,
        turnOrder: null,
      },
    };
  },

  validateSubmission: () => ({ ok: false, code: 'NOT_ALLOWED', detail: 'your man takes no submissions' }),

  observeEvents: (ctx) => {
    const payload = ctx.round.publicPayload;
    const base = { privatePayloads: {}, scoreDeltas: [] };
    if (ctx.round.solution.status !== 'running') {
      return { ...base, publicPayload: payload, solution: ctx.round.solution, penalties: [], resolved: true };
    }

    // Baseline: replay the history for substitutions and sendings-off only — nobody drinks for it.
    if (ctx.events.length === 0) {
      const over = ctx.history.some((event) => event.type === 'FULL_TIME');
      const draft = orderLiveBatch(ctx.history).ordered.reduce(moveMen, payload.draft);
      return {
        ...base,
        publicPayload: { ...payload, ...clockFields(ctx.round), draft: [...draft] },
        solution: over ? { status: 'void', endedBy: 'MATCH_OVER' } : ctx.round.solution,
        penalties: [],
        resolved: over,
      };
    }

    const { ordered, fullTime } = orderLiveBatch(ctx.events);
    let draft: readonly M4DraftEntry[] = payload.draft;
    const log: M4LogEntry[] = [...payload.log];
    const penalties: PenaltyEvent[] = [];
    for (const event of ordered) {
      for (const [footballerId, action] of m4ActionsOf(event)) {
        const owners = draft.filter((entry) => entry.current === footballerId).map((entry) => entry.playerId);
        if (owners.length === 0) continue;
        const target = GOOD.includes(action) ? ('others' as const) : ('self' as const);
        log.push({
          eventId: event.id,
          action,
          footballerId,
          ownerIds: owners,
          target,
          minute: event.minute,
          extraMinute: event.extraMinute,
        });
        const amount = payload.sips[action] ?? 0;
        if (amount > 0) {
          for (const ownerId of owners) {
            penalties.push(penalty(ownerId, target, amount, 'ASSIGNED_EVENT_FIRED', { action, eventId: event.id, footballerId }));
          }
        }
      }
      draft = moveMen(draft, event);
    }

    return {
      ...base,
      publicPayload: { ...payload, ...clockFields(ctx.round), draft: [...draft], log },
      solution: fullTime ? { status: 'ended', endedBy: 'FULL_TIME' } : ctx.round.solution,
      penalties,
      resolved: fullTime,
    };
  },

  scoreRound: (ctx) => {
    const payload = ctx.round.publicPayload;
    const tally = (playerId: PlayerId) => {
      const mine = payload.log.filter((entry) => entry.ownerIds.includes(playerId));
      const good = mine.filter((entry) => GOOD.includes(entry.action)).length;
      return { good, bad: mine.length - good, net: good - (mine.length - good) };
    };
    const present = payload.draft.filter((entry) => ctx.players.some((player) => player.id === entry.playerId));
    let winnerIds: PlayerId[] = [];
    if (ctx.round.solution.status !== 'void' && present.length > 0 && payload.log.length > 0) {
      const best = Math.max(...present.map((entry) => tally(entry.playerId).net));
      winnerIds = present.filter((entry) => tally(entry.playerId).net === best).map((entry) => entry.playerId);
    }
    return {
      scores: [],
      winnerIds,
      penalties: [],
      summary: {
        status: ctx.round.solution.status === 'running' ? 'ended' : ctx.round.solution.status,
        endedBy: ctx.round.solution.status === 'running' ? 'HOST' : ctx.round.solution.endedBy,
        players: payload.draft.map((entry) => ({
          playerId: entry.playerId,
          chain: entry.chain.map((link) => link.footballerId),
          sentOff: entry.sentOff,
          ...tally(entry.playerId),
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
