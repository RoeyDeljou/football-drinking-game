import type { Fixture, MatchEvent } from '@fdg/football-data';
import { describe, expect, it } from 'vitest';
import type { Harness } from '../harness.test-utils.js';
import {
  AWAY_TEAM_ID,
  FIXTURE,
  generateWith,
  HOME_TEAM_ID,
  HOST,
  makeHarness,
  matchEvent,
  mustGenerate,
  newRoom,
  P2,
  P3,
  sampleData,
  T0,
} from '../harness.test-utils.js';
import type { PlayerId } from '../ids.js';
import { asPlayerId } from '../ids.js';
import { createSeededRng } from '../ports.js';
import { projectFor } from '../projection.js';
import type { EngineDeps, Reduction } from '../reducer.js';
import { reduceAll, reduceRoom } from '../reducer.js';
import type { RoomState } from '../state.js';
import { currentRound, mergeRoomSettings } from '../state.js';
import { PSG_SLOVAN_EVENTS, PSG_SLOVAN_FIXTURE } from './fixtures/psg-slovan-401915445.test-utils.js';
import { LIVE_EVENT_KINDS, liveEventKindOf, liveEventSideOf, orderLiveBatch } from './live-event-kinds.js';
import { isMixable } from './mixed.js';
import type { BingoCellSpec, M6Card, M6PublicPayload, M6Solution } from './m6-match-bingo.js';
import {
  bingoCellId,
  bingoLines,
  dealBingoCards,
  M6_CARD_MIX,
  M6_CELL_TIERS,
  M6_DEFAULT_CONFIG,
  M6_ID,
  m6MatchBingo as module,
  tickBingoCards,
} from './m6-match-bingo.js';

const LIVE_FIXTURE: Fixture = { ...FIXTURE, status: 'LIVE', kickoff: new Date(T0 - 3_600_000).toISOString() };
const UPCOMING_FIXTURE: Fixture = { ...FIXTURE, status: 'SCHEDULED', kickoff: new Date(T0 + 3_600_000).toISOString() };

const ev = (id: string, type: MatchEvent['type'], minute: number, teamId: string | null = HOME_TEAM_ID, extraMinute: number | null = null): MatchEvent =>
  matchEvent(type, { id, minute, extraMinute, teamId: teamId as typeof HOME_TEAM_ID | null });

const HISTORY: readonly MatchEvent[] = [ev('ko', 'KICK_OFF', 0, null), ev('c10', 'CORNER', 10), ev('f30', 'FOUL', 30)];

/** A hand-built card: row-major cells, fresh. */
const card = (playerId: PlayerId, cells: readonly BingoCellSpec[]): M6Card => ({
  playerId,
  cells: cells.map((cell) => ({ id: bingoCellId(cell), ...cell, progress: 0, ticked: false, tickedAt: null })),
  lines: [],
  fullHouse: false,
});
const c = (event: BingoCellSpec['event'], count = 1, side: BingoCellSpec['side'] = null): BingoCellSpec => ({ event, side, count });

/** A 3×3 card whose top row is corners, middle row fouls, bottom row shots on target. */
const ROWS_CARD = (playerId: PlayerId): M6Card =>
  card(playerId, [c('CORNER'), c('CORNER'), c('CORNER'), c('FOUL'), c('FOUL', 2), c('FOUL', 3), c('SHOT_ON_TARGET'), c('SHOT_ON_TARGET'), c('SHOT_ON_TARGET')]);

const start = (harness: Harness, options: { config?: unknown; seed?: number; players?: readonly PlayerId[] } = {}): RoomState => {
  const result = reduceAll(
    newRoom(T0, options.seed ?? 42),
    [
      ...(options.players ?? [P2, P3]).map((playerId) => ({ type: 'PLAYER_JOIN' as const, playerId, nickname: playerId, isGuest: true })),
      { type: 'SELECT_GAME', actorId: HOST, moduleId: M6_ID, config: options.config ?? null },
      { type: 'START_SESSION', actorId: HOST },
    ],
    harness.deps,
  );
  expect(result.rejection).toBeNull();
  return result.state;
};
const feed = (room: RoomState, deps: EngineDeps, events: readonly MatchEvent[]): Reduction =>
  reduceRoom(room, { type: 'MATCH_EVENTS', events }, deps);
const payloadOf = (room: RoomState): M6PublicPayload => currentRound(room)?.publicPayload as M6PublicPayload;
const solutionOf = (room: RoomState): M6Solution => currentRound(room)?.solution as M6Solution;
const roundPenalties = (room: RoomState) => room.penalties.filter((entry) => entry.roundId === currentRound(room)?.id);

/** Replace the stored cards of the current round (tests with hand-built cards). */
const withCards = (room: RoomState, cards: readonly M6Card[]): RoomState => {
  const session = room.sessions[room.sessions.length - 1];
  const round = session?.rounds[session.rounds.length - 1];
  if (session === undefined || round === undefined) throw new Error('no round');
  const publicPayload = { ...(round.publicPayload as M6PublicPayload), cards };
  return {
    ...room,
    sessions: [...room.sessions.slice(0, -1), { ...session, rounds: [...session.rounds.slice(0, -1), { ...round, publicPayload }] }],
  };
};

/** Mid-match room baselined at 30', host holding ROWS_CARD, the others blank-ish cards of GOAL×2. */
const handRoom = (config: Partial<typeof M6_DEFAULT_CONFIG> = {}) => {
  const harness = makeHarness({ data: sampleData({ fixture: LIVE_FIXTURE }) });
  let room = start(harness, { config: { ...M6_DEFAULT_CONFIG, ...config } });
  room = feed(room, harness.deps, HISTORY).state;
  const hard = (playerId: PlayerId) => card(playerId, Array.from({ length: 9 }, () => c('GOAL', 2)));
  return { harness, room: withCards(room, [ROWS_CARD(HOST), hard(P2), hard(P3)]) };
};

/* --------------------------------- contract -------------------------------- */

describe('M6 contract and cards', () => {
  it('is a live private-card round on the since-round-open window, never mixed, taking no submissions', () => {
    expect(module.kind).toBe('private-card');
    expect(module.supportsLiveEvents).toBe(true);
    expect(module.liveEventWindow).toBe('since-round-open');
    expect(isMixable(module, 'matchday')).toBe(false);
    expect(module.parseConfig({ ...M6_DEFAULT_CONFIG, size: 5 }).ok).toBe(false);
    expect(module.parseConfig({ ...M6_DEFAULT_CONFIG, size: 4 }).ok).toBe(true);
    expect(module.parseConfig({ ...M6_DEFAULT_CONFIG, fullHouseSips: 11 }).ok).toBe(false);
    const { harness, room } = handRoom();
    const submit = reduceRoom(room, { type: 'SUBMIT_ANSWER', playerId: HOST, roundId: currentRound(room)?.id ?? ('' as never), payload: {} }, harness.deps);
    expect(submit.rejection?.submissionCode).toBe('NOT_ALLOWED');
  });

  it('only uses cells the live feed can tick', () => {
    for (const cell of [...M6_CELL_TIERS.common, ...M6_CELL_TIERS.medium, ...M6_CELL_TIERS.rare]) {
      expect(LIVE_EVENT_KINDS).toContain(cell.event);
      expect(cell.count).toBeGreaterThanOrEqual(1);
    }
  });

  it('deals each player a different card with the tier mix of its size, deterministically', () => {
    const ids = Array.from({ length: 12 }, (_, index) => asPlayerId(`p${index}`));
    for (const size of [3, 4] as const) {
      const cards = dealBingoCards(ids, size, createSeededRng(9));
      expect(dealBingoCards(ids, size, createSeededRng(9))).toEqual(cards);
      expect(new Set(cards.map((entry) => entry.cells.map((cell) => cell.id).join('|'))).size).toBe(ids.length);
      for (const entry of cards) {
        expect(entry.cells).toHaveLength(size * size);
        expect(new Set(entry.cells.map((cell) => cell.id)).size).toBe(size * size);
        const tierOf = (id: string) =>
          (['common', 'medium', 'rare'] as const).find((tier) => M6_CELL_TIERS[tier].some((cell) => bingoCellId(cell) === id));
        const mix = { common: 0, medium: 0, rare: 0 };
        for (const cell of entry.cells) mix[tierOf(cell.id) ?? 'common'] += 1;
        expect(mix).toEqual(M6_CARD_MIX[size]);
      }
    }
  });

  it('has rows, columns and both diagonals as lines', () => {
    expect(bingoLines(3).map((line) => line.id)).toEqual(['row-0', 'row-1', 'row-2', 'col-0', 'col-1', 'col-2', 'diag-main', 'diag-anti']);
    expect(bingoLines(3).find((line) => line.id === 'diag-anti')?.cells).toEqual([2, 4, 6]);
    expect(bingoLines(4)).toHaveLength(10);
  });

  it('deals every player at generation; refuses without a fixture or after it is over', () => {
    const round = mustGenerate(module, { players: [HOST, P2, P3], data: sampleData({ fixture: LIVE_FIXTURE }) });
    expect((round.publicPayload as M6PublicPayload).cards.map((entry) => entry.playerId)).toEqual([HOST, P2, P3]);
    expect(round.answerWindowMs).toBeNull();
    expect(generateWith(module, { data: sampleData({ fixture: null }) })).toMatchObject({ ok: false, reason: 'INSUFFICIENT_DATA' });
    expect(generateWith(module, { data: sampleData({ fixture: { ...FIXTURE, status: 'CANCELLED' } }) })).toMatchObject({
      ok: false,
      reason: 'WRONG_ROUND_CONTEXT',
    });
  });
});

describe('tickBingoCards (pure)', () => {
  it('counts matching events up to the cell count, honouring the side', () => {
    const one = card(HOST, [c('CORNER', 2), c('CORNER', 1, 'away'), c('GOAL', 1, 'away'), ...Array.from({ length: 6 }, () => c('CARD', 5))]);
    let cards = [one];
    for (const event of [ev('c1', 'CORNER', 1), ev('c2', 'CORNER', 2), ev('c3', 'CORNER', 3), ev('og', 'OWN_GOAL', 4, HOME_TEAM_ID)]) {
      cards = [...tickBingoCards(cards, event, 3, HOME_TEAM_ID, AWAY_TEAM_ID).cards];
    }
    const [twoCorners, awayCorner, awayGoal] = cards[0]?.cells ?? [];
    expect(twoCorners).toMatchObject({ progress: 2, ticked: true, tickedAt: { minute: 2, extraMinute: null } });
    expect(awayCorner).toMatchObject({ progress: 0, ticked: false });
    // A home player's own goal is a goal for the away side.
    expect(awayGoal).toMatchObject({ ticked: true });
  });

  it('reports each line once, several lines on one event, and the full house', () => {
    let cards: readonly M6Card[] = [ROWS_CARD(HOST)];
    const step = (event: MatchEvent) => {
      const tick = tickBingoCards(cards, event, 3, HOME_TEAM_ID, AWAY_TEAM_ID);
      cards = tick.cards;
      return tick;
    };
    expect(step(ev('c', 'CORNER', 1)).newLines).toEqual([{ playerId: HOST, line: 'row-0' }]);
    expect(step(ev('c2', 'CORNER', 2)).newLines).toEqual([]);
    step(ev('f1', 'FOUL', 3));
    step(ev('f2', 'FOUL', 4));
    expect(step(ev('f3', 'FOUL', 5)).newLines).toEqual([{ playerId: HOST, line: 'row-1' }]);
    const last = step(ev('s', 'SHOT_ON_TARGET', 6));
    expect(last.newLines.map((entry) => entry.line)).toEqual(['row-2', 'col-0', 'col-1', 'col-2', 'diag-main', 'diag-anti']);
    expect(last.newFullHouses).toEqual([HOST]);
    expect(cards[0]?.lines).toHaveLength(8);
    expect(step(ev('s2', 'SHOT_ON_TARGET', 7)).newLines).toEqual([]);
  });

  it('ignores events no cell uses', () => {
    const cards = [ROWS_CARD(HOST)];
    expect(tickBingoCards(cards, ev('ht', 'HALF_TIME', 45, null), 3, HOME_TEAM_ID, AWAY_TEAM_ID).cards).toBe(cards);
  });
});

/* -------------------------------- the round -------------------------------- */

describe('M6 through the reducer', () => {
  it('never ticks the pre-round history', () => {
    const { room } = handRoom();
    // The 10' corner happened before the round: row 0 is untouched.
    expect(payloadOf(room).cards[0]?.cells[0]?.ticked).toBe(false);
    expect(payloadOf(room).clockKnown).toBe(true);
  });

  it('a line makes everyone but its owner drink, once', () => {
    const { harness, room } = handRoom();
    const line = feed(room, harness.deps, [...HISTORY, ev('c31', 'CORNER', 31)]).state;
    const charged = roundPenalties(line);
    expect(charged.map((entry) => entry.recipientId).sort()).toEqual([P2, P3].sort());
    expect(charged.every((entry) => entry.reason === 'BINGO_LINE' && entry.playerId === HOST && entry.appliedSips === 2)).toBe(true);
    expect(charged[0]?.meta).toEqual({ line: 'row-0', eventId: 'c31' });
    const more = feed(line, harness.deps, [...HISTORY, ev('c31', 'CORNER', 31), ev('c32', 'CORNER', 32)]).state;
    expect(roundPenalties(more)).toHaveLength(2);
    expect(more.phase).toBe('playing');
  });

  it('a full house makes the table drink, ends the round and wins it', () => {
    const { harness, room } = handRoom();
    const events = [...HISTORY, ev('c', 'CORNER', 31), ev('f1', 'FOUL', 32), ev('f2', 'FOUL', 33), ev('f3', 'FOUL', 34), ev('s', 'SHOT_ON_TARGET', 35), ev('s2', 'SHOT_ON_TARGET', 36)];
    const done = feed(room, harness.deps, events).state;
    expect(done.phase).toBe('roundReveal');
    expect(solutionOf(done)).toEqual({ status: 'ended', endedBy: 'FULL_HOUSE', fullHouseIds: [HOST] });
    const reasons = roundPenalties(done).filter((entry) => entry.recipientId === P2).map((entry) => entry.reason);
    expect(reasons.filter((reason) => reason === 'BINGO_LINE')).toHaveLength(8);
    expect(reasons).toContain('BINGO_FULL_HOUSE');
    // The table's per-round cap (10) bounds it: 8 lines × 2 + 6 requested.
    expect(done.players.find((player) => player.id === P2)?.sips).toBe(10);
    expect(done.players.find((player) => player.id === HOST)?.sips).toBe(0);
    // The event after the full house was never applied.
    expect(payloadOf(done).cards[0]?.cells[8]?.progress).toBe(1);
    const outcome = currentRound(done)?.outcome;
    expect(outcome?.winnerIds).toEqual([HOST]);
    expect(outcome?.scores.find((entry) => entry.playerId === HOST)).toMatchObject({ correct: true, breakdown: { accuracyFactor: 1 } });
    expect(outcome?.scores.find((entry) => entry.playerId === P2)).toMatchObject({ correct: false, points: 0 });
  });

  it('ends at the regulation whistle; winners are the most lines; points follow ticked cells', () => {
    const { harness, room } = handRoom();
    const ended = feed(room, harness.deps, [...HISTORY, ev('c', 'CORNER', 31), ev('f1', 'FOUL', 50), ev('ft', 'FULL_TIME', 90, null, 4), ev('et', 'SHOT_ON_TARGET', 95)]).state;
    expect(solutionOf(ended)).toEqual({ status: 'ended', endedBy: 'FULL_TIME', fullHouseIds: [] });
    expect(payloadOf(ended).cards[0]?.cells[6]?.ticked).toBe(false);
    const host = currentRound(ended)?.outcome?.scores.find((entry) => entry.playerId === HOST);
    expect(host?.meta).toEqual({ ticked: 4, lines: 1, fullHouse: false });
    expect(currentRound(ended)?.outcome?.winnerIds).toEqual([HOST]);
  });

  it('lineSips / fullHouseSips of 0 turn the drinks off but still play', () => {
    const { harness, room } = handRoom({ lineSips: 0 });
    const line = feed(room, harness.deps, [...HISTORY, ev('c31', 'CORNER', 31)]).state;
    expect(roundPenalties(line)).toEqual([]);
    expect(payloadOf(line).cards[0]?.lines).toEqual(['row-0']);
  });

  it('is void after full time, and a host reveal mid-match ends it without charging', () => {
    const harness = makeHarness({ data: sampleData({ fixture: LIVE_FIXTURE }) });
    const over = feed(start(harness), harness.deps, [...HISTORY, ev('ft', 'FULL_TIME', 90, null, 3)]).state;
    expect(solutionOf(over)).toEqual({ status: 'void', endedBy: 'MATCH_OVER', fullHouseIds: [] });
    expect(currentRound(over)?.outcome?.scores).toEqual([]);

    const { room, harness: h2 } = handRoom();
    const revealed = reduceRoom(room, { type: 'REVEAL_ROUND', actorId: HOST }, h2.deps).state;
    expect(currentRound(revealed)?.outcome?.summary).toMatchObject({ status: 'ended', endedBy: 'HOST' });
    expect(roundPenalties(revealed)).toEqual([]);
  });

  it('a late joiner has no card and no score; cards are public to every viewer', () => {
    const { harness, room } = handRoom();
    const joined = reduceRoom(room, { type: 'PLAYER_JOIN', playerId: asPlayerId('late'), nickname: 'Late', isGuest: true }, harness.deps).state;
    const view = projectFor(joined, asPlayerId('late'), harness.deps).round?.publicPayload as M6PublicPayload;
    expect(view.cards.map((entry) => entry.playerId)).toEqual([HOST, P2, P3]);
    const revealed = reduceRoom(joined, { type: 'REVEAL_ROUND', actorId: HOST }, harness.deps).state;
    expect(currentRound(revealed)?.outcome?.scores.map((entry) => entry.playerId)).toEqual([HOST, P2, P3]);
  });

  it('a card dealt before kickoff ticks from the first poll', () => {
    const harness = makeHarness({ data: sampleData({ fixture: UPCOMING_FIXTURE }) });
    const room = withCards(start(harness), [ROWS_CARD(HOST)]);
    const next = feed(room, harness.deps, [ev('ko', 'KICK_OFF', 0, null), ev('c1', 'CORNER', 1)]).state;
    expect(payloadOf(next).cards[0]?.cells[0]?.ticked).toBe(true);
  });

  it('respects a tighter room cap', () => {
    const { harness, room } = handRoom();
    const capped = { ...room, settings: mergeRoomSettings(room.settings, { penaltyCaps: { perPenalty: 1, perRound: 10, perSession: 60 } }) };
    const line = feed(capped, harness.deps, [...HISTORY, ev('c31', 'CORNER', 31)]).state;
    expect(roundPenalties(line).map((entry) => [entry.requestedSips, entry.appliedSips, entry.cappedBy])).toEqual([
      [2, 1, 'perPenalty'],
      [2, 1, 'perPenalty'],
    ]);
  });
});

/* ------------------------- recorded match: PSG 6-1 Slovan ------------------------- */

describe('M6 against the recorded PSG 6-1 Slovan Bratislava timeline (401915445)', () => {
  const PSG = PSG_SLOVAN_FIXTURE.homeTeam.id;
  const SLOVAN = PSG_SLOVAN_FIXTURE.awayTeam.id;

  it('a hand-built card completes its lines on exactly the right plays, then a full house at 86′', () => {
    const handCard = card(HOST, [
      c('CORNER', 1, 'home'), c('SHOT_ON_TARGET'), c('FOUL', 3),
      c('CARD', 1, 'away'), c('SUBSTITUTION', 1, 'home'), c('GOAL', 1, 'away'),
      c('OFFSIDE', 2), c('SHOT_OFF_TARGET', 3), c('CORNER', 1, 'away'),
    ]);
    let cards: readonly M6Card[] = [handCard];
    const completed: string[] = [];
    let fullHouseAt: string | null = null;
    for (const event of orderLiveBatch(PSG_SLOVAN_EVENTS).ordered) {
      const tick = tickBingoCards(cards, event, 3, PSG, SLOVAN);
      cards = tick.cards;
      completed.push(...tick.newLines.map((entry) => `${entry.line}@${event.minute}`));
      if (tick.newFullHouses.length > 0) {
        fullHouseAt = event.id;
        break;
      }
    }
    expect(completed).toEqual([
      'row-0@12',
      'col-0@53',
      'row-1@64',
      'col-1@64',
      'diag-anti@64',
      'row-2@86',
      'col-2@86',
      'diag-main@86',
    ]);
    expect(fullHouseAt).toBe('espn:52141164');
  });

  it('dealt before kickoff and fed poll by poll, every card matches an independent recount when it ends', () => {
    const upcoming = { ...PSG_SLOVAN_FIXTURE, status: 'SCHEDULED' as const, kickoff: new Date(T0 + 60_000).toISOString() };
    const players = Array.from({ length: 5 }, (_, index) => asPlayerId(`q${index + 1}`));
    for (const seed of [1, 7, 42, 2024]) {
      const harness = makeHarness({ data: sampleData({ fixture: upcoming, lineups: null }) });
      let room = start(harness, { seed, players });
      let last = -1;
      for (let index = 0; index < PSG_SLOVAN_EVENTS.length && room.phase === 'playing'; index += 1) {
        room = feed(room, harness.deps, PSG_SLOVAN_EVENTS.slice(0, index + 1)).state;
        last = index;
      }
      const solution = solutionOf(room);
      expect(solution.status).toBe('ended');
      expect(['FULL_HOUSE', 'FULL_TIME']).toContain(solution.endedBy);
      const seen = PSG_SLOVAN_EVENTS.slice(0, last + 1);
      for (const entry of payloadOf(room).cards) {
        for (const cell of entry.cells) {
          const matches = seen.filter(
            (event) => liveEventKindOf(event) === cell.event && (cell.side === null || liveEventSideOf(event, PSG, SLOVAN) === cell.side),
          ).length;
          expect(cell.progress).toBe(Math.min(cell.count, matches));
        }
        // Every completed line charged each other player exactly once (before caps).
        const lineCharges = room.penalties.filter((penalty) => penalty.reason === 'BINGO_LINE' && penalty.playerId === entry.playerId);
        expect(lineCharges).toHaveLength(entry.lines.length * (players.length));
      }
      if (solution.endedBy === 'FULL_HOUSE') expect(solution.fullHouseIds.length).toBeGreaterThan(0);
    }
  });
});
