/**
 * M1 — Match Markets (matchday, `long-running-bet`)
 *
 * A betting-slip round: one round spans the whole fixture. Players file a slip covering every
 * market, then live `MatchEvent`s settle the picks and every lost pick costs sips immediately. At
 * full time the slip is graded: the worst slip downs it, a perfect slip makes everyone else drink.
 *
 * Phase 1 scope: **pre-kickoff slips only.** The slip may be filed and edited until the first live
 * event is observed (or the slip deadline passes, whichever is first). After that no slip can be
 * filed or changed, so nobody can pick an outcome that is already known. In-play markets that open
 * and close independently are not part of Phase 1.
 *
 * Settlement is per *option*, not per market: every option of a market settles `WON` or `LOST` on
 * its own, as soon as its outcome is certain. That matters for markets that are not single-outcome —
 * in ANYTIME_SCORER a player pick wins the moment that player scores, independently of who scored
 * first, and only loses at full time if they never scored. Single-outcome markets (result, BTTS,
 * over/under, first scorer, …) settle all their options at once.
 *
 * Settlement is recomputed from scratch out of a small counter snapshot on every observation and is
 * monotonic (an option never changes outcome once settled), which makes live ingestion idempotent:
 * replaying events can never settle an option twice or double-charge a sip.
 *
 * Goal attribution:
 *  - `GOAL` and `PENALTY_SCORED` count for the team *and* as the player scoring;
 *  - `OWN_GOAL` counts for the credited team (providers normalize `teamId` to the team credited with
 *    the goal) but **not** as anyone scoring, so it never wins a scorer pick;
 *  - `PENALTY_MISSED` counts for nothing.
 */

import type { FootballPlayerId, MatchEvent, PlayerPosition } from '@fdg/football-data';
import { z } from 'zod';
import { asGameModuleId } from '../ids.js';
import { defineGameModule } from '../module.js';
import type { PenaltyEvent } from '../penalties.js';
import { penalty } from '../penalties.js';
import type { RoundScore } from '../scoring.js';
import { scoreAnswer, scoreNoAnswer } from '../scoring.js';
import {
  footballPlayerIdSchema,
  nonSubmitters,
  pitchPlayers,
  selfPenalties,
  teamIdSchema,
} from './helpers.js';

export const M1_ID = asGameModuleId('M1');

const marketKindSchema = z.enum([
  'MATCH_RESULT',
  'HT_RESULT',
  'BTTS',
  'OVER_UNDER_GOALS',
  'OVER_UNDER_CORNERS',
  'OVER_UNDER_CARDS',
  'PENALTY_AWARDED',
  'FIRST_SCORER',
  'ANYTIME_SCORER',
  'WINNING_MARGIN',
  'CORRECT_SCORE',
]);

export type M1MarketKind = z.infer<typeof marketKindSchema>;

const optionKindSchema = z.enum([
  'HOME',
  'AWAY',
  'DRAW',
  'YES',
  'NO',
  'OVER',
  'UNDER',
  'PLAYER',
  'NO_GOAL',
  'OTHER',
  'MARGIN_1',
  'MARGIN_2',
  'MARGIN_3_PLUS',
  'SCORELINE',
]);

const optionSchema = z
  .object({
    id: z.string().min(1),
    kind: optionKindSchema,
    /** Data-derived text (team name, player name) — empty when the option needs no label. */
    label: z.string(),
    playerId: footballPlayerIdSchema.nullable(),
    /** For `SCORELINE` options. */
    homeGoals: z.number().int().nullable(),
    awayGoals: z.number().int().nullable(),
  })
  .strict();

const marketSchema = z
  .object({
    id: z.string().min(1),
    kind: marketKindSchema,
    line: z.number().nullable(),
    options: z.array(optionSchema).min(2),
  })
  .strict();

const countersSchema = z
  .object({
    homeGoals: z.number().int(),
    awayGoals: z.number().int(),
    corners: z.number().int(),
    cards: z.number().int(),
    penaltyAwarded: z.boolean(),
    halfTimeRecorded: z.boolean(),
    halfTimeHomeGoals: z.number().int(),
    halfTimeAwayGoals: z.number().int(),
    fullTime: z.boolean(),
    firstScorerPlayerId: footballPlayerIdSchema.nullable(),
    scorerPlayerIds: z.array(footballPlayerIdSchema),
  })
  .strict();

export type M1Counters = z.infer<typeof countersSchema>;

const settlementSchema = z
  .object({
    marketId: z.string().min(1),
    optionId: z.string().min(1),
    outcome: z.enum(['WON', 'LOST']),
  })
  .strict();

export type M1Settlement = z.infer<typeof settlementSchema>;
export type M1OptionOutcome = M1Settlement['outcome'];

const pickSchema = z.object({ marketId: z.string().min(1), optionId: z.string().min(1) }).strict();

const configSchema = z
  .object({
    markets: z.array(marketKindSchema).min(1),
    goalsLine: z.number().min(0.5).max(10.5),
    cornersLine: z.number().min(0.5).max(30.5),
    cardsLine: z.number().min(0.5).max(20.5),
    scorerOptionCount: z.number().int().min(2).max(10),
    /** How long the slip stays open, from round start, unless a live event locks it earlier. */
    slipWindowMs: z.number().int().min(10_000).max(3_600_000),
    sipsPerLostMarket: z.number().int().min(0).max(5),
    worstSlipSips: z.number().int().min(0).max(10),
    perfectSlipSips: z.number().int().min(0).max(10),
    noAnswerSips: z.number().int().min(0).max(10),
  })
  .strict();

const publicPayloadSchema = z
  .object({
    kind: z.literal('MATCH_MARKETS'),
    homeTeamId: teamIdSchema,
    awayTeamId: teamIdSchema,
    markets: z.array(marketSchema).min(1),
    counters: countersSchema,
    /** Options settled so far. Public: it is what is happening on the TV. */
    settlements: z.array(settlementSchema),
    /** `true` once the first live event has been observed; no slip can be filed or edited after. */
    slipLocked: z.boolean(),
  })
  .strict();

/** The authoritative grading of the slips. Withheld until reveal. */
const solutionSchema = z.object({ settled: z.boolean(), settlements: z.array(settlementSchema) }).strict();

const submissionSchema = z.object({ picks: z.array(pickSchema).min(1) }).strict();

interface M1Shape {
  readonly config: z.infer<typeof configSchema>;
  readonly publicPayload: z.infer<typeof publicPayloadSchema>;
  readonly privatePayload: null;
  readonly solution: z.infer<typeof solutionSchema>;
  readonly submission: z.infer<typeof submissionSchema>;
}

type M1Market = z.infer<typeof marketSchema>;
type M1Option = z.infer<typeof optionSchema>;
type M1Pick = z.infer<typeof pickSchema>;

/** One option's outcome within a market. */
export interface M1OptionSettlement {
  readonly optionId: string;
  readonly outcome: M1OptionOutcome;
}

export const M1_DEFAULT_CONFIG: M1Shape['config'] = {
  markets: [
    'MATCH_RESULT',
    'HT_RESULT',
    'BTTS',
    'OVER_UNDER_GOALS',
    'OVER_UNDER_CORNERS',
    'OVER_UNDER_CARDS',
    'PENALTY_AWARDED',
    'FIRST_SCORER',
    'ANYTIME_SCORER',
    'WINNING_MARGIN',
    'CORRECT_SCORE',
  ],
  goalsLine: 2.5,
  cornersLine: 9.5,
  cardsLine: 3.5,
  scorerOptionCount: 5,
  slipWindowMs: 300_000,
  sipsPerLostMarket: 1,
  worstSlipSips: 3,
  perfectSlipSips: 2,
  noAnswerSips: 4,
};

export const EMPTY_M1_COUNTERS: M1Counters = {
  homeGoals: 0,
  awayGoals: 0,
  corners: 0,
  cards: 0,
  penaltyAwarded: false,
  halfTimeRecorded: false,
  halfTimeHomeGoals: 0,
  halfTimeAwayGoals: 0,
  fullTime: false,
  firstScorerPlayerId: null,
  scorerPlayerIds: [],
};

const option = (
  id: string,
  kind: z.infer<typeof optionKindSchema>,
  label = '',
  playerId: FootballPlayerId | null = null,
  homeGoals: number | null = null,
  awayGoals: number | null = null,
): M1Option => ({ id, kind, label, playerId, homeGoals, awayGoals });

/** Event types that count as a *player* scoring (and as a goal for `event.teamId`). */
const SCORING_TYPES: readonly MatchEvent['type'][] = ['GOAL', 'PENALTY_SCORED'];
const CARD_TYPES: readonly MatchEvent['type'][] = ['YELLOW_CARD', 'SECOND_YELLOW', 'RED_CARD'];

const matchClock = (event: MatchEvent): number => event.minute * 100 + (event.extraMinute ?? 0);

/**
 * Fold live events into the counter snapshot. Events in one batch are applied in match-clock order
 * (stable for ties), so a provider returning a batch out of order still gets the first scorer right.
 * The reducer guarantees each `MatchEvent.id` is folded at most once.
 */
export const foldMatchEvents = (
  counters: M1Counters,
  events: readonly MatchEvent[],
  homeTeamId: string,
  awayTeamId: string,
): M1Counters => {
  let next: M1Counters = counters;
  const ordered = events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => matchClock(a.event) - matchClock(b.event) || a.index - b.index)
    .map((entry) => entry.event);

  for (const event of ordered) {
    const isHome = event.teamId === homeTeamId;
    const isAway = event.teamId === awayTeamId;

    if (SCORING_TYPES.includes(event.type) || event.type === 'OWN_GOAL') {
      const scorer = event.type === 'OWN_GOAL' ? null : event.playerId;
      next = {
        ...next,
        homeGoals: next.homeGoals + (isHome ? 1 : 0),
        awayGoals: next.awayGoals + (isAway ? 1 : 0),
        firstScorerPlayerId: next.firstScorerPlayerId ?? scorer,
        scorerPlayerIds:
          scorer === null || next.scorerPlayerIds.includes(scorer)
            ? next.scorerPlayerIds
            : [...next.scorerPlayerIds, scorer],
      };
      continue;
    }

    if (event.type === 'CORNER') {
      next = { ...next, corners: next.corners + 1 };
      continue;
    }
    if (CARD_TYPES.includes(event.type)) {
      next = { ...next, cards: next.cards + 1 };
      continue;
    }
    if (event.type === 'PENALTY_AWARDED') {
      next = { ...next, penaltyAwarded: true };
      continue;
    }
    if (event.type === 'HALF_TIME') {
      next = {
        ...next,
        halfTimeRecorded: true,
        halfTimeHomeGoals: next.homeGoals,
        halfTimeAwayGoals: next.awayGoals,
      };
      continue;
    }
    if (event.type === 'FULL_TIME') {
      next = { ...next, fullTime: true };
    }
  }

  return next;
};

/** A single-outcome market: once the winning option is known, every option settles together. */
const singleOutcome = (market: M1Market, winningOptionId: string | null): readonly M1OptionSettlement[] =>
  winningOptionId === null
    ? []
    : market.options.map((candidate) => ({
        optionId: candidate.id,
        outcome: candidate.id === winningOptionId ? 'WON' : 'LOST',
      }));

/**
 * Deterministic and monotonic: which options of `market` are settled for these counters, and how.
 * Options whose outcome is not yet certain are simply absent.
 */
export const settleMarket = (
  market: M1Market,
  counters: M1Counters,
  config: M1Shape['config'],
): readonly M1OptionSettlement[] => {
  const total = counters.homeGoals + counters.awayGoals;
  const byKind = (kind: M1Option['kind']): string | null =>
    market.options.find((candidate) => candidate.kind === kind)?.id ?? null;
  const resultOption = (home: number, away: number): string | null =>
    home === away ? byKind('DRAW') : home > away ? byKind('HOME') : byKind('AWAY');
  const overUnder = (value: number, line: number): string | null =>
    value > line ? byKind('OVER') : counters.fullTime ? byKind('UNDER') : null;

  switch (market.kind) {
    case 'MATCH_RESULT':
      return singleOutcome(
        market,
        counters.fullTime ? resultOption(counters.homeGoals, counters.awayGoals) : null,
      );

    case 'HT_RESULT':
      return singleOutcome(
        market,
        counters.halfTimeRecorded
          ? resultOption(counters.halfTimeHomeGoals, counters.halfTimeAwayGoals)
          : null,
      );

    case 'BTTS':
      return singleOutcome(
        market,
        counters.homeGoals > 0 && counters.awayGoals > 0
          ? byKind('YES')
          : counters.fullTime
            ? byKind('NO')
            : null,
      );

    case 'OVER_UNDER_GOALS':
      return singleOutcome(market, overUnder(total, config.goalsLine));

    case 'OVER_UNDER_CORNERS':
      return singleOutcome(market, overUnder(counters.corners, config.cornersLine));

    case 'OVER_UNDER_CARDS':
      return singleOutcome(market, overUnder(counters.cards, config.cardsLine));

    case 'PENALTY_AWARDED':
      return singleOutcome(
        market,
        counters.penaltyAwarded ? byKind('YES') : counters.fullTime ? byKind('NO') : null,
      );

    case 'FIRST_SCORER': {
      const scorer = counters.firstScorerPlayerId;
      if (scorer !== null) {
        const listed = market.options.find((candidate) => candidate.playerId === scorer);
        return singleOutcome(market, listed?.id ?? byKind('OTHER'));
      }
      return singleOutcome(market, counters.fullTime ? byKind('NO_GOAL') : null);
    }

    case 'ANYTIME_SCORER': {
      // Not single-outcome: several listed players can all score. Each option settles on its own.
      const scored = new Set<string>(counters.scorerPlayerIds);
      const listed = new Set<string>(
        market.options.flatMap((candidate) => (candidate.playerId === null ? [] : [candidate.playerId])),
      );
      const unlistedScorer = counters.scorerPlayerIds.some((id) => !listed.has(id));
      const out: M1OptionSettlement[] = [];
      for (const candidate of market.options) {
        let outcome: M1OptionOutcome | null = null;
        if (candidate.kind === 'PLAYER' && candidate.playerId !== null) {
          outcome = scored.has(candidate.playerId) ? 'WON' : counters.fullTime ? 'LOST' : null;
        } else if (candidate.kind === 'OTHER') {
          outcome = unlistedScorer ? 'WON' : counters.fullTime ? 'LOST' : null;
        } else if (candidate.kind === 'NO_GOAL') {
          outcome = scored.size > 0 ? 'LOST' : counters.fullTime ? 'WON' : null;
        }
        if (outcome !== null) out.push({ optionId: candidate.id, outcome });
      }
      return out;
    }

    case 'WINNING_MARGIN': {
      if (!counters.fullTime) return [];
      const margin = Math.abs(counters.homeGoals - counters.awayGoals);
      return singleOutcome(
        market,
        margin === 0
          ? byKind('DRAW')
          : margin === 1
            ? byKind('MARGIN_1')
            : margin === 2
              ? byKind('MARGIN_2')
              : byKind('MARGIN_3_PLUS'),
      );
    }

    case 'CORRECT_SCORE': {
      if (!counters.fullTime) return [];
      const exact = market.options.find(
        (candidate) =>
          candidate.homeGoals === counters.homeGoals && candidate.awayGoals === counters.awayGoals,
      );
      return singleOutcome(market, exact?.id ?? byKind('OTHER'));
    }

    default: {
      const exhaustive: never = market.kind;
      return exhaustive;
    }
  }
};

export const settleAllMarkets = (
  markets: readonly M1Market[],
  counters: M1Counters,
  config: M1Shape['config'],
): readonly M1Settlement[] =>
  markets.flatMap((market) =>
    settleMarket(market, counters, config).map((entry) => ({
      marketId: market.id,
      optionId: entry.optionId,
      outcome: entry.outcome,
    })),
  );

/** A market is closed once every one of its options has settled. */
const closedMarketIds = (
  markets: readonly M1Market[],
  settlements: readonly M1Settlement[],
): ReadonlySet<string> =>
  new Set(
    markets
      .filter((market) =>
        market.options.every((candidate) =>
          settlements.some((entry) => entry.marketId === market.id && entry.optionId === candidate.id),
        ),
      )
      .map((market) => market.id),
  );

const outcomeOf = (settlements: readonly M1Settlement[], pick: M1Pick): M1OptionOutcome | null =>
  settlements.find((entry) => entry.marketId === pick.marketId && entry.optionId === pick.optionId)
    ?.outcome ?? null;

const attackingFirst = (position: PlayerPosition): number =>
  position === 'FW' ? 0 : position === 'MF' ? 1 : position === 'DF' ? 2 : 3;

export const m1MatchMarkets = defineGameModule<M1Shape>({
  id: M1_ID,
  category: 'matchday',
  kind: 'long-running-bet',
  dataRequirements: ['hasLineups', 'hasLiveEvents'],
  minPlayers: 1,
  maxPlayers: null,
  // The slip can be edited until it locks — that is the whole point of a pre-kickoff slip.
  allowResubmission: true,
  defaultConfig: M1_DEFAULT_CONFIG,
  configSchema,
  publicPayloadSchema,
  privatePayloadSchema: z.null(),
  solutionSchema,
  submissionSchema,

  generateRound: (ctx) => {
    const fixture = ctx.data.fixture;
    if (fixture === null) return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'no fixture' };

    const onThePitch = pitchPlayers(ctx.data.lineups);
    const scorerPool = onThePitch
      .slice()
      .sort((a, b) => attackingFirst(a.position) - attackingFirst(b.position))
      .slice(0, Math.max(ctx.config.scorerOptionCount * 2, ctx.config.scorerOptionCount));
    const scorers = ctx.rng.sample(scorerPool, ctx.config.scorerOptionCount);

    const homeName = fixture.homeTeam.name;
    const awayName = fixture.awayTeam.name;

    const buildMarket = (kind: M1MarketKind): M1Market | null => {
      switch (kind) {
        case 'MATCH_RESULT':
        case 'HT_RESULT':
          return {
            id: kind,
            kind,
            line: null,
            options: [
              option(`${kind}:HOME`, 'HOME', homeName),
              option(`${kind}:DRAW`, 'DRAW'),
              option(`${kind}:AWAY`, 'AWAY', awayName),
            ],
          };
        case 'BTTS':
        case 'PENALTY_AWARDED':
          return {
            id: kind,
            kind,
            line: null,
            options: [option(`${kind}:YES`, 'YES'), option(`${kind}:NO`, 'NO')],
          };
        case 'OVER_UNDER_GOALS':
        case 'OVER_UNDER_CORNERS':
        case 'OVER_UNDER_CARDS': {
          const line =
            kind === 'OVER_UNDER_GOALS'
              ? ctx.config.goalsLine
              : kind === 'OVER_UNDER_CORNERS'
                ? ctx.config.cornersLine
                : ctx.config.cardsLine;
          return {
            id: kind,
            kind,
            line,
            options: [option(`${kind}:OVER`, 'OVER'), option(`${kind}:UNDER`, 'UNDER')],
          };
        }
        case 'FIRST_SCORER':
        case 'ANYTIME_SCORER': {
          if (scorers.length < 2) return null;
          return {
            id: kind,
            kind,
            line: null,
            options: [
              ...scorers.map((scorer) =>
                option(`${kind}:${scorer.playerId}`, 'PLAYER', scorer.name, scorer.playerId),
              ),
              option(`${kind}:OTHER`, 'OTHER'),
              option(`${kind}:NO_GOAL`, 'NO_GOAL'),
            ],
          };
        }
        case 'WINNING_MARGIN':
          return {
            id: kind,
            kind,
            line: null,
            options: [
              option(`${kind}:DRAW`, 'DRAW'),
              option(`${kind}:M1`, 'MARGIN_1'),
              option(`${kind}:M2`, 'MARGIN_2'),
              option(`${kind}:M3P`, 'MARGIN_3_PLUS'),
            ],
          };
        case 'CORRECT_SCORE': {
          const scorelines: readonly (readonly [number, number])[] = [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
            [2, 0],
            [0, 2],
            [2, 1],
            [1, 2],
            [2, 2],
          ];
          return {
            id: kind,
            kind,
            line: null,
            options: [
              ...scorelines.map(([home, away]) =>
                option(`${kind}:${home}-${away}`, 'SCORELINE', '', null, home, away),
              ),
              option(`${kind}:OTHER`, 'OTHER'),
            ],
          };
        }
        default: {
          const exhaustive: never = kind;
          return exhaustive;
        }
      }
    };

    const markets = ctx.config.markets
      .map(buildMarket)
      .filter((market): market is M1Market => market !== null);
    if (markets.length === 0) {
      return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'no market could be built' };
    }

    return {
      ok: true,
      round: {
        publicPayload: {
          kind: 'MATCH_MARKETS',
          homeTeamId: fixture.homeTeam.id,
          awayTeamId: fixture.awayTeam.id,
          markets,
          counters: EMPTY_M1_COUNTERS,
          settlements: [],
          slipLocked: false,
        },
        privatePayloads: {},
        solution: { settled: false, settlements: [] },
        contentKey: `${fixture.id}:slip`,
        // The window closes *submissions*; the round itself runs until full time.
        answerWindowMs: ctx.config.slipWindowMs,
        turnOrder: null,
      },
    };
  },

  validateSubmission: (ctx) => {
    const payload = ctx.round.publicPayload;
    // Order matters: the most specific reason first. Any settled option means an outcome is public.
    const firstSettled = payload.settlements[0];
    if (firstSettled !== undefined) {
      return { ok: false, code: 'MARKET_SETTLED', detail: firstSettled.marketId };
    }
    if (payload.slipLocked) {
      return { ok: false, code: 'SLIP_LOCKED', detail: 'the match has started' };
    }

    const parsed = submissionSchema.safeParse(ctx.raw);
    if (!parsed.success) return { ok: false, code: 'SCHEMA', detail: parsed.error.message };

    const markets = payload.markets;
    const seen = new Set<string>();
    for (const pick of parsed.data.picks) {
      const market = markets.find((candidate) => candidate.id === pick.marketId);
      if (market === undefined) return { ok: false, code: 'UNKNOWN_OPTION', detail: pick.marketId };
      if (!market.options.some((candidate) => candidate.id === pick.optionId)) {
        return { ok: false, code: 'UNKNOWN_OPTION', detail: pick.optionId };
      }
      if (seen.has(pick.marketId)) {
        return { ok: false, code: 'NOT_ALLOWED', detail: `duplicate pick ${pick.marketId}` };
      }
      seen.add(pick.marketId);
    }
    if (seen.size !== markets.length) {
      return { ok: false, code: 'INCOMPLETE', detail: `${seen.size}/${markets.length} markets` };
    }
    return { ok: true, payload: parsed.data };
  },

  observeEvents: (ctx) => {
    const payload = ctx.round.publicPayload;
    const counters = foldMatchEvents(payload.counters, ctx.events, payload.homeTeamId, payload.awayTeamId);
    const settlements = settleAllMarkets(payload.markets, counters, ctx.config);
    const known = new Set(payload.settlements.map((entry) => `${entry.marketId}|${entry.optionId}`));
    const newlyLost = settlements.filter(
      (entry) => entry.outcome === 'LOST' && !known.has(`${entry.marketId}|${entry.optionId}`),
    );

    const penalties: PenaltyEvent[] = [];
    for (const lost of newlyLost) {
      for (const submission of ctx.submissions) {
        const pick = submission.payload.picks.find((entry) => entry.marketId === lost.marketId);
        if (pick !== undefined && pick.optionId === lost.optionId) {
          penalties.push(
            penalty(submission.playerId, 'self', ctx.config.sipsPerLostMarket, 'LOST_MARKET', {
              marketId: lost.marketId,
              optionId: lost.optionId,
            }),
          );
        }
      }
    }

    return {
      publicPayload: {
        ...payload,
        counters,
        settlements: settlements.slice(),
        // The engine only calls observeEvents with at least one new event: the match is under way.
        slipLocked: true,
      },
      privatePayloads: {},
      solution: { settled: counters.fullTime, settlements: settlements.slice() },
      penalties,
      scoreDeltas: [],
      resolved: counters.fullTime,
    };
  },

  scoreRound: (ctx) => {
    const settlements = ctx.round.solution.settlements;
    const markets = ctx.round.publicPayload.markets;
    // Only closed markets are graded, so every slip is graded over the same set of markets even when
    // the host reveals before full time.
    const closed = closedMarketIds(markets, settlements);
    const closedCount = closed.size;

    const wonCountFor = (picks: readonly M1Pick[]): number =>
      picks.filter((pick) => closed.has(pick.marketId) && outcomeOf(settlements, pick) === 'WON').length;

    const scores: RoundScore[] = ctx.players.map((player) => {
      const submission = ctx.submissions.find((entry) => entry.playerId === player.id);
      if (submission === undefined) {
        return scoreNoAnswer({
          playerId: player.id,
          config: ctx.scoring,
          meta: { wonMarkets: 0, gradedMarkets: closedCount },
        });
      }
      const wonMarkets = closedCount === 0 ? 0 : wonCountFor(submission.payload.picks);
      return scoreAnswer({
        playerId: player.id,
        // Points are proportional to the slip…
        correct: wonMarkets > 0,
        accuracyFactor: closedCount === 0 ? 0 : wonMarkets / closedCount,
        // …but only a perfect slip counts as correct for streaks and gets the streak multiplier.
        countsAsCorrect: closedCount > 0 && wonMarkets === closedCount,
        elapsedMs: submission.elapsedMs,
        windowMs: null,
        streakBefore: player.streak,
        config: ctx.scoring,
        meta: { wonMarkets, gradedMarkets: closedCount },
      });
    });

    const penalties: PenaltyEvent[] = [
      ...selfPenalties(
        nonSubmitters<M1Shape>(ctx.players, ctx.submissions),
        ctx.config.noAnswerSips,
        'NO_ANSWER',
      ),
    ];

    if (closedCount > 0 && ctx.submissions.length > 0) {
      const tallies = ctx.submissions.map((submission) => ({
        playerId: submission.playerId,
        won: wonCountFor(submission.payload.picks),
      }));
      const worst = Math.min(...tallies.map((entry) => entry.won));
      const best = Math.max(...tallies.map((entry) => entry.won));

      // Only punish the worst slip when there is actually a spread — otherwise everyone tied.
      if (worst < best && ctx.config.worstSlipSips > 0) {
        for (const entry of tallies.filter((candidate) => candidate.won === worst)) {
          penalties.push(
            penalty(entry.playerId, 'self', ctx.config.worstSlipSips, 'WORST_SLIP', {
              wonMarkets: entry.won,
            }),
          );
        }
      }
      if (ctx.config.perfectSlipSips > 0) {
        for (const entry of tallies.filter((candidate) => candidate.won === closedCount)) {
          penalties.push(
            penalty(entry.playerId, 'others', ctx.config.perfectSlipSips, 'PERFECT_SLIP', {
              wonMarkets: entry.won,
            }),
          );
        }
      }
    }

    let bestPoints = 0;
    for (const score of scores) if (score.points > bestPoints) bestPoints = score.points;
    const winnerIds =
      bestPoints <= 0
        ? []
        : scores.filter((score) => score.points === bestPoints).map((score) => score.playerId);

    return {
      scores,
      winnerIds,
      penalties,
      summary: {
        gradedMarkets: closedCount,
        settled: ctx.round.solution.settled,
        homeGoals: ctx.round.publicPayload.counters.homeGoals,
        awayGoals: ctx.round.publicPayload.counters.awayGoals,
      },
    };
  },

  projectRound: (ctx) => ({
    publicPayload: ctx.round.publicPayload,
    privatePayload: null,
    solution: ctx.visibility === 'revealed' ? ctx.round.solution : null,
  }),
});
