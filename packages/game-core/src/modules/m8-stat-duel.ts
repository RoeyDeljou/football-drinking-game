/**
 * M8 — Stat Duel (matchday, `long-running-bet`, live events + live stats, `since-round-open`)
 *
 * Catalog: "Each player picks a pitch player; head-to-head at full time. Loser of each duel drinks;
 * bracket to a final."
 *
 * ## Stats — only what the feed really has live
 *
 * ESPN's live per-player line has goals, assists, shots, shots on target, fouls committed and minutes;
 * passes, tackles, duels and ratings are `null`. So the duel stats are:
 *
 * | stat                | value                          | better |
 * |---------------------|--------------------------------|--------|
 * | `SHOTS`             | shots                          | more   |
 * | `SHOTS_ON_TARGET`   | shots on target                | more   |
 * | `GOAL_INVOLVEMENTS` | goals + assists                | more   |
 * | `FEWEST_FOULS`      | fouls committed                | fewer  |
 *
 * A `null` stat or a footballer missing from the snapshot counts as 0.
 *
 * ## Rules
 *
 * - **Bracket, fixed at round open.** The players in the room are seeded by a seeded shuffle; each
 *   bracket level gets its duel stat (a shuffle of `stats`, cycling if there are more levels than
 *   stats). Level 1 pairs seeds 1v2, 3v4, …; winners go on in order; an odd player out gets a bye
 *   (the last in order). All public: everyone sees who they may meet and on what.
 * - **Picks (blind).** During the pick window each player picks one **starter** of either team
 *   (`{ footballerId }`), changeable until the window closes; picks are hidden until the reveal. Two
 *   players may pick the same footballer (their duel is then a tie). **Nobody is punished for not
 *   picking:** each player is privately dealt a distinct default starter at round open, used if they
 *   do not pick.
 * - **Stats count from the moment picks lock.** Snapshots are whole-match, so the round keeps a
 *   baseline: the last snapshot received before the pick deadline (all zeros for a round opened before
 *   kickoff), else the first one after it. Duels compare *final − baseline*, so picking the man who
 *   already has five shots buys nothing.
 * - **Subs: raw totals, no per-90.** A pick subbed off early keeps what he did; per-90 scaling would
 *   let a two-minute cameo with one shot win everything. Picking someone who gets hauled off is part
 *   of the gamble (only starters are pickable, so everyone starts on equal footing).
 * - **Settlement:** on the first stats snapshot received after the regulation `FULL_TIME` event. The
 *   whole bracket resolves at once: each level's duels in order, on that level's stat.
 *   - **Ties** go to the next stat in the fixed order shots on target → goal involvements → shots →
 *     fewest fouls (skipping the level's own); a complete tie sends the higher seed through and
 *     **nobody drinks** for that duel.
 *   - **Every duel loser drinks** `duelSips` (`DUEL_LOST`, meta `{ level, stat, opponentId,
 *     value, opponentValue }`), including the final. Caps apply.
 *   - A host reveal before the whistle settles the bracket on the stats so far (a "window end").
 * - **Void** (no points, no drinks): opened after full time, or no stats window at all (the whistle
 *   came before picks locked, or no snapshot arrived to measure from).
 * - **Late joiners** are not in the bracket. A player who left stays in it (a loss simply has nobody
 *   to drink it).
 * - **Points:** accuracy = duels won / levels; `correct` with at least one win; a streak only for the
 *   champion. Winner: the champion.
 */

import type { FootballPlayerId, PlayerMatchStats } from '@fdg/football-data';
import { z } from 'zod';
import type { PlayerId } from '../ids.js';
import { asGameModuleId } from '../ids.js';
import type { LiveEventWindow } from '../live-window.js';
import { matchClockSchema } from '../match-events.js';
import type { RoundView } from '../module.js';
import { defineGameModule } from '../module.js';
import type { PenaltyEvent } from '../penalties.js';
import { penalty } from '../penalties.js';
import type { RoundScore } from '../scoring.js';
import { scoreAnswer } from '../scoring.js';
import { footballPlayerIdSchema, pitchPlayers, positionSchema, teamIdSchema } from './helpers.js';

export const M8_ID = asGameModuleId('M8');

export const M8_STATS = ['SHOTS', 'SHOTS_ON_TARGET', 'GOAL_INVOLVEMENTS', 'FEWEST_FOULS'] as const;
export type M8Stat = (typeof M8_STATS)[number];
const statSchema = z.enum(M8_STATS);

/** Tie-break order after the duel's own stat. */
export const M8_TIEBREAK_ORDER: readonly M8Stat[] = ['SHOTS_ON_TARGET', 'GOAL_INVOLVEMENTS', 'SHOTS', 'FEWEST_FOULS'];

const configSchema = z
  .object({
    pickWindowMs: z.number().int().min(10_000).max(600_000),
    duelSips: z.number().int().min(0).max(10),
    stats: z
      .array(statSchema)
      .min(1)
      .refine((stats) => new Set(stats).size === stats.length, 'stats must be distinct'),
  })
  .strict();

const playerIdSchema = z.string().min(1).transform((value) => value as PlayerId);

const optionSchema = z
  .object({ footballerId: footballPlayerIdSchema, name: z.string(), teamId: teamIdSchema, position: positionSchema })
  .strict();

const publicPayloadSchema = z
  .object({
    kind: z.literal('STAT_DUEL'),
    fixtureId: z.string().min(1),
    homeTeamId: teamIdSchema,
    awayTeamId: teamIdSchema,
    duelSips: z.number().int().min(0),
    /** Pickable starters. */
    options: z.array(optionSchema).min(1),
    /** Bracket seeds, in order (1v2, 3v4, …). */
    seeds: z.array(playerIdSchema).min(2),
    /** Duel stat per bracket level (index 0 = first round). */
    levelStats: z.array(statSchema).min(1),
    clockKnown: z.boolean(),
    matchClock: matchClockSchema.nullable(),
    /** `true` once the regulation whistle has been seen; settles on the next stats snapshot. */
    whistle: z.boolean(),
  })
  .strict();

/** Each player's private default pick, used if they do not pick. */
const privatePayloadSchema = z.object({ defaultPick: footballPlayerIdSchema }).strict();

const statRowSchema = z
  .object({
    footballerId: footballPlayerIdSchema,
    shots: z.number().int().min(0),
    shotsOnTarget: z.number().int().min(0),
    goalInvolvements: z.number().int().min(0),
    fouls: z.number().int().min(0),
    minutes: z.number().int().min(0).nullable(),
  })
  .strict();

const snapshotSchema = z
  .object({ asOf: z.number(), receivedAt: z.number(), rows: z.array(statRowSchema) })
  .strict();

const solutionSchema = z
  .object({
    status: z.enum(['running', 'settled', 'void']),
    endedBy: z.enum(['FULL_TIME', 'MATCH_OVER', 'NO_PLAY']).nullable(),
    /** Stats the duels are measured from (picks locked). */
    baseline: snapshotSchema.nullable(),
    /** The latest snapshot received. */
    latest: snapshotSchema.nullable(),
  })
  .strict();

const submissionSchema = z.object({ footballerId: footballPlayerIdSchema }).strict();

interface M8Shape {
  readonly config: z.infer<typeof configSchema>;
  readonly publicPayload: z.infer<typeof publicPayloadSchema>;
  readonly privatePayload: z.infer<typeof privatePayloadSchema>;
  readonly solution: z.infer<typeof solutionSchema>;
  readonly submission: z.infer<typeof submissionSchema>;
}

export type M8PublicPayload = M8Shape['publicPayload'];
export type M8Solution = M8Shape['solution'];
export type M8StatRow = z.infer<typeof statRowSchema>;
type Snapshot = z.infer<typeof snapshotSchema>;

export const M8_DEFAULT_CONFIG: M8Shape['config'] = {
  pickWindowMs: 90_000,
  duelSips: 2,
  stats: [...M8_STATS],
};

const toRow = (stats: PlayerMatchStats): M8StatRow => ({
  footballerId: stats.playerId,
  shots: stats.shots ?? 0,
  shotsOnTarget: stats.shotsOnTarget ?? 0,
  goalInvolvements: stats.goals + stats.assists,
  fouls: stats.foulsCommitted ?? 0,
  minutes: stats.minutesPlayed,
});

const rowOf = (snapshot: Snapshot | null, footballerId: FootballPlayerId): M8StatRow | undefined =>
  snapshot?.rows.find((row) => row.footballerId === footballerId);

const RAW: Readonly<Record<M8Stat, (row: M8StatRow) => number>> = {
  SHOTS: (row) => row.shots,
  SHOTS_ON_TARGET: (row) => row.shotsOnTarget,
  GOAL_INVOLVEMENTS: (row) => row.goalInvolvements,
  FEWEST_FOULS: (row) => row.fouls,
};

/** A footballer's stat between two snapshots (missing = 0, never negative). */
export const m8StatValue = (stat: M8Stat, footballerId: FootballPlayerId, from: Snapshot | null, to: Snapshot | null): number => {
  const end = rowOf(to, footballerId);
  const start = rowOf(from, footballerId);
  return Math.max(0, (end === undefined ? 0 : RAW[stat](end)) - (start === undefined ? 0 : RAW[stat](start)));
};

/** Positive when `a` beats `b` on `stat` (fewer fouls is better). */
const better = (stat: M8Stat, a: number, b: number): number => (stat === 'FEWEST_FOULS' ? b - a : a - b);

export interface M8Duel {
  readonly level: number;
  readonly stat: M8Stat;
  readonly playerA: PlayerId;
  readonly playerB: PlayerId;
  readonly valueA: number;
  readonly valueB: number;
  /** The stat that decided it (the level's own, a tie-breaker), or `null` for a complete tie. */
  readonly decidedBy: M8Stat | null;
  readonly winnerId: PlayerId;
  /** `null` for a complete tie: nobody drinks. */
  readonly loserId: PlayerId | null;
}

export interface M8Bracket {
  readonly duels: readonly M8Duel[];
  readonly byes: readonly { readonly level: number; readonly playerId: PlayerId }[];
  readonly championId: PlayerId | null;
  readonly wins: Readonly<Partial<Record<PlayerId, number>>>;
}

/** Pure: play the whole bracket on the stats between `from` and `to`. */
export const playM8Bracket = (
  seeds: readonly PlayerId[],
  levelStats: readonly M8Stat[],
  pickOf: (playerId: PlayerId) => FootballPlayerId,
  from: Snapshot | null,
  to: Snapshot | null,
): M8Bracket => {
  const duels: M8Duel[] = [];
  const byes: { level: number; playerId: PlayerId }[] = [];
  const wins: Partial<Record<PlayerId, number>> = {};
  let alive = [...seeds];
  for (let level = 0; alive.length > 1; level += 1) {
    const stat = levelStats[level % levelStats.length] ?? 'SHOTS';
    const order = [stat, ...M8_TIEBREAK_ORDER.filter((entry) => entry !== stat)];
    const next: PlayerId[] = [];
    for (let index = 0; index < alive.length; index += 2) {
      const a = alive[index];
      const b = alive[index + 1];
      if (a === undefined) continue;
      if (b === undefined) {
        byes.push({ level: level + 1, playerId: a });
        next.push(a);
        continue;
      }
      let decidedBy: M8Stat | null = null;
      let margin = 0;
      for (const candidate of order) {
        margin = better(
          candidate,
          m8StatValue(candidate, pickOf(a), from, to),
          m8StatValue(candidate, pickOf(b), from, to),
        );
        if (margin !== 0) {
          decidedBy = candidate;
          break;
        }
      }
      const winnerId = margin < 0 ? b : a;
      duels.push({
        level: level + 1,
        stat,
        playerA: a,
        playerB: b,
        valueA: m8StatValue(stat, pickOf(a), from, to),
        valueB: m8StatValue(stat, pickOf(b), from, to),
        decidedBy,
        winnerId,
        loserId: decidedBy === null ? null : winnerId === a ? b : a,
      });
      if (decidedBy !== null) wins[winnerId] = (wins[winnerId] ?? 0) + 1;
      next.push(winnerId);
    }
    alive = next;
  }
  return { duels, byes, championId: alive[0] ?? null, wins };
};

type M8Round = Pick<RoundView<M8Shape>, 'liveWindow'>;
const clockFields = (round: M8Round): Pick<M8PublicPayload, 'clockKnown' | 'matchClock'> => {
  const window: LiveEventWindow | null = round.liveWindow;
  const known = window !== null && window.baselineSource !== null;
  return { clockKnown: known, matchClock: known ? window.latest : null };
};

const EMPTY_SNAPSHOT = (at: number): Snapshot => ({ asOf: at, receivedAt: at, rows: [] });

export const m8StatDuel = defineGameModule<M8Shape>({
  id: M8_ID,
  category: 'matchday',
  kind: 'long-running-bet',
  dataRequirements: ['hasLineups', 'hasLiveEvents', 'hasPlayerMatchStats'],
  minPlayers: 2,
  maxPlayers: null,
  allowResubmission: true,
  liveEventWindow: 'since-round-open',
  defaultConfig: M8_DEFAULT_CONFIG,
  configSchema,
  publicPayloadSchema,
  privatePayloadSchema,
  solutionSchema,
  submissionSchema,

  generateRound: (ctx) => {
    const fixture = ctx.data.fixture;
    if (fixture === null) return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'no fixture' };
    if (fixture.status === 'FINISHED' || fixture.status === 'CANCELLED') {
      return { ok: false, reason: 'WRONG_ROUND_CONTEXT', detail: `fixture ${fixture.status}` };
    }
    const starters = pitchPlayers(ctx.data.lineups).filter((entry) => entry.isStarter);
    if (starters.length === 0) return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'no starters' };
    if (ctx.players.length < 2) return { ok: false, reason: 'NOT_ENOUGH_PLAYERS', detail: 'a duel needs two' };

    const seeds = ctx.rng.shuffle(ctx.players.map((player) => player.id));
    const levels = Math.ceil(Math.log2(seeds.length));
    const statOrder = ctx.rng.shuffle(ctx.config.stats);
    const levelStats = Array.from({ length: levels }, (_, level) => statOrder[level % statOrder.length] ?? 'SHOTS');

    const privatePayloads: Partial<Record<PlayerId, M8Shape['privatePayload']>> = {};
    let lap: readonly FootballPlayerId[] = [];
    seeds.forEach((playerId, index) => {
      const at = index % starters.length;
      if (at === 0) lap = ctx.rng.shuffle(starters.map((entry) => entry.playerId));
      const man = lap[at];
      if (man !== undefined) privatePayloads[playerId] = { defaultPick: man };
    });

    let contentKey = `${fixture.id}:stat-duel:r${ctx.roundIndex + 1}`;
    for (let suffix = 2; ctx.usedContentKeys.includes(contentKey); suffix += 1) {
      contentKey = `${fixture.id}:stat-duel:r${ctx.roundIndex + 1}-${suffix}`;
    }
    return {
      ok: true,
      round: {
        publicPayload: {
          kind: 'STAT_DUEL',
          fixtureId: fixture.id,
          homeTeamId: fixture.homeTeam.id,
          awayTeamId: fixture.awayTeam.id,
          duelSips: ctx.config.duelSips,
          options: starters.map((entry) => ({
            footballerId: entry.playerId,
            name: entry.name,
            teamId: entry.teamId,
            position: entry.position,
          })),
          seeds: [...seeds],
          levelStats,
          clockKnown: false,
          matchClock: null,
          whistle: false,
        },
        privatePayloads,
        solution: { status: 'running', endedBy: null, baseline: null, latest: null },
        contentKey,
        // Closes picks; the round runs on to the whistle.
        answerWindowMs: ctx.config.pickWindowMs,
        turnOrder: null,
      },
    };
  },

  validateSubmission: (ctx) => {
    const parsed = submissionSchema.safeParse(ctx.raw);
    if (!parsed.success) return { ok: false, code: 'SCHEMA', detail: parsed.error.message };
    if (!ctx.round.publicPayload.seeds.includes(ctx.playerId)) {
      return { ok: false, code: 'NOT_ALLOWED', detail: 'not in this bracket' };
    }
    if (!ctx.round.publicPayload.options.some((option) => option.footballerId === parsed.data.footballerId)) {
      return { ok: false, code: 'UNKNOWN_OPTION', detail: parsed.data.footballerId };
    }
    return { ok: true, payload: parsed.data };
  },

  observeEvents: (ctx) => {
    const payload = ctx.round.publicPayload;
    const unchanged = { privatePayloads: ctx.round.privatePayloads, scoreDeltas: [], penalties: [] };
    if (ctx.round.solution.status !== 'running') {
      return { ...unchanged, publicPayload: payload, solution: ctx.round.solution, resolved: true };
    }
    // Baseline call (`events` empty): a whistle in the history means the match is already over.
    const over = ctx.events.length === 0 && ctx.history.some((event) => event.type === 'FULL_TIME');
    const whistle = payload.whistle || over || ctx.events.some((event) => event.type === 'FULL_TIME');
    return {
      ...unchanged,
      publicPayload: { ...payload, ...clockFields(ctx.round), whistle },
      solution: over ? { ...ctx.round.solution, status: 'void', endedBy: 'MATCH_OVER' } : ctx.round.solution,
      resolved: over,
    };
  },

  observeStats: (ctx) => {
    const payload = ctx.round.publicPayload;
    const solution = ctx.round.solution;
    const unchanged = { privatePayloads: ctx.round.privatePayloads, scoreDeltas: [], penalties: [] };
    if (solution.status !== 'running') return { ...unchanged, publicPayload: payload, solution, resolved: true };
    if (ctx.snapshot.fixtureId !== payload.fixtureId) {
      return { ...unchanged, publicPayload: payload, solution, resolved: false };
    }

    const current: Snapshot = { asOf: ctx.snapshot.asOf, receivedAt: ctx.now, rows: ctx.snapshot.playerStats.map(toRow) };
    const deadline = ctx.round.deadlineAt ?? ctx.round.startedAt;
    let baseline = solution.baseline;
    let baselineIsCurrent = false;
    if (baseline === null && ctx.now >= deadline) {
      const before = solution.latest !== null && solution.latest.receivedAt < deadline ? solution.latest : null;
      const preKickoff = ctx.round.liveWindow?.baselineSource === 'pre-kickoff';
      baseline = before ?? (preKickoff ? EMPTY_SNAPSHOT(deadline) : current);
      baselineIsCurrent = baseline === current;
    }
    const next = { ...solution, baseline, latest: current };

    if (!payload.whistle) return { ...unchanged, publicPayload: payload, solution: next, resolved: false };
    // The whistle has blown: this is the final line. Nothing to measure from means no duel.
    if (baseline === null || baselineIsCurrent) {
      return { ...unchanged, publicPayload: payload, solution: { ...next, status: 'void', endedBy: 'NO_PLAY' }, resolved: true };
    }
    return { ...unchanged, publicPayload: payload, solution: { ...next, status: 'settled', endedBy: 'FULL_TIME' }, resolved: true };
  },

  scoreRound: (ctx) => {
    const payload = ctx.round.publicPayload;
    const solution = ctx.round.solution;
    const picked = new Map(ctx.submissions.map((submission) => [submission.playerId, submission.payload.footballerId]));
    const pickOf = (playerId: PlayerId): FootballPlayerId =>
      picked.get(playerId) ?? ctx.round.privatePayloads[playerId]?.defaultPick ?? ('' as FootballPlayerId);
    const picks = payload.seeds.map((playerId) => ({
      playerId,
      footballerId: pickOf(playerId),
      defaulted: !picked.has(playerId),
    }));

    // A host reveal mid-match settles on the stats so far, if there is a window to measure.
    const measurable = solution.status !== 'void' && solution.baseline !== null && solution.latest !== null;
    if (!measurable) {
      return {
        scores: [],
        winnerIds: [],
        penalties: [],
        summary: {
          status: 'void',
          endedBy: solution.status === 'void' ? solution.endedBy : 'NO_PLAY',
          picks,
          duels: [],
          byes: [],
          championId: null,
          lines: [],
        },
      };
    }

    const bracket = playM8Bracket(payload.seeds, payload.levelStats, pickOf, solution.baseline, solution.latest);
    const levels = payload.levelStats.length;
    const penalties: PenaltyEvent[] = [];
    if (payload.duelSips > 0) {
      for (const duel of bracket.duels) {
        if (duel.loserId === null) continue;
        const loserIsA = duel.loserId === duel.playerA;
        penalties.push(
          penalty(duel.loserId, 'self', payload.duelSips, 'DUEL_LOST', {
            level: duel.level,
            stat: duel.stat,
            opponentId: loserIsA ? duel.playerB : duel.playerA,
            value: loserIsA ? duel.valueA : duel.valueB,
            opponentValue: loserIsA ? duel.valueB : duel.valueA,
          }),
        );
      }
    }
    const scores: RoundScore[] = payload.seeds
      .filter((playerId) => ctx.players.some((player) => player.id === playerId))
      .map((playerId) => {
        const won = bracket.wins[playerId] ?? 0;
        return scoreAnswer({
          playerId,
          correct: won > 0,
          accuracyFactor: levels === 0 ? 0 : won / levels,
          countsAsCorrect: bracket.championId === playerId,
          elapsedMs: 0,
          windowMs: null,
          streakBefore: ctx.players.find((player) => player.id === playerId)?.streak ?? 0,
          config: ctx.scoring,
          meta: { duelsWon: won, champion: bracket.championId === playerId },
        });
      });

    const pickedIds = [...new Set(picks.map((entry) => entry.footballerId))];
    return {
      scores,
      winnerIds: bracket.championId === null ? [] : [bracket.championId],
      penalties,
      summary: {
        status: 'settled',
        endedBy: solution.status === 'settled' ? solution.endedBy : 'HOST',
        picks,
        duels: bracket.duels,
        byes: bracket.byes,
        championId: bracket.championId,
        lines: pickedIds.map((footballerId) => ({
          footballerId,
          ...Object.fromEntries(M8_STATS.map((stat) => [stat, m8StatValue(stat, footballerId, solution.baseline, solution.latest)])),
        })),
      },
    };
  },

  projectRound: (ctx) => ({
    publicPayload: { ...ctx.round.publicPayload, ...clockFields(ctx.round) },
    // Your own default pick only.
    privatePayload: ctx.viewerId === null ? null : (ctx.round.privatePayloads[ctx.viewerId] ?? null),
    solution: ctx.visibility === 'revealed' ? ctx.round.solution : null,
  }),
});
