import type { FootballPlayerId, MatchEvent } from '@fdg/football-data';
import { describe, expect, it } from 'vitest';
import type { RoomAction } from '../actions.js';
import { EMPTY_DATA_CONTEXT } from '../data.js';
import {
  ALL_BUILT,
  AWAY_TEAM_ID,
  asRoundView,
  generateWith,
  HOME_TEAM_ID,
  HOST,
  makeHarness,
  matchEvent,
  mustGenerate,
  newRoom,
  P2,
  P3,
  playerViews,
  sampleData,
  sub,
  T0,
} from '../harness.test-utils.js';
import { projectFor } from '../projection.js';
import type { EngineDeps } from '../reducer.js';
import { reduceAll, reduceRoom } from '../reducer.js';
import { DEFAULT_SCORING } from '../scoring.js';
import type { RoomState } from '../state.js';
import { currentRound } from '../state.js';
import type { M1Counters, M1Settlement } from './m1-match-markets.js';
import {
  EMPTY_M1_COUNTERS,
  foldMatchEvents,
  M1_DEFAULT_CONFIG,
  M1_ID,
  m1MatchMarkets as module,
  settleMarket,
} from './m1-match-markets.js';

interface M1Option {
  readonly id: string;
  readonly kind: string;
  readonly playerId: string | null;
}
interface M1Market {
  readonly id: string;
  readonly kind: string;
  readonly line: number | null;
  readonly options: readonly M1Option[];
}
interface M1Public {
  readonly markets: readonly M1Market[];
  readonly counters: M1Counters;
  readonly settlements: readonly M1Settlement[];
  readonly slipLocked: boolean;
}
interface M1Solution {
  readonly settled: boolean;
  readonly settlements: readonly M1Settlement[];
}
interface Pick {
  readonly marketId: string;
  readonly optionId: string;
}

const generated = mustGenerate(module);
const publicPayload = generated.publicPayload as M1Public;

const marketOf = (kind: string, payload: M1Public = publicPayload): M1Market => {
  const found = payload.markets.find((candidate) => candidate.kind === kind);
  if (found === undefined) throw new Error(`missing market ${kind}`);
  return found;
};

const optionFor = (marketId: string, kind: string, payload: M1Public = publicPayload): string => {
  const option = marketOf(marketId, payload).options.find((candidate) => candidate.kind === kind);
  if (option === undefined) throw new Error(`no ${kind} option on ${marketId}`);
  return option.id;
};

/** The listed scorer options of a scorer market, as footballer ids. */
const listedScorers = (
  kind: 'FIRST_SCORER' | 'ANYTIME_SCORER',
  payload: M1Public = publicPayload,
): readonly FootballPlayerId[] =>
  marketOf(kind, payload).options.flatMap((option) =>
    option.kind === 'PLAYER' && option.playerId !== null ? [option.playerId as FootballPlayerId] : [],
  );

const scorerOption = (
  kind: 'FIRST_SCORER' | 'ANYTIME_SCORER',
  playerId: string,
  payload: M1Public = publicPayload,
): string => {
  const option = marketOf(kind, payload).options.find((candidate) => candidate.playerId === playerId);
  if (option === undefined) throw new Error(`no option for ${playerId}`);
  return option.id;
};

const unlistedPlayer = (): FootballPlayerId => {
  const listed = new Set<string>(listedScorers('ANYTIME_SCORER'));
  const entry = ALL_BUILT.find((candidate) => !listed.has(candidate.player.id));
  if (entry === undefined) throw new Error('everyone is listed');
  return entry.player.id;
};

const teamOf = (playerId: string) =>
  ALL_BUILT.find((entry) => entry.player.id === playerId)?.player.teamId ?? HOME_TEAM_ID;

/** A complete slip: the first option everywhere unless overridden. */
const slip = (
  overrides: Readonly<Record<string, string>> = {},
  payload: M1Public = publicPayload,
): { picks: readonly Pick[] } => ({
  picks: payload.markets.map((market) => ({
    marketId: market.id,
    optionId: overrides[market.id] ?? market.options[0]?.id ?? '',
  })),
});

const observeMaybe = (
  round: ReturnType<typeof asRoundView>,
  events: readonly MatchEvent[],
  submissions: readonly ReturnType<typeof sub>[] = [],
) =>
  module.observeEvents({
    config: M1_DEFAULT_CONFIG,
    round,
    events,
    submissions,
    players: playerViews([HOST, P2, P3]),
    now: T0,
  });

/** observeEvents is optional on the contract; M1 always implements it. */
const observe = (
  round: ReturnType<typeof asRoundView>,
  events: readonly MatchEvent[],
  submissions: readonly ReturnType<typeof sub>[] = [],
) => {
  const result = observeMaybe(round, events, submissions);
  if (result === null) throw new Error('M1 must observe live events');
  return result;
};

/** Apply an observation to a round view, as the reducer would. */
const advance = (
  round: ReturnType<typeof asRoundView>,
  events: readonly MatchEvent[],
  submissions: readonly ReturnType<typeof sub>[] = [],
) => {
  const result = observe(round, events, submissions);
  return {
    result,
    round: { ...round, publicPayload: result.publicPayload, solution: result.solution },
  };
};

const goalBy = (playerId: string, minute = 10): MatchEvent =>
  matchEvent('GOAL', { teamId: teamOf(playerId), playerId: playerId as FootballPlayerId, minute });

const goal = (teamId: typeof HOME_TEAM_ID, playerIndex = 0, minute = 10): MatchEvent =>
  matchEvent('GOAL', { teamId, playerId: ALL_BUILT[playerIndex]?.player.id ?? null, minute });

const settle = (kind: string, counters: Partial<M1Counters>) =>
  settleMarket(marketOf(kind) as never, { ...EMPTY_M1_COUNTERS, ...counters }, M1_DEFAULT_CONFIG);

/** For a single-outcome market: the WON option, after checking every other option LOST. */
const winnerOf = (kind: string, counters: Partial<M1Counters>): string | null => {
  const settled = settle(kind, counters);
  if (settled.length === 0) return null;
  expect(settled).toHaveLength(marketOf(kind).options.length);
  const won = settled.filter((entry) => entry.outcome === 'WON');
  expect(won).toHaveLength(1);
  return won[0]?.optionId ?? null;
};

const outcomeIn = (settled: readonly { optionId: string; outcome: string }[], optionId: string) =>
  settled.find((entry) => entry.optionId === optionId)?.outcome ?? null;

describe('M1 metadata and generation', () => {
  it('is a long-running matchday bet that needs lineups and live events', () => {
    expect(module.id).toBe('M1');
    expect(module.kind).toBe('long-running-bet');
    expect(module.dataRequirements).toEqual(['hasLineups', 'hasLiveEvents']);
    expect(module.supportsLiveEvents).toBe(true);
    expect(module.allowResubmission).toBe(true);
  });

  it('builds every configured market with at least two options and an open slip', () => {
    expect(publicPayload.markets.map((market) => market.kind)).toEqual(M1_DEFAULT_CONFIG.markets);
    expect(publicPayload.markets.every((market) => market.options.length >= 2)).toBe(true);
    expect(publicPayload.counters).toEqual(EMPTY_M1_COUNTERS);
    expect(publicPayload.settlements).toEqual([]);
    expect(publicPayload.slipLocked).toBe(false);
    expect((generated.solution as M1Solution).settled).toBe(false);
  });

  it('offers real pitch players as scorers, plus an other and a no-goal escape', () => {
    const players = listedScorers('FIRST_SCORER');
    expect(players).toHaveLength(M1_DEFAULT_CONFIG.scorerOptionCount);
    expect(players.every((id) => ALL_BUILT.some((entry) => entry.player.id === id))).toBe(true);
    expect(marketOf('FIRST_SCORER').options.some((option) => option.kind === 'OTHER')).toBe(true);
    expect(marketOf('FIRST_SCORER').options.some((option) => option.kind === 'NO_GOAL')).toBe(true);
  });

  it('closes submissions on a deadline but leaves the round running', () => {
    expect(generated.answerWindowMs).toBe(M1_DEFAULT_CONFIG.slipWindowMs);
  });

  it('fails without a fixture', () => {
    const result = generateWith(module, { data: EMPTY_DATA_CONTEXT });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('INSUFFICIENT_DATA');
  });

  it('drops scorer markets when no lineup is available but keeps the rest', () => {
    const round = mustGenerate(module, { data: sampleData({ lineups: null }) });
    const kinds = (round.publicPayload as M1Public).markets.map((market) => market.kind);
    expect(kinds).not.toContain('FIRST_SCORER');
    expect(kinds).toContain('BTTS');
  });
});

describe('M1 slip validation', () => {
  const round = asRoundView(generated);
  const validate = (raw: unknown, onRound = round, alreadySubmitted = false) =>
    module.validateSubmission({
      config: M1_DEFAULT_CONFIG,
      round: onRound,
      playerId: HOST,
      raw,
      submittedAt: T0,
      elapsedMs: 0,
      alreadySubmitted,
    });

  it('accepts a complete slip, and accepts an edit before the match starts', () => {
    expect(validate(slip()).ok).toBe(true);
    expect(validate(slip(), round, true).ok).toBe(true);
  });

  it('rejects an incomplete slip', () => {
    const result = validate({ picks: [{ marketId: 'BTTS', optionId: optionFor('BTTS', 'YES') }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INCOMPLETE');
  });

  it('rejects an unknown market or option', () => {
    const badMarket = validate({ picks: [{ marketId: 'MOON_LANDING', optionId: 'x' }] });
    expect(badMarket.ok).toBe(false);
    if (!badMarket.ok) expect(badMarket.code).toBe('UNKNOWN_OPTION');
    const badOption = validate({ picks: [{ marketId: 'BTTS', optionId: 'BTTS:MAYBE' }] });
    expect(badOption.ok).toBe(false);
    if (!badOption.ok) expect(badOption.code).toBe('UNKNOWN_OPTION');
  });

  it('rejects two picks on the same market', () => {
    const result = validate({
      picks: [
        { marketId: 'BTTS', optionId: optionFor('BTTS', 'YES') },
        { marketId: 'BTTS', optionId: optionFor('BTTS', 'NO') },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_ALLOWED');
  });

  it('rejects a malformed payload', () => {
    const result = validate({ picks: 'all of them' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SCHEMA');
  });

  it('B4: locks the slip at the first observed event, even one that settles nothing', () => {
    const { result, round: started } = advance(round, [matchEvent('CORNER')]);
    expect(result.publicPayload).toMatchObject({ slipLocked: true, settlements: [] });
    const late = validate(slip(), started);
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.code).toBe('SLIP_LOCKED');
    const edit = validate(slip(), started, true);
    expect(edit.ok).toBe(false);
    if (!edit.ok) expect(edit.code).toBe('SLIP_LOCKED');
  });

  it('B4: rejects new slips and edits with MARKET_SETTLED once any outcome is known', () => {
    const { round: settled } = advance(round, [matchEvent('PENALTY_AWARDED')]);
    const yes = { PENALTY_AWARDED: optionFor('PENALTY_AWARDED', 'YES') };
    const filed = validate(slip(yes), settled);
    expect(filed.ok).toBe(false);
    if (!filed.ok) {
      expect(filed.code).toBe('MARKET_SETTLED');
      expect(filed.detail).toBe('PENALTY_AWARDED');
    }
    const edited = validate(slip(yes), settled, true);
    expect(edited.ok).toBe(false);
    if (!edited.ok) expect(edited.code).toBe('MARKET_SETTLED');
  });
});

describe('M1 counters', () => {
  it('credits goals to the team on the event and remembers the first scorer', () => {
    const counters = foldMatchEvents(
      EMPTY_M1_COUNTERS,
      [goal(HOME_TEAM_ID, 0, 5), goal(AWAY_TEAM_ID, 12, 20), goal(HOME_TEAM_ID, 1, 30)],
      HOME_TEAM_ID,
      AWAY_TEAM_ID,
    );
    expect(counters.homeGoals).toBe(2);
    expect(counters.awayGoals).toBe(1);
    expect(counters.firstScorerPlayerId).toBe(ALL_BUILT[0]?.player.id);
    expect(counters.scorerPlayerIds).toHaveLength(3);
  });

  it('applies a batch in match-clock order, so a late-listed earlier goal is still the first', () => {
    const counters = foldMatchEvents(
      EMPTY_M1_COUNTERS,
      [goal(AWAY_TEAM_ID, 12, 60), goal(HOME_TEAM_ID, 3, 15)],
      HOME_TEAM_ID,
      AWAY_TEAM_ID,
    );
    expect(counters.firstScorerPlayerId).toBe(ALL_BUILT[3]?.player.id);
  });

  it('counts an own goal for the credited team but not as anyone scoring', () => {
    const counters = foldMatchEvents(
      EMPTY_M1_COUNTERS,
      [matchEvent('OWN_GOAL', { teamId: HOME_TEAM_ID, playerId: ALL_BUILT[12]?.player.id ?? null })],
      HOME_TEAM_ID,
      AWAY_TEAM_ID,
    );
    expect(counters.homeGoals).toBe(1);
    expect(counters.firstScorerPlayerId).toBeNull();
    expect(counters.scorerPlayerIds).toEqual([]);
  });

  it('counts a scored penalty as the taker scoring, and a missed one as nothing', () => {
    const taker = ALL_BUILT[9]?.player.id ?? null;
    const counters = foldMatchEvents(
      EMPTY_M1_COUNTERS,
      [
        matchEvent('PENALTY_MISSED', {
          teamId: HOME_TEAM_ID,
          playerId: ALL_BUILT[8]?.player.id ?? null,
          minute: 5,
        }),
        matchEvent('PENALTY_SCORED', { teamId: HOME_TEAM_ID, playerId: taker, minute: 50 }),
      ],
      HOME_TEAM_ID,
      AWAY_TEAM_ID,
    );
    expect(counters.homeGoals).toBe(1);
    expect(counters.firstScorerPlayerId).toBe(taker);
    expect(counters.scorerPlayerIds).toEqual([taker]);
  });

  it('counts corners, all three card types, penalties awarded and the whistles', () => {
    const counters = foldMatchEvents(
      EMPTY_M1_COUNTERS,
      [
        matchEvent('CORNER'),
        matchEvent('CORNER'),
        matchEvent('YELLOW_CARD'),
        matchEvent('SECOND_YELLOW'),
        matchEvent('RED_CARD'),
        matchEvent('PENALTY_AWARDED'),
        matchEvent('SHOT_OFF_TARGET'),
        matchEvent('HALF_TIME', { minute: 45 }),
        matchEvent('FULL_TIME', { minute: 90 }),
      ],
      HOME_TEAM_ID,
      AWAY_TEAM_ID,
    );
    expect(counters.corners).toBe(2);
    expect(counters.cards).toBe(3);
    expect(counters.penaltyAwarded).toBe(true);
    expect(counters.halfTimeRecorded).toBe(true);
    expect(counters.fullTime).toBe(true);
  });

  it('snapshots the half-time score at the whistle, not at full time', () => {
    let counters = foldMatchEvents(EMPTY_M1_COUNTERS, [goal(HOME_TEAM_ID)], HOME_TEAM_ID, AWAY_TEAM_ID);
    counters = foldMatchEvents(
      counters,
      [matchEvent('HALF_TIME', { minute: 45 })],
      HOME_TEAM_ID,
      AWAY_TEAM_ID,
    );
    counters = foldMatchEvents(
      counters,
      [goal(AWAY_TEAM_ID, 12, 60), goal(AWAY_TEAM_ID, 13, 70)],
      HOME_TEAM_ID,
      AWAY_TEAM_ID,
    );
    expect(counters.halfTimeHomeGoals).toBe(1);
    expect(counters.halfTimeAwayGoals).toBe(0);
    expect(counters.awayGoals).toBe(2);
  });
});

describe('M1 single-outcome settlement', () => {
  it('leaves every option unsettled before anything happens', () => {
    for (const market of publicPayload.markets) {
      expect(settleMarket(market as never, EMPTY_M1_COUNTERS, M1_DEFAULT_CONFIG)).toEqual([]);
    }
  });

  it('settles BTTS yes as soon as both score, and no only at full time', () => {
    expect(winnerOf('BTTS', { homeGoals: 1 })).toBeNull();
    expect(winnerOf('BTTS', { homeGoals: 1, awayGoals: 1 })).toBe(optionFor('BTTS', 'YES'));
    expect(winnerOf('BTTS', { homeGoals: 1, fullTime: true })).toBe(optionFor('BTTS', 'NO'));
  });

  it('settles over/under lines early on over and at full time on under', () => {
    expect(winnerOf('OVER_UNDER_GOALS', { homeGoals: 2, awayGoals: 1 })).toBe(
      optionFor('OVER_UNDER_GOALS', 'OVER'),
    );
    expect(winnerOf('OVER_UNDER_GOALS', { homeGoals: 1, awayGoals: 1 })).toBeNull();
    expect(winnerOf('OVER_UNDER_GOALS', { homeGoals: 1, awayGoals: 1, fullTime: true })).toBe(
      optionFor('OVER_UNDER_GOALS', 'UNDER'),
    );
    expect(winnerOf('OVER_UNDER_CORNERS', { corners: 10 })).toBe(optionFor('OVER_UNDER_CORNERS', 'OVER'));
    expect(winnerOf('OVER_UNDER_CARDS', { cards: 4 })).toBe(optionFor('OVER_UNDER_CARDS', 'OVER'));
  });

  it('settles the half-time and full-time results', () => {
    expect(winnerOf('HT_RESULT', { halfTimeRecorded: true, halfTimeHomeGoals: 1 })).toBe(
      optionFor('HT_RESULT', 'HOME'),
    );
    expect(winnerOf('HT_RESULT', { halfTimeRecorded: true })).toBe(optionFor('HT_RESULT', 'DRAW'));
    expect(winnerOf('MATCH_RESULT', { awayGoals: 2, fullTime: true })).toBe(
      optionFor('MATCH_RESULT', 'AWAY'),
    );
    expect(winnerOf('MATCH_RESULT', { homeGoals: 1, awayGoals: 1 })).toBeNull();
  });

  it('settles the winning margin and the correct score, falling back to other', () => {
    expect(winnerOf('WINNING_MARGIN', { homeGoals: 3, fullTime: true })).toBe(
      optionFor('WINNING_MARGIN', 'MARGIN_3_PLUS'),
    );
    expect(winnerOf('WINNING_MARGIN', { homeGoals: 1, awayGoals: 1, fullTime: true })).toBe(
      optionFor('WINNING_MARGIN', 'DRAW'),
    );
    expect(winnerOf('CORRECT_SCORE', { homeGoals: 2, awayGoals: 1, fullTime: true })).toBe(
      'CORRECT_SCORE:2-1',
    );
    expect(winnerOf('CORRECT_SCORE', { homeGoals: 7, awayGoals: 4, fullTime: true })).toBe(
      optionFor('CORRECT_SCORE', 'OTHER'),
    );
  });

  it('settles penalty awarded both ways', () => {
    expect(winnerOf('PENALTY_AWARDED', { penaltyAwarded: true })).toBe(optionFor('PENALTY_AWARDED', 'YES'));
    expect(winnerOf('PENALTY_AWARDED', { fullTime: true })).toBe(optionFor('PENALTY_AWARDED', 'NO'));
  });

  it('B5: settles FIRST_SCORER on the first real scorer, listed or not, and no-goal at full time', () => {
    const [listed] = listedScorers('FIRST_SCORER');
    if (listed === undefined) throw new Error('no listed scorer');
    expect(winnerOf('FIRST_SCORER', { firstScorerPlayerId: listed })).toBe(
      scorerOption('FIRST_SCORER', listed),
    );
    expect(winnerOf('FIRST_SCORER', { firstScorerPlayerId: unlistedPlayer() })).toBe(
      optionFor('FIRST_SCORER', 'OTHER'),
    );
    expect(winnerOf('FIRST_SCORER', { fullTime: true })).toBe(optionFor('FIRST_SCORER', 'NO_GOAL'));
  });

  it('B5: an own goal before the first real goal does not take FIRST_SCORER', () => {
    const [listed] = listedScorers('FIRST_SCORER');
    if (listed === undefined) throw new Error('no listed scorer');
    const counters = foldMatchEvents(
      EMPTY_M1_COUNTERS,
      [
        matchEvent('OWN_GOAL', { teamId: HOME_TEAM_ID, playerId: unlistedPlayer(), minute: 3 }),
        goalBy(listed, 40),
      ],
      HOME_TEAM_ID,
      AWAY_TEAM_ID,
    );
    expect(winnerOf('FIRST_SCORER', counters)).toBe(scorerOption('FIRST_SCORER', listed));
  });

  it('B5: a scored penalty takes FIRST_SCORER for the taker', () => {
    const [, second] = listedScorers('FIRST_SCORER');
    if (second === undefined) throw new Error('no listed scorer');
    const counters = foldMatchEvents(
      EMPTY_M1_COUNTERS,
      [matchEvent('PENALTY_SCORED', { teamId: teamOf(second), playerId: second, minute: 12 })],
      HOME_TEAM_ID,
      AWAY_TEAM_ID,
    );
    expect(winnerOf('FIRST_SCORER', counters)).toBe(scorerOption('FIRST_SCORER', second));
  });
});

describe('B5: ANYTIME_SCORER settles each pick independently', () => {
  const [a, b, c] = listedScorers('ANYTIME_SCORER');
  if (a === undefined || b === undefined || c === undefined) throw new Error('need three listed scorers');
  const optA = scorerOption('ANYTIME_SCORER', a);
  const optB = scorerOption('ANYTIME_SCORER', b);
  const optC = scorerOption('ANYTIME_SCORER', c);
  const other = optionFor('ANYTIME_SCORER', 'OTHER');
  const noGoal = optionFor('ANYTIME_SCORER', 'NO_GOAL');

  it('wins every listed player who scores, in any order, and leaves the rest open until full time', () => {
    const settled = settle('ANYTIME_SCORER', { scorerPlayerIds: [a, b] });
    expect(outcomeIn(settled, optA)).toBe('WON');
    expect(outcomeIn(settled, optB)).toBe('WON');
    expect(outcomeIn(settled, optC)).toBeNull();
    expect(outcomeIn(settled, other)).toBeNull();
    expect(outcomeIn(settled, noGoal)).toBe('LOST');
  });

  it('loses a listed player at full time only if they never scored', () => {
    const settled = settle('ANYTIME_SCORER', { scorerPlayerIds: [a], fullTime: true });
    expect(outcomeIn(settled, optA)).toBe('WON');
    expect(outcomeIn(settled, optB)).toBe('LOST');
    expect(outcomeIn(settled, optC)).toBe('LOST');
    expect(outcomeIn(settled, other)).toBe('LOST');
  });

  it('wins OTHER as soon as an unlisted player scores', () => {
    expect(outcomeIn(settle('ANYTIME_SCORER', { scorerPlayerIds: [unlistedPlayer()] }), other)).toBe('WON');
  });

  it('wins NO_GOAL at full time when only own goals were scored', () => {
    const settled = settle('ANYTIME_SCORER', { homeGoals: 2, fullTime: true });
    expect(outcomeIn(settled, noGoal)).toBe('WON');
    expect(outcomeIn(settled, optA)).toBe('LOST');
  });

  it('does not charge the player who picked the second scorer (the QA probe)', () => {
    const round = asRoundView(generated);
    const submissions = [
      sub(HOST, slip({ ANYTIME_SCORER: optA })),
      sub(P2, slip({ ANYTIME_SCORER: optB })),
      sub(P3, slip({ ANYTIME_SCORER: optC })),
    ];
    const first = advance(round, [goalBy(a, 10)], submissions);
    const second = advance(first.round, [goalBy(b, 30)], submissions);
    const final = advance(second.round, [matchEvent('FULL_TIME', { minute: 90 })], submissions);

    const lostScorer = [first.result, second.result, final.result]
      .flatMap((entry) => entry.penalties)
      .filter((event) => event.meta?.marketId === 'ANYTIME_SCORER');
    expect(lostScorer.map((event) => event.playerId)).toEqual([P3]);
    expect(lostScorer[0]?.meta).toMatchObject({ optionId: optC });
  });
});

describe('M1 live observation', () => {
  const round = asRoundView(generated);
  const bttsNo = optionFor('BTTS', 'NO');
  const bttsYes = optionFor('BTTS', 'YES');

  it('charges a sip the moment a pick loses, and nothing to the winner', () => {
    const result = observe(
      round,
      [goal(HOME_TEAM_ID), goal(AWAY_TEAM_ID, 12, 20)],
      [sub(HOST, slip({ BTTS: bttsNo })), sub(P2, slip({ BTTS: bttsYes }))],
    );
    const lost = result.penalties.filter((event) => event.reason === 'LOST_MARKET');
    expect(lost.some((event) => event.playerId === HOST && event.meta?.marketId === 'BTTS')).toBe(true);
    expect(lost.some((event) => event.playerId === P2 && event.meta?.marketId === 'BTTS')).toBe(false);
    expect(lost.every((event) => event.sips === M1_DEFAULT_CONFIG.sipsPerLostMarket)).toBe(true);
    expect(result.resolved).toBe(false);
  });

  it('never charges twice for the same pick as the match goes on', () => {
    const submissions = [sub(HOST, slip({ BTTS: bttsNo }))];
    const first = advance(round, [goal(HOME_TEAM_ID), goal(AWAY_TEAM_ID, 12, 20)], submissions);
    const second = observe(first.round, [goal(HOME_TEAM_ID, 1, 50)], submissions);
    expect(second.penalties.filter((event) => event.meta?.marketId === 'BTTS')).toHaveLength(0);
  });

  it('resolves the round at full time and marks the slips settled', () => {
    const result = observe(round, [matchEvent('FULL_TIME', { minute: 90 })], [sub(HOST, slip())]);
    expect(result.resolved).toBe(true);
    const solution = result.solution as M1Solution;
    expect(solution.settled).toBe(true);
    // Every market closes except the half-time result: no half-time whistle was ever seen.
    const closedMarkets = new Set(solution.settlements.map((entry) => entry.marketId));
    expect(closedMarkets.size).toBe(publicPayload.markets.length - 1);
    expect(closedMarkets.has('HT_RESULT')).toBe(false);
  });

  it('keeps public counters and settlements in the public payload', () => {
    const result = observe(round, [matchEvent('CORNER'), matchEvent('CORNER')], []);
    const payload = result.publicPayload as M1Public;
    expect(payload.counters.corners).toBe(2);
    expect(payload.settlements).toEqual([]);
  });
});

describe('M1 settlement scoring', () => {
  const round = asRoundView(generated);
  const settleRound = (submissions: readonly ReturnType<typeof sub>[], events: readonly MatchEvent[]) => {
    const observed = observe(round, events, submissions);
    return module.scoreRound({
      config: M1_DEFAULT_CONFIG,
      round: { ...round, publicPayload: observed.publicPayload, solution: observed.solution },
      submissions,
      players: playerViews([HOST, P2, P3]),
      scoring: DEFAULT_SCORING,
      now: T0,
    });
  };

  const fullTime = [
    goal(HOME_TEAM_ID, 0, 10),
    matchEvent('HALF_TIME', { minute: 45 }),
    goal(AWAY_TEAM_ID, 12, 60),
    matchEvent('FULL_TIME', { minute: 90 }),
  ];

  it('pays proportionally to the markets you got right', () => {
    const outcome = settleRound(
      [sub(HOST, slip({ BTTS: optionFor('BTTS', 'YES') })), sub(P2, slip({ BTTS: optionFor('BTTS', 'NO') }))],
      fullTime,
    );
    const host = outcome.scores.find((entry) => entry.playerId === HOST);
    const guest = outcome.scores.find((entry) => entry.playerId === P2);
    expect(host?.points ?? 0).toBeGreaterThan(guest?.points ?? 0);
    expect(host?.meta).toMatchObject({ gradedMarkets: publicPayload.markets.length });
  });

  it('downs the worst slip', () => {
    const outcome = settleRound(
      [sub(HOST, slip({ BTTS: optionFor('BTTS', 'YES') })), sub(P2, slip({ BTTS: optionFor('BTTS', 'NO') }))],
      fullTime,
    );
    const worst = outcome.penalties.find((event) => event.reason === 'WORST_SLIP');
    expect(worst?.playerId).toBe(P2);
    expect(worst?.sips).toBe(M1_DEFAULT_CONFIG.worstSlipSips);
  });

  it('punishes nobody when every slip scored the same', () => {
    const same = slip();
    const outcome = settleRound([sub(HOST, same), sub(P2, same)], fullTime);
    expect(outcome.penalties.some((event) => event.reason === 'WORST_SLIP')).toBe(false);
  });

  it('charges the players who never filed a slip, and gives them no points', () => {
    const outcome = settleRound([sub(HOST, slip())], fullTime);
    const quiet = outcome.penalties.filter((event) => event.reason === 'NO_ANSWER');
    expect(quiet.map((event) => event.playerId).sort()).toEqual([P2, P3].sort());
    expect(quiet[0]?.sips).toBe(M1_DEFAULT_CONFIG.noAnswerSips);
    expect(outcome.scores.find((entry) => entry.playerId === P2)?.points).toBe(0);
  });

  it('scores nobody while no market has closed yet', () => {
    const outcome = settleRound([sub(HOST, slip())], [matchEvent('CORNER')]);
    expect(outcome.scores.every((entry) => entry.points === 0 && !entry.correct)).toBe(true);
    expect(outcome.winnerIds).toEqual([]);
  });

  it('N7: gives an imperfect slip no streak multiplier and does not count it as correct', () => {
    const outcome = module.scoreRound({
      config: M1_DEFAULT_CONFIG,
      round: {
        ...round,
        ...(() => {
          const observed = observe(round, fullTime, [sub(HOST, slip())]);
          return { publicPayload: observed.publicPayload, solution: observed.solution };
        })(),
      },
      submissions: [sub(HOST, slip())],
      players: playerViews([HOST]).map((player) => ({ ...player, streak: 5 })),
      scoring: DEFAULT_SCORING,
      now: T0,
    });
    const host = outcome.scores.find((entry) => entry.playerId === HOST);
    expect(host?.points).toBeGreaterThan(0);
    expect(host?.correct).toBe(false);
    expect(host?.breakdown.streakMultiplier).toBe(1);
  });

  it('flags a fully correct slip as correct and makes everyone else drink', () => {
    const picks = slip({
      BTTS: optionFor('BTTS', 'YES'),
      OVER_UNDER_GOALS: optionFor('OVER_UNDER_GOALS', 'UNDER'),
      OVER_UNDER_CORNERS: optionFor('OVER_UNDER_CORNERS', 'UNDER'),
      OVER_UNDER_CARDS: optionFor('OVER_UNDER_CARDS', 'UNDER'),
      PENALTY_AWARDED: optionFor('PENALTY_AWARDED', 'NO'),
      MATCH_RESULT: optionFor('MATCH_RESULT', 'DRAW'),
      HT_RESULT: optionFor('HT_RESULT', 'HOME'),
      WINNING_MARGIN: optionFor('WINNING_MARGIN', 'DRAW'),
      CORRECT_SCORE: 'CORRECT_SCORE:1-1',
      FIRST_SCORER: optionFor('FIRST_SCORER', 'OTHER'),
      ANYTIME_SCORER: optionFor('ANYTIME_SCORER', 'OTHER'),
    });
    // Scorers that are not listed, so OTHER wins both scorer markets.
    const unlisted = ALL_BUILT.filter((entry) => !listedScorers('ANYTIME_SCORER').includes(entry.player.id));
    const homeScorer = unlisted.find((entry) => entry.player.teamId === HOME_TEAM_ID)?.player.id;
    const awayScorer = unlisted.find((entry) => entry.player.teamId === AWAY_TEAM_ID)?.player.id;
    if (homeScorer === undefined || awayScorer === undefined) throw new Error('need unlisted scorers');
    const outcome = settleRound(
      [sub(HOST, picks)],
      [
        goalBy(homeScorer, 10),
        matchEvent('HALF_TIME', { minute: 45 }),
        goalBy(awayScorer, 60),
        matchEvent('FULL_TIME', { minute: 90 }),
      ],
    );
    const host = outcome.scores.find((entry) => entry.playerId === HOST);
    expect(host?.correct).toBe(true);
    const perfect = outcome.penalties.find((event) => event.reason === 'PERFECT_SLIP');
    expect(perfect?.target).toBe('others');
    expect(outcome.winnerIds).toEqual([HOST]);
  });
});

/* ------------------------- through the real reducer ------------------------ */

const startMarkets = (deps: EngineDeps, settings: RoomAction[] = []): RoomState => {
  const result = reduceAll(
    newRoom(),
    [
      { type: 'PLAYER_JOIN', playerId: P2, nickname: 'Bea', isGuest: true },
      { type: 'PLAYER_JOIN', playerId: P3, nickname: 'Cal', isGuest: true },
      ...settings,
      { type: 'SELECT_GAME', actorId: HOST, moduleId: M1_ID, config: null },
      { type: 'START_SESSION', actorId: HOST },
    ],
    deps,
  );
  expect(result.rejection).toBeNull();
  return result.state;
};

/** The markets of the room's own round (its scorer options come from the room's seed). */
const payloadOf = (room: RoomState): M1Public => currentRound(room)?.publicPayload as M1Public;

const roundIdOf = (room: RoomState) => {
  const round = currentRound(room);
  if (round === undefined) throw new Error('no round');
  return round.id;
};

describe('B4: slip locking through the reducer', () => {
  it('rejects a new slip and an edit once PENALTY_AWARDED settled, and keeps the charge (QA probe)', () => {
    const { deps } = makeHarness();
    let room = startMarkets(deps);
    const roundId = roundIdOf(room);
    const no = { PENALTY_AWARDED: optionFor('PENALTY_AWARDED', 'NO') };
    const yes = { PENALTY_AWARDED: optionFor('PENALTY_AWARDED', 'YES') };

    room = reduceRoom(
      room,
      { type: 'SUBMIT_ANSWER', playerId: HOST, roundId, payload: slip(no, payloadOf(room)) },
      deps,
    ).state;
    room = reduceRoom(
      room,
      { type: 'MATCH_EVENTS', events: [matchEvent('PENALTY_AWARDED', { minute: 20 })] },
      deps,
    ).state;
    const hostSipsAfterLoss = room.players.find((player) => player.id === HOST)?.sips;
    expect(hostSipsAfterLoss).toBe(M1_DEFAULT_CONFIG.sipsPerLostMarket);

    const newcomer = reduceRoom(
      room,
      { type: 'SUBMIT_ANSWER', playerId: P2, roundId, payload: slip(yes, payloadOf(room)) },
      deps,
    );
    expect(newcomer.rejection).toMatchObject({
      code: 'INVALID_SUBMISSION',
      submissionCode: 'MARKET_SETTLED',
    });
    expect(newcomer.state).toBe(room);

    const edit = reduceRoom(
      room,
      { type: 'SUBMIT_ANSWER', playerId: HOST, roundId, payload: slip(yes, payloadOf(room)) },
      deps,
    );
    expect(edit.rejection).toMatchObject({ code: 'INVALID_SUBMISSION', submissionCode: 'MARKET_SETTLED' });

    // The charged pick is still the one graded at full time.
    const final = reduceRoom(
      room,
      { type: 'MATCH_EVENTS', events: [matchEvent('FULL_TIME', { minute: 90 })] },
      deps,
    );
    const stored = currentRound(final.state)?.submissions.find((entry) => entry.playerId === HOST);
    expect(stored?.payload).toEqual(slip(no, payloadOf(room)));
  });

  it('rejects a slip filed after kick-off even when nothing has settled', () => {
    const { deps } = makeHarness();
    let room = startMarkets(deps);
    room = reduceRoom(
      room,
      { type: 'MATCH_EVENTS', events: [matchEvent('KICK_OFF', { minute: 0 })] },
      deps,
    ).state;
    const late = reduceRoom(
      room,
      { type: 'SUBMIT_ANSWER', playerId: P2, roundId: roundIdOf(room), payload: slip({}, payloadOf(room)) },
      deps,
    );
    expect(late.rejection).toMatchObject({ code: 'INVALID_SUBMISSION', submissionCode: 'SLIP_LOCKED' });
  });

  it('accepts slip edits before the first event', () => {
    const { deps } = makeHarness();
    const room = startMarkets(deps);
    const roundId = roundIdOf(room);
    const first = reduceRoom(
      room,
      { type: 'SUBMIT_ANSWER', playerId: P2, roundId, payload: slip({}, payloadOf(room)) },
      deps,
    );
    const edited = reduceRoom(
      first.state,
      {
        type: 'SUBMIT_ANSWER',
        playerId: P2,
        roundId,
        payload: slip({ BTTS: optionFor('BTTS', 'YES') }, payloadOf(room)),
      },
      deps,
    );
    expect(edited.rejection).toBeNull();
    expect(edited.events[0]).toMatchObject({ type: 'SUBMISSION_ACCEPTED', replaced: true });
  });
});

describe('N8: M1 end to end through the reducer', () => {
  it('slip → several event batches (with a duplicate) → full time → reveal → leaderboard and tally', () => {
    const { deps, clock } = makeHarness();
    let room = startMarkets(deps);
    const roundId = roundIdOf(room);
    const pp = payloadOf(room);
    const [a, b] = listedScorers('ANYTIME_SCORER', pp);
    if (a === undefined || b === undefined) throw new Error('need listed scorers');

    const hostSlip = slip(
      {
        BTTS: optionFor('BTTS', 'YES', pp),
        ANYTIME_SCORER: scorerOption('ANYTIME_SCORER', b, pp),
        PENALTY_AWARDED: optionFor('PENALTY_AWARDED', 'NO', pp),
      },
      pp,
    );
    const guestSlip = slip(
      {
        BTTS: optionFor('BTTS', 'NO', pp),
        ANYTIME_SCORER: scorerOption('ANYTIME_SCORER', a, pp),
        PENALTY_AWARDED: optionFor('PENALTY_AWARDED', 'YES', pp),
      },
      pp,
    );
    room = reduceAll(
      room,
      [
        { type: 'SUBMIT_ANSWER', playerId: HOST, roundId, payload: hostSlip },
        { type: 'SUBMIT_ANSWER', playerId: P2, roundId, payload: guestSlip },
      ],
      deps,
    ).state;
    // P3 never files a slip.

    const goalA = { ...goalBy(a, 12), id: 'goal-a' };
    const batch1 = [
      matchEvent('KICK_OFF', { minute: 0, id: 'ko' }),
      goalA,
      matchEvent('CORNER', { minute: 14, id: 'c1' }),
    ];
    const batch2 = [goalA, { ...goalBy(b, 38), id: 'goal-b' }]; // goal-a duplicated by the next poll
    const batch3 = [
      matchEvent('HALF_TIME', { minute: 45, id: 'ht' }),
      { ...goal(AWAY_TEAM_ID, 20, 70), id: 'goal-away' },
    ];

    clock.advance(60_000);
    const first = reduceRoom(room, { type: 'MATCH_EVENTS', events: batch1 }, deps);
    const second = reduceRoom(first.state, { type: 'MATCH_EVENTS', events: batch2 }, deps);
    const replay = reduceRoom(second.state, { type: 'MATCH_EVENTS', events: batch2 }, deps);
    expect(replay.state).toBe(second.state); // a full duplicate batch changes nothing
    const third = reduceRoom(second.state, { type: 'MATCH_EVENTS', events: batch3 }, deps);
    expect(third.state.phase).toBe('playing');
    expect(currentRound(third.state)?.observedEventIds).toEqual([
      'ko',
      'goal-a',
      'c1',
      'goal-b',
      'ht',
      'goal-away',
    ]);

    const counters = (currentRound(third.state)?.publicPayload as M1Public).counters;
    const homeIds = new Set(
      ALL_BUILT.filter((entry) => entry.player.teamId === HOME_TEAM_ID).map((e) => e.player.id),
    );
    const expectedHome = [a, b].filter((id) => homeIds.has(id)).length;
    expect(counters.homeGoals + counters.awayGoals).toBe(3);
    expect(counters.homeGoals).toBe(expectedHome);

    // Pre-reveal, rivals' slips are hidden from each other.
    const guestView = projectFor(third.state, P2, deps);
    expect(guestView.round?.yourSubmission).toEqual(guestSlip);
    expect(JSON.stringify(guestView.round)).not.toContain(JSON.stringify(hostSlip.picks));
    expect(guestView.round).not.toHaveProperty('solution');

    const done = reduceRoom(
      third.state,
      { type: 'MATCH_EVENTS', events: [matchEvent('FULL_TIME', { minute: 90, id: 'ft' })] },
      deps,
    );
    expect(done.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['ROUND_UPDATED', 'ROUND_LOCKED', 'ROUND_REVEALED', 'PHASE_CHANGED']),
    );
    const finalRoom = done.state;
    expect(finalRoom.phase).toBe('roundReveal');

    const view = projectFor(finalRoom, HOST, deps);
    if (view.round?.visibility !== 'revealed') throw new Error('expected a revealed round');
    expect((view.round.solution as M1Solution).settled).toBe(true);
    expect(view.round.submissions).toHaveLength(2);

    // Both scorer picks won — nobody lost a sip on ANYTIME_SCORER.
    expect(
      finalRoom.penalties.some(
        (entry) => entry.meta?.marketId === 'ANYTIME_SCORER' && entry.reason === 'LOST_MARKET',
      ),
    ).toBe(false);
    // P2 lost BTTS (both scored) and PENALTY_AWARDED (none awarded) — charged once each.
    const guestLosses = finalRoom.penalties.filter(
      (entry) => entry.recipientId === P2 && entry.reason === 'LOST_MARKET',
    );
    expect(guestLosses.filter((entry) => entry.meta?.marketId === 'BTTS')).toHaveLength(1);
    expect(guestLosses.filter((entry) => entry.meta?.marketId === 'PENALTY_AWARDED')).toHaveLength(1);
    expect(
      finalRoom.penalties.some((entry) => entry.recipientId === P3 && entry.reason === 'NO_ANSWER'),
    ).toBe(true);

    // Leaderboard and tally agree with the recorded penalties.
    for (const player of finalRoom.players) {
      const owed = finalRoom.penalties
        .filter((entry) => entry.recipientId === player.id)
        .reduce((sum, entry) => sum + entry.appliedSips, 0);
      expect(player.sips).toBe(owed);
      expect(view.drinkTally.find((row) => row.playerId === player.id)?.sips).toBe(owed);
    }
    const hostRow = view.leaderboard.find((row) => row.playerId === HOST);
    const guestRow = view.leaderboard.find((row) => row.playerId === P2);
    expect(hostRow?.score ?? 0).toBeGreaterThan(guestRow?.score ?? 0);
    expect(view.leaderboard[0]?.playerId).toBe(HOST);
    expect(finalRoom.players.every((player) => player.sips <= finalRoom.settings.penaltyCaps.perRound)).toBe(
      true,
    );
  });
});

/* ---------- QA re-verification finding: a manual lock must never silently ---------- */
/* --------------------- starve a long-running-bet round of events -------------------- */

describe('a long-running-bet round can never be manually locked', () => {
  it('refuses LOCK_ROUND before any live event, and the round keeps processing events normally', () => {
    const { deps } = makeHarness();
    const room = startMarkets(deps);
    const roundId = roundIdOf(room);

    const result = reduceRoom(room, { type: 'LOCK_ROUND', actorId: HOST }, deps);
    expect(result.rejection).toMatchObject({ code: 'ROUND_NOT_LOCKABLE', detail: 'long-running-bet' });
    expect(result.state).toBe(room); // rejected: identical state, nothing silently mutated
    expect(currentRound(result.state)?.status).toBe('open');

    // The round is unharmed: live events keep folding in as if the lock attempt never happened.
    const observed = reduceRoom(
      room,
      { type: 'MATCH_EVENTS', events: [matchEvent('CORNER', { minute: 5 })] },
      deps,
    );
    expect(observed.rejection).toBeNull();
    expect((currentRound(observed.state)?.publicPayload as M1Public).counters.corners).toBe(1);
    expect(roundId).toBe(roundIdOf(room));
  });

  it('refuses SYSTEM_LOCK_ROUND the same way', () => {
    const { deps } = makeHarness();
    const room = startMarkets(deps);
    const result = reduceRoom(room, { type: 'SYSTEM_LOCK_ROUND' }, deps);
    expect(result.rejection).toMatchObject({ code: 'ROUND_NOT_LOCKABLE' });
    expect(result.state).toBe(room);
  });

  it("refuses LOCK_ROUND after partial settlement, and a batch sent immediately after still folds in (QA's probe, part 1)", () => {
    const { deps } = makeHarness();
    let room = startMarkets(deps);
    const roundId = roundIdOf(room);
    room = reduceRoom(
      room,
      { type: 'SUBMIT_ANSWER', playerId: HOST, roundId, payload: slip({}, payloadOf(room)) },
      deps,
    ).state;
    room = reduceRoom(
      room,
      { type: 'SUBMIT_ANSWER', playerId: P2, roundId, payload: slip({}, payloadOf(room)) },
      deps,
    ).state;

    // Partially settle: HALF_TIME closes HT_RESULT (and possibly others), but the match is far from over.
    room = reduceRoom(
      room,
      { type: 'MATCH_EVENTS', events: [matchEvent('HALF_TIME', { minute: 45 })] },
      deps,
    ).state;
    const settledBefore = payloadOf(room).settlements.length;
    expect(settledBefore).toBeGreaterThan(0);
    expect(settledBefore).toBeLessThan(payloadOf(room).markets.length);

    const lockAttempt = reduceRoom(room, { type: 'LOCK_ROUND', actorId: HOST }, deps);
    expect(lockAttempt.rejection).toMatchObject({ code: 'ROUND_NOT_LOCKABLE' });
    expect(lockAttempt.state).toBe(room);
    expect(currentRound(lockAttempt.state)?.status).toBe('open');

    // Because the lock was refused, GOAL and FULL_TIME still fold in and the round grades in full —
    // this is the QA probe: previously REVEAL_ROUND graded only 1/11 markets after a lock like this.
    room = reduceRoom(
      room,
      { type: 'MATCH_EVENTS', events: [goal(HOME_TEAM_ID, 0, 60), matchEvent('FULL_TIME', { minute: 90 })] },
      deps,
    ).state;
    expect(room.phase).toBe('roundReveal');
    const round = currentRound(room);
    expect(round?.status).toBe('resolved');
    const solution = round?.solution as M1Solution;
    expect(solution.settled).toBe(true);
    // Every market closes by full time (HALF_TIME was already observed, so HT_RESULT closed too).
    const closedMarketIds = new Set(solution.settlements.map((entry) => entry.marketId));
    expect(closedMarketIds.size).toBe(payloadOf(room).markets.length);
    expect(round?.outcome?.summary).toMatchObject({
      settled: true,
      gradedMarkets: payloadOf(room).markets.length,
    });
  });

  it('charges no non-submitter sips for markets that were never graded when a lock attempt is refused before any event (QA probe, part 2)', () => {
    const { deps } = makeHarness();
    const room = startMarkets(deps);
    const rejected = reduceRoom(room, { type: 'LOCK_ROUND', actorId: HOST }, deps);
    expect(rejected.rejection).not.toBeNull();
    // The room never left `playing`, so REVEAL_ROUND was never triggered and nobody was charged yet.
    expect(rejected.state.phase).toBe('playing');
    expect(rejected.state.penalties).toEqual([]);
    expect(rejected.state.players.every((player) => player.sips === 0)).toBe(true);
  });
});
