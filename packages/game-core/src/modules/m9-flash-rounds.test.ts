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
import { projectFor } from '../projection.js';
import type { EngineDeps, Reduction } from '../reducer.js';
import { reduceAll, reduceRoom } from '../reducer.js';
import type { RoomState } from '../state.js';
import { currentRound } from '../state.js';
import { PSG_SLOVAN_EVENTS, PSG_SLOVAN_FIXTURE } from './fixtures/psg-slovan-401915445.test-utils.js';
import { isMixable } from './mixed.js';
import type { M9Answer, M9PublicPayload, M9Question, M9QuestionType, M9Solution } from './m9-flash-rounds.js';
import {
  buildM9Question,
  M9_DEFAULT_CONFIG,
  M9_ID,
  m9ContentKey,
  m9FlashRounds as module,
  QUESTION_TYPES,
  settleM9,
} from './m9-flash-rounds.js';

const LIVE_FIXTURE: Fixture = { ...FIXTURE, status: 'LIVE', kickoff: new Date(T0 - 3_600_000).toISOString() };
const UPCOMING_FIXTURE: Fixture = { ...FIXTURE, status: 'SCHEDULED', kickoff: new Date(T0 + 3_600_000).toISOString() };

const ev = (
  id: string,
  type: MatchEvent['type'],
  minute: number,
  teamId: string | null = HOME_TEAM_ID,
  extraMinute: number | null = null,
): MatchEvent => matchEvent(type, { id, minute, extraMinute, teamId: teamId as typeof HOME_TEAM_ID | null });

/** History to 30': the question's window starts at 32' with the default 2' lead. */
const HISTORY: readonly MatchEvent[] = [ev('ko', 'KICK_OFF', 0, null), ev('f30', 'FOUL', 30)];

const start = (
  harness: Harness,
  options: { types?: readonly M9QuestionType[]; seed?: number; players?: readonly PlayerId[] } = {},
): RoomState => {
  const result = reduceAll(
    newRoom(T0, options.seed ?? 42),
    [
      ...(options.players ?? [P2, P3]).map((playerId) => ({ type: 'PLAYER_JOIN' as const, playerId, nickname: playerId, isGuest: true })),
      { type: 'UPDATE_SETTINGS', actorId: HOST, patch: { roundsPerSession: 12 } },
      { type: 'SELECT_GAME', actorId: HOST, moduleId: M9_ID, config: { ...M9_DEFAULT_CONFIG, types: options.types ?? QUESTION_TYPES } },
      { type: 'START_SESSION', actorId: HOST },
    ],
    harness.deps,
  );
  expect(result.rejection).toBeNull();
  return result.state;
};
const feed = (room: RoomState, deps: EngineDeps, events: readonly MatchEvent[]): Reduction =>
  reduceRoom(room, { type: 'MATCH_EVENTS', events }, deps);
const answer = (room: RoomState, deps: EngineDeps, playerId: PlayerId, value: unknown): Reduction =>
  reduceRoom(room, { type: 'SUBMIT_ANSWER', playerId, roundId: currentRound(room)?.id ?? ('' as never), payload: { answer: value } }, deps);
const payloadOf = (room: RoomState): M9PublicPayload => currentRound(room)?.publicPayload as M9PublicPayload;
const solutionOf = (room: RoomState): M9Solution => currentRound(room)?.solution as M9Solution;
const questionOf = (room: RoomState): M9Question => {
  const question = payloadOf(room).question;
  if (question === null) throw new Error('no question');
  return question;
};

/** A mid-match round of one type, asked at 30' (window from 32'). */
const asked = (type: M9QuestionType, options: { seed?: number } = {}) => {
  const harness = makeHarness({ data: sampleData({ fixture: LIVE_FIXTURE }) });
  const room = feed(start(harness, { types: [type], seed: options.seed }), harness.deps, HISTORY).state;
  return { harness, room };
};

const q = (type: M9QuestionType, startMinute: number, endMinute: number, extra: Partial<M9Question> = {}): M9Question => ({
  type,
  startMinute,
  endMinute,
  options: type === 'NEXT_GOAL_SIDE' || type === 'NEXT_CARD_SIDE' ? ['HOME', 'AWAY', 'NONE'] : ['YES', 'NO'],
  line: null,
  side: null,
  ...extra,
});

/* --------------------------------- contract -------------------------------- */

describe('M9 contract and generation', () => {
  it('is a live long-running round on the since-round-open window, standalone', () => {
    expect(module.kind).toBe('long-running-bet');
    expect(module.liveEventWindow).toBe('since-round-open');
    expect(module.supportsLiveEvents).toBe(true);
    expect(module.supportsLiveStats).toBe(false);
    expect(isMixable(module, 'matchday')).toBe(false);
    expect(module.parseConfig({ ...M9_DEFAULT_CONFIG, answerWindowMs: 5_000 }).ok).toBe(false);
    expect(module.parseConfig({ ...M9_DEFAULT_CONFIG, types: ['GOAL_IN_WINDOW', 'GOAL_IN_WINDOW'] }).ok).toBe(false);
  });

  it('never repeats the previous question type; one-type configs may repeat', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      for (const previous of QUESTION_TYPES) {
        const round = mustGenerate(module, { seed, data: sampleData({ fixture: LIVE_FIXTURE }), usedContentKeys: [m9ContentKey(FIXTURE.id, previous, 1)] });
        expect((round.publicPayload as M9PublicPayload).questionType).not.toBe(previous);
      }
    }
    const seen = new Set(
      Array.from({ length: 60 }, (_, seed) => (mustGenerate(module, { seed, data: sampleData({ fixture: LIVE_FIXTURE }) }).publicPayload as M9PublicPayload).questionType),
    );
    expect(seen.size).toBe(QUESTION_TYPES.length);
    const only = mustGenerate(module, {
      config: { ...M9_DEFAULT_CONFIG, types: ['CORNERS_OVER'] },
      usedContentKeys: [m9ContentKey(FIXTURE.id, 'CORNERS_OVER', 1)],
      data: sampleData({ fixture: LIVE_FIXTURE }),
    });
    expect((only.publicPayload as M9PublicPayload).questionType).toBe('CORNERS_OVER');
  });

  it('asks nothing until the clock is known mid-match; before kickoff it asks at once from minute 0', () => {
    const live = mustGenerate(module, { data: sampleData({ fixture: LIVE_FIXTURE }) });
    expect(live.publicPayload).toMatchObject({ question: null, questionAt: null, answersCloseAt: null });
    expect(live.answerWindowMs).toBeNull();
    expect((live.solution as M9Solution).draws).toHaveLength(3);
    const early = mustGenerate(module, { data: sampleData({ fixture: UPCOMING_FIXTURE }), now: T0 });
    expect((early.publicPayload as M9PublicPayload).question?.startMinute).toBe(0);
    expect(early.publicPayload).toMatchObject({ questionAt: T0, answersCloseAt: T0 + 20_000 });
    expect(mustGenerate(module, { seed: 5 })).toEqual(mustGenerate(module, { seed: 5 }));
    expect(generateWith(module, { data: sampleData({ fixture: null }) })).toMatchObject({ ok: false, reason: 'INSUFFICIENT_DATA' });
    expect(generateWith(module, { data: sampleData({ fixture: { ...FIXTURE, status: 'FINISHED' } }) })).toMatchObject({ ok: false });
  });
});

/* ------------------------------ question builder ------------------------------ */

describe('buildM9Question (pure)', () => {
  const build = (type: M9QuestionType, latestMinute: number | null, history: readonly MatchEvent[] = [], draws = [0.5, 0.2, 0.5]) =>
    buildM9Question({ type, draws, history, latestMinute, leadMinutes: 2, homeTeamId: HOME_TEAM_ID, awayTeamId: AWAY_TEAM_ID });

  it('starts the window a lead after the feed’s minute (0 before kickoff) and never reaches past 90', () => {
    expect(build('GOAL_IN_WINDOW', 30)?.startMinute).toBe(32);
    expect(build('GOAL_IN_WINDOW', null)?.startMinute).toBe(0);
    expect(build('GOAL_IN_WINDOW', 85)).toMatchObject({ startMinute: 87, endMinute: 90 });
    expect(build('GOAL_IN_WINDOW', 86)).toBeNull();
    for (const type of QUESTION_TYPES) {
      for (let minute = 0; minute <= 85; minute += 5) {
        const question = build(type, minute);
        expect(question?.endMinute).toBeLessThanOrEqual(90);
        expect((question?.endMinute ?? 0) - (question?.startMinute ?? 0)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('sizes the goal window for even odds, shorter when the match is goal-heavy, jittered ±2 by the draw', () => {
    const quiet = build('GOAL_IN_WINDOW', 30);
    const goals = [10, 15, 20, 25].map((minute, index) => ev(`g${index}`, 'GOAL', minute));
    const busy = build('GOAL_IN_WINDOW', 30, goals);
    // Quiet: (0 + 1.35) / 75 per minute → ln2/rate ≈ 39 → capped at 25. Busy: 5.35/75 → ≈ 10.
    expect((quiet?.endMinute ?? 0) - 32).toBe(25);
    expect((busy?.endMinute ?? 0) - 32).toBe(10);
    const low = build('GOAL_IN_WINDOW', 30, goals, [0, 0, 0]);
    const high = build('GOAL_IN_WINDOW', 30, goals, [0.99, 0, 0]);
    expect((low?.endMinute ?? 0) - 32).toBe(8);
    expect((high?.endMinute ?? 0) - 32).toBe(12);
  });

  it('sets the corners line from the live corner pace, and picks the shot-on-target team by draw', () => {
    const corners = Array.from({ length: 12 }, (_, index) => ev(`c${index}`, 'CORNER', index * 2));
    // (12 + 4.5) / 75 per minute × 10 minutes = 2.2 → line 2 ("more than 2").
    expect(build('CORNERS_OVER', 30, corners)?.line).toBe(2);
    expect(build('CORNERS_OVER', 30)?.line).toBe(0);
    expect(build('TEAM_SHOT_ON_TARGET', 30, [], [0.5, 0.2, 0])?.side).toBe('home');
    expect(build('TEAM_SHOT_ON_TARGET', 30, [], [0.5, 0.8, 0])?.side).toBe('away');
    expect(build('NEXT_GOAL_SIDE', 30)?.options).toEqual(['HOME', 'AWAY', 'NONE']);
  });
});

/* -------------------------------- settlement -------------------------------- */

describe('settleM9 (pure)', () => {
  const settle = (question: M9Question, events: readonly MatchEvent[], count = 0) => settleM9(question, count, events, HOME_TEAM_ID, AWAY_TEAM_ID);

  it('ignores the lead zone, settles YES early on a goal, NO at the first event past the window', () => {
    const question = q('GOAL_IN_WINDOW', 32, 40);
    expect(settle(question, [ev('g31', 'GOAL', 31)])).toMatchObject({ answer: null });
    expect(settle(question, [ev('g33', 'GOAL', 33)])).toMatchObject({ answer: 'YES', settledBy: 'EVENT', eventId: 'g33' });
    expect(settle(question, [ev('f39', 'FOUL', 39), ev('g40', 'GOAL', 40)])).toMatchObject({ answer: 'NO', settledBy: 'WINDOW_END', eventId: 'g40' });
    expect(settle(question, [ev('ft', 'FULL_TIME', 90, null)])).toMatchObject({ answer: 'NO', settledBy: 'FULL_TIME' });
  });

  it('next goal / card sides, own goals credited to the opponent, NONE at the end', () => {
    expect(settle(q('NEXT_GOAL_SIDE', 32, 50), [ev('og', 'OWN_GOAL', 35, HOME_TEAM_ID)])).toMatchObject({ answer: 'AWAY' });
    expect(settle(q('NEXT_GOAL_SIDE', 32, 50), [ev('x', 'CORNER', 50)])).toMatchObject({ answer: 'NONE' });
    expect(settle(q('NEXT_CARD_SIDE', 32, 50), [ev('y', 'YELLOW_CARD', 33, AWAY_TEAM_ID)])).toMatchObject({ answer: 'AWAY' });
    expect(settle(q('NEXT_CARD_SIDE', 32, 50), [ev('r', 'RED_CARD', 34, HOME_TEAM_ID)])).toMatchObject({ answer: 'HOME' });
  });

  it('corners over the line settle early; the count carries across batches', () => {
    const question = q('CORNERS_OVER', 32, 42, { line: 1 });
    const one = settle(question, [ev('c1', 'CORNER', 33)]);
    expect(one).toMatchObject({ answer: null, count: 1 });
    expect(settle(question, [ev('c2', 'CORNER', 34)], one.count)).toMatchObject({ answer: 'YES', count: 2, eventId: 'c2' });
  });

  it('a team’s shot on target counts saves and goals, not the other team or own goals', () => {
    const question = q('TEAM_SHOT_ON_TARGET', 32, 42, { side: 'away' });
    expect(settle(question, [ev('h', 'SHOT_ON_TARGET', 33, HOME_TEAM_ID), ev('og', 'OWN_GOAL', 34, HOME_TEAM_ID)])).toMatchObject({ answer: null });
    expect(settle(question, [ev('s', 'SAVE', 35, AWAY_TEAM_ID)])).toMatchObject({ answer: 'YES' });
    expect(settle(question, [ev('g', 'GOAL', 36, AWAY_TEAM_ID)])).toMatchObject({ answer: 'YES' });
  });

  it('spans half-time on scoreboard minutes: 45+3 and 46 are inside a 42-50 window', () => {
    const question = q('CORNERS_OVER', 42, 50, { line: 1 });
    const batch = [ev('c45', 'CORNER', 45, HOME_TEAM_ID, 3), ev('ht', 'HALF_TIME', 45, null, 4), ev('c46', 'CORNER', 46)];
    expect(settle(question, batch)).toMatchObject({ answer: 'YES', eventId: 'c46', count: 2 });
  });
});

/* ------------------------------ through the reducer ------------------------------ */

describe('M9 through the reducer', () => {
  it('answers: only once the question exists, only its options, only in the answer window, once', () => {
    const harness = makeHarness({ data: sampleData({ fixture: LIVE_FIXTURE }) });
    const before = start(harness, { types: ['GOAL_IN_WINDOW'] });
    expect(answer(before, harness.deps, HOST, 'YES').rejection).toMatchObject({ submissionCode: 'NOT_ALLOWED', detail: 'NO_QUESTION_YET' });
    harness.clock.advance(3_000);
    const room = feed(before, harness.deps, HISTORY).state;
    expect(payloadOf(room)).toMatchObject({ questionAt: T0 + 3_000, answersCloseAt: T0 + 23_000, clockKnown: true });
    expect(answer(room, harness.deps, HOST, 'HOME').rejection?.submissionCode).toBe('UNKNOWN_OPTION');
    expect(answer(room, harness.deps, HOST, 'MAYBE').rejection?.submissionCode).toBe('SCHEMA');
    const once = answer(room, harness.deps, HOST, 'YES');
    expect(once.rejection).toBeNull();
    expect(answer(once.state, harness.deps, HOST, 'NO').rejection?.code).toBe('DUPLICATE_SUBMISSION');
    harness.clock.advance(20_001);
    expect(answer(once.state, harness.deps, P2, 'NO').rejection).toMatchObject({ submissionCode: 'NOT_ALLOWED', detail: 'ANSWERS_CLOSED' });
  });

  it('never shows a rival’s answer or the solution before the reveal', () => {
    const { harness, room } = asked('GOAL_IN_WINDOW');
    const answered = answer(room, harness.deps, HOST, 'YES').state;
    const view = projectFor(answered, P2, harness.deps).round;
    expect(view?.yourSubmission).toBeNull();
    expect(view && 'solution' in view).toBe(false);
    expect(JSON.stringify(projectFor(answered, null, harness.deps))).not.toContain('"draws"');
  });

  it('settles early on the deciding event: right answers score (faster = more), wrong ones drink', () => {
    const { harness, room: open } = asked('GOAL_IN_WINDOW');
    let room = answer(open, harness.deps, HOST, 'YES').state;
    harness.clock.advance(8_000);
    room = answer(room, harness.deps, P2, 'YES').state;
    room = answer(room, harness.deps, P3, 'NO').state;
    harness.clock.advance(60_000);
    const settled = feed(room, harness.deps, [...HISTORY, ev('c31', 'CORNER', 31), ev('g34', 'GOAL', 34)]).state;
    expect(settled.phase).toBe('roundReveal');
    expect(solutionOf(settled)).toMatchObject({ outcome: 'settled', answer: 'YES', settledBy: 'EVENT', eventId: 'g34' });
    const outcome = currentRound(settled)?.outcome;
    expect(outcome?.winnerIds).toEqual([HOST, P2]);
    const points = (id: PlayerId) => outcome?.scores.find((entry) => entry.playerId === id)?.points ?? 0;
    expect(points(HOST)).toBeGreaterThan(points(P2));
    expect(points(P3)).toBe(0);
    const charged = settled.penalties.filter((entry) => entry.roundId === currentRound(settled)?.id);
    expect(charged.map((entry) => [entry.recipientId, entry.reason])).toEqual([[P3, 'WRONG_ANSWER']]);
    expect(charged[0]?.meta).toEqual({ rolled: true });
  });

  it('settles NO at the window end', () => {
    const { harness, room: open } = asked('GOAL_IN_WINDOW', { seed: 3 });
    const end = questionOf(open).endMinute;
    const room = answer(open, harness.deps, HOST, 'NO').state;
    const settled = feed(room, harness.deps, [...HISTORY, ev('late', 'FOUL', end)]).state;
    expect(solutionOf(settled)).toMatchObject({ answer: 'NO', settledBy: 'WINDOW_END' });
    expect(currentRound(settled)?.outcome?.winnerIds).toEqual([HOST]);
  });

  it('no-answer drinks only for players who had the answer window', () => {
    // Full window, then silence: P2 and P3 drink.
    const full = asked('GOAL_IN_WINDOW');
    let room = answer(full.room, full.harness.deps, HOST, 'YES').state;
    full.harness.clock.advance(60_000);
    room = feed(room, full.harness.deps, [...HISTORY, ev('g', 'GOAL', 40)]).state;
    expect(room.penalties.filter((entry) => entry.reason === 'NO_ANSWER').map((entry) => entry.recipientId)).toEqual([P2, P3]);

    // Settled 2 s after the question (a stalled feed catching up): nobody drinks for silence.
    const early = asked('GOAL_IN_WINDOW');
    early.harness.clock.advance(2_000);
    const quick = feed(early.room, early.harness.deps, [...HISTORY, ev('g', 'GOAL', 40)]).state;
    expect(quick.penalties.filter((entry) => entry.reason === 'NO_ANSWER')).toEqual([]);

    // A late joiner with 3 s of window left does not drink.
    const late = asked('GOAL_IN_WINDOW');
    late.harness.clock.advance(17_000);
    let joined = reduceRoom(late.room, { type: 'PLAYER_JOIN', playerId: asPlayerId('late'), nickname: 'Late', isGuest: true }, late.harness.deps).state;
    late.harness.clock.advance(60_000);
    joined = feed(joined, late.harness.deps, [...HISTORY, ev('g', 'GOAL', 40)]).state;
    expect(joined.penalties.filter((entry) => entry.reason === 'NO_ANSWER').map((entry) => entry.recipientId)).toEqual([HOST, P2, P3]);
  });

  it('void: opened after full time, no window left, or revealed before it settles', () => {
    const harness = makeHarness({ data: sampleData({ fixture: LIVE_FIXTURE }) });
    const over = feed(start(harness), harness.deps, [...HISTORY, ev('ft', 'FULL_TIME', 90, null, 3)]).state;
    expect(solutionOf(over)).toMatchObject({ outcome: 'void', voidReason: 'MATCH_OVER' });
    const late = feed(start(harness), harness.deps, [...HISTORY, ev('f88', 'FOUL', 88)]).state;
    expect(solutionOf(late)).toMatchObject({ outcome: 'void', voidReason: 'NO_WINDOW' });
    expect(late.penalties).toEqual([]);
    const { harness: h2, room } = asked('CORNERS_OVER');
    const revealed = reduceRoom(answer(room, h2.deps, HOST, 'YES').state, { type: 'REVEAL_ROUND', actorId: HOST }, h2.deps).state;
    expect(currentRound(revealed)?.outcome?.summary).toMatchObject({ outcome: 'void', voidReason: 'ABANDONED' });
    expect(currentRound(revealed)?.outcome?.scores).toEqual([]);
    expect(revealed.penalties).toEqual([]);
  });

  it('runs many rounds a match, never the same type twice in a row, deterministically', () => {
    const play = () => {
      const harness = makeHarness({ data: sampleData({ fixture: LIVE_FIXTURE }) });
      let room = start(harness, { seed: 11 });
      const types: M9QuestionType[] = [];
      let feedList: MatchEvent[] = [...HISTORY];
      for (let round = 0; round < 6; round += 1) {
        room = feed(room, harness.deps, feedList).state;
        types.push(payloadOf(room).questionType);
        const end = questionOf(room).endMinute;
        feedList = [...feedList, ev(`end${round}`, 'FOUL', end)];
        room = feed(room, harness.deps, feedList).state;
        room = reduceAll(room, [{ type: 'ADVANCE', actorId: HOST }, { type: 'ADVANCE', actorId: HOST }], harness.deps).state;
        if (room.phase !== 'playing') break;
      }
      return { room, types };
    };
    const first = play();
    for (let index = 1; index < first.types.length; index += 1) expect(first.types[index]).not.toBe(first.types[index - 1]);
    expect(JSON.stringify(play().room)).toBe(JSON.stringify(first.room));
  });
});

/* ------------------------- recorded match: PSG 6-1 Slovan ------------------------- */

describe('M9 against the recorded PSG 6-1 Slovan Bratislava timeline (401915445)', () => {
  const events = PSG_SLOVAN_EVENTS;
  const PSG = PSG_SLOVAN_FIXTURE.homeTeam.id;
  const throughMinute = (minute: number): readonly MatchEvent[] => {
    const cut = events.findIndex((event) => event.minute > minute);
    return cut === -1 ? events : events.slice(0, cut);
  };
  const run = (type: M9QuestionType, openedAtMinute: number | null, answers: readonly (readonly [PlayerId, M9Answer])[], seed = 42) => {
    const fixture =
      openedAtMinute === null
        ? { ...PSG_SLOVAN_FIXTURE, status: 'SCHEDULED' as const, kickoff: new Date(T0 + 60_000).toISOString() }
        : { ...PSG_SLOVAN_FIXTURE, status: 'LIVE' as const, kickoff: new Date(T0 - 60_000).toISOString() };
    const harness = makeHarness({ data: sampleData({ fixture, lineups: null }) });
    let room = start(harness, { types: [type], seed });
    let from = 0;
    if (openedAtMinute !== null) {
      const history = throughMinute(openedAtMinute);
      room = feed(room, harness.deps, history).state;
      from = history.length;
    }
    const question = payloadOf(room).question;
    for (const [playerId, value] of answers) room = answer(room, harness.deps, playerId, value).state;
    harness.clock.advance(30_000);
    for (let index = from; index < events.length && room.phase === 'playing'; index += 1) {
      room = feed(room, harness.deps, events.slice(0, index + 1)).state;
    }
    return { room, question, solution: solutionOf(room) };
  };

  it('pre-kickoff "goal in the next N?" settles YES early on Dembélé’s 17′ goal', () => {
    const { room, question, solution } = run('GOAL_IN_WINDOW', null, [
      [HOST, 'YES'],
      [P2, 'NO'],
    ]);
    expect(question).toMatchObject({ startMinute: 0 });
    expect(question?.endMinute).toBeGreaterThan(17);
    expect(solution).toMatchObject({ outcome: 'settled', answer: 'YES', settledBy: 'EVENT', eventId: 'espn:52132213' });
    expect(currentRound(room)?.outcome?.winnerIds).toEqual([HOST]);
  });

  it('"next goal side" asked on the 55′ feed: PSG’s 57′ goal (inside the window after the lead) → HOME', () => {
    const { question, solution } = run('NEXT_GOAL_SIDE', 55, [[HOST, 'HOME']]);
    // 4 goals in 55' → (4 + 1.35) / 100 per minute → even odds ≈ 13', jittered ±2.
    expect(question?.startMinute).toBe(57);
    expect((question?.endMinute ?? 0) - 57).toBeGreaterThanOrEqual(11);
    expect((question?.endMinute ?? 0) - 57).toBeLessThanOrEqual(15);
    expect(solution).toMatchObject({ answer: 'HOME', eventId: 'espn:52137737' });
  });

  it('"next card side" asked on the 40′ feed spans half-time and settles AWAY on Slovan’s 53′ booking', () => {
    const { question, solution } = run('NEXT_CARD_SIDE', 40, [[P2, 'AWAY']]);
    expect(question?.startMinute).toBe(42);
    expect(question?.endMinute).toBeGreaterThan(53);
    expect(solution).toMatchObject({ answer: 'AWAY', settledBy: 'EVENT', eventId: 'espn:52137401' });
  });

  it('"corners over" asked on the 40′ feed spans half-time with no corner in it, and settles NO at its end', () => {
    const { question, solution } = run('CORNERS_OVER', 40, [[HOST, 'NO']]);
    expect(question?.startMinute).toBe(42);
    expect(question?.endMinute).toBeGreaterThan(45);
    expect(question?.endMinute).toBeLessThan(56); // PSG's next corner is at 56'
    expect(solution).toMatchObject({ answer: 'NO', settledBy: 'WINDOW_END' });
    const closer = events.find((event) => event.id === solution.eventId);
    expect(closer?.minute).toBeGreaterThanOrEqual(question?.endMinute ?? 99);
  });

  it('"will <team> have a shot on target?" before kickoff settles on the first one of that team', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { question, solution } = run('TEAM_SHOT_ON_TARGET', null, [], seed);
      const side = question?.side;
      const first = events.find(
        (event) =>
          (event.type === 'SHOT_ON_TARGET' || event.type === 'SAVE' || event.type === 'GOAL' || event.type === 'PENALTY_SCORED') &&
          (event.teamId === PSG) === (side === 'home'),
      );
      if (first !== undefined && first.minute < (question?.endMinute ?? 0)) {
        expect(solution).toMatchObject({ answer: 'YES', eventId: first.id });
      } else {
        expect(solution).toMatchObject({ answer: 'NO', settledBy: 'WINDOW_END' });
      }
    }
  });

  it('opened on the 87′ feed there is no window left; after full time the match is over', () => {
    expect(run('GOAL_IN_WINDOW', 87, []).solution).toMatchObject({ outcome: 'void', voidReason: 'NO_WINDOW' });
    expect(run('GOAL_IN_WINDOW', 95, []).solution).toMatchObject({ outcome: 'void', voidReason: 'MATCH_OVER' });
  });
});

