import type { Fixture, MatchEvent } from '@fdg/football-data';
import { describe, expect, it } from 'vitest';
import type { RoomAction } from '../actions.js';
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
import { projectFor } from '../projection.js';
import type { EngineDeps, Reduction } from '../reducer.js';
import { reduceAll, reduceRoom } from '../reducer.js';
import type { RoomState } from '../state.js';
import { activeSession, currentRound, mergeRoomSettings } from '../state.js';
import { PSG_SLOVAN_EVENTS, PSG_SLOVAN_FIXTURE } from './fixtures/psg-slovan-401915445.test-utils.js';
import { isMixable } from './mixed.js';
import type { M7PublicPayload, M7Solution } from './m7-minute-sniper.js';
import {
  M7_DEFAULT_CONFIG,
  M7_ID,
  m7MinPick,
  m7MinuteSniper as module,
  m7SettlingEvent,
} from './m7-minute-sniper.js';

/* --------------------------------- fixtures -------------------------------- */

const LIVE_FIXTURE: Fixture = { ...FIXTURE, status: 'LIVE', kickoff: new Date(T0 - 3_600_000).toISOString() };
const UPCOMING_FIXTURE: Fixture = { ...FIXTURE, status: 'SCHEDULED', kickoff: new Date(T0 + 3_600_000).toISOString() };
const PICK_WINDOW = M7_DEFAULT_CONFIG.pickWindowMs;

const ev = (
  id: string,
  type: MatchEvent['type'],
  minute: number,
  extraMinute: number | null = null,
  teamId: typeof HOME_TEAM_ID | null = null,
): MatchEvent => matchEvent(type, { id, minute, extraMinute, teamId });
const goal = (id: string, minute: number, extraMinute: number | null = null, teamId = HOME_TEAM_ID): MatchEvent =>
  ev(id, 'GOAL', minute, extraMinute, teamId);

/** A mid-match history: kicked off, a home goal at 12', last play at 30'. */
const HISTORY: readonly MatchEvent[] = [
  ev('ko', 'KICK_OFF', 0),
  goal('g12', 12),
  ev('c20', 'CORNER', 20),
  ev('f30', 'FOUL', 30),
];

const harnessFor = (fixture: Fixture): Harness => makeHarness({ data: sampleData({ fixture }) });

const startM7 = (harness: Harness, options: { seed?: number; config?: unknown; rounds?: number } = {}): RoomState => {
  const result = reduceAll(
    newRoom(T0, options.seed ?? 42),
    [
      { type: 'PLAYER_JOIN', playerId: P2, nickname: 'Bea', isGuest: true },
      { type: 'PLAYER_JOIN', playerId: P3, nickname: 'Cal', isGuest: true },
      { type: 'UPDATE_SETTINGS', actorId: HOST, patch: { roundsPerSession: options.rounds ?? 3 } },
      { type: 'SELECT_GAME', actorId: HOST, moduleId: M7_ID, config: options.config ?? null },
      { type: 'START_SESSION', actorId: HOST },
    ],
    harness.deps,
  );
  expect(result.rejection).toBeNull();
  return result.state;
};

const feed = (room: RoomState, deps: EngineDeps, events: readonly MatchEvent[]): Reduction =>
  reduceRoom(room, { type: 'MATCH_EVENTS', events }, deps);

const pick = (room: RoomState, deps: EngineDeps, playerId: PlayerId, minute: unknown): Reduction => {
  const round = currentRound(room);
  if (round === undefined) throw new Error('no round');
  return reduceRoom(room, { type: 'SUBMIT_ANSWER', playerId, roundId: round.id, payload: { minute } }, deps);
};

const picks = (room: RoomState, deps: EngineDeps, entries: readonly (readonly [PlayerId, number])[]): RoomState =>
  entries.reduce((state, [playerId, minute]) => {
    const result = pick(state, deps, playerId, minute);
    expect(result.rejection).toBeNull();
    return result.state;
  }, room);

const solutionOf = (room: RoomState): M7Solution => currentRound(room)?.solution as M7Solution;
const summaryOf = (room: RoomState) =>
  currentRound(room)?.outcome?.summary as {
    outcome: string;
    voidReason: string | null;
    targetMinute: number | null;
    picks: { playerId: string; minute: number; distance: number | null }[];
  };
const publicFor = (room: RoomState, deps: EngineDeps, viewer: PlayerId | null = HOST): M7PublicPayload =>
  projectFor(room, viewer, deps).round?.publicPayload as M7PublicPayload;
const penaltiesOf = (room: RoomState) => room.penalties.filter((entry) => entry.roundId === currentRound(room)?.id);

/** Mid-match room, baselined at 30', with the given picks placed. */
const pickedAt30 = (entries: readonly (readonly [PlayerId, number])[], config?: unknown) => {
  const harness = harnessFor(LIVE_FIXTURE);
  let room = startM7(harness, config === undefined ? {} : { config });
  room = feed(room, harness.deps, HISTORY).state;
  room = picks(room, harness.deps, entries);
  return { harness, room };
};

/* --------------------------------- contract -------------------------------- */

describe('M7 contract and generation', () => {
  it('is a live long-running bet on the since-round-open window, never part of a Mixed rotation', () => {
    expect(module.kind).toBe('long-running-bet');
    expect(module.category).toBe('matchday');
    expect(module.supportsLiveEvents).toBe(true);
    expect(module.liveEventWindow).toBe('since-round-open');
    expect(module.dataRequirements).toEqual(['hasLiveEvents']);
    expect(module.allowResubmission).toBe(true);
    expect(isMixable(module, 'matchday')).toBe(false);
  });

  it('opens a pending round whose deadline closes picks only', () => {
    const round = mustGenerate(module, { data: sampleData({ fixture: LIVE_FIXTURE }) });
    expect(round.answerWindowMs).toBe(PICK_WINDOW);
    expect(round.publicPayload).toEqual({
      kind: 'MINUTE_SNIPER',
      fixtureId: FIXTURE.id,
      homeTeamId: HOME_TEAM_ID,
      awayTeamId: AWAY_TEAM_ID,
      clockKnown: false,
      matchClock: null,
      minPick: null,
      maxPick: 90,
      scoreAtOpen: null,
      clockKnownAt: null,
    });
    expect(round.solution).toEqual({ outcome: 'pending', voidReason: null, targetMinute: null, goal: null, settledAt: null });
  });

  it('gives every round its own content key, and refuses without a fixture or once it is over', () => {
    const first = mustGenerate(module, { roundIndex: 0 });
    const second = mustGenerate(module, { roundIndex: 1, usedContentKeys: [first.contentKey] });
    expect(second.contentKey).not.toBe(first.contentKey);
    expect(mustGenerate(module, { roundIndex: 0, usedContentKeys: [first.contentKey] }).contentKey).not.toBe(first.contentKey);
    const none = generateWith(module, { data: sampleData({ fixture: null }) });
    expect(none.ok ? null : none.reason).toBe('INSUFFICIENT_DATA');
    for (const status of ['FINISHED', 'CANCELLED'] as const) {
      const over = generateWith(module, { data: sampleData({ fixture: { ...FIXTURE, status } }) });
      expect(over.ok ? null : over.reason).toBe('WRONG_ROUND_CONTEXT');
    }
    // A delayed or suspended match (POSTPONED) may still be played: the round waits for it.
    expect(generateWith(module, { data: sampleData({ fixture: { ...FIXTURE, status: 'POSTPONED' } }) }).ok).toBe(true);
  });

  it('m7MinPick: one past the latest minute, 46 at half-time, none left from 90', () => {
    expect(m7MinPick(null)).toBe(1);
    expect(m7MinPick({ minute: 0, extraMinute: null })).toBe(1);
    expect(m7MinPick({ minute: 30, extraMinute: null })).toBe(31);
    expect(m7MinPick({ minute: 45, extraMinute: 2 })).toBe(46);
    expect(m7MinPick({ minute: 89, extraMinute: null })).toBe(90);
    expect(m7MinPick({ minute: 90, extraMinute: null })).toBeNull();
  });

  it('m7SettlingEvent: earliest regulation goal before the whistle, else the whistle', () => {
    expect(m7SettlingEvent([ev('c', 'CORNER', 50)])).toBeNull();
    expect(m7SettlingEvent([goal('late', 60), goal('early', 55)])?.event.id).toBe('early');
    expect(m7SettlingEvent([ev('pm', 'PENALTY_MISSED', 50), ev('ft', 'FULL_TIME', 90, 3)])).toMatchObject({ kind: 'full-time' });
    // Batch order decides the whistle: a goal listed after FULL_TIME (extra time) never counts.
    expect(m7SettlingEvent([ev('ft', 'FULL_TIME', 90, 3), goal('et', 95)])).toMatchObject({ kind: 'full-time' });
    expect(m7SettlingEvent([goal('et', 105)])).toBeNull();
  });
});

/* -------------------------------- the clock -------------------------------- */

describe('M7 picks are validated against the match clock', () => {
  it('refuses picks until the round knows the clock, then only minutes after it', () => {
    const harness = harnessFor(LIVE_FIXTURE);
    const room = startM7(harness);
    expect(pick(room, harness.deps, HOST, 50).rejection).toMatchObject({
      code: 'INVALID_SUBMISSION',
      submissionCode: 'NOT_ALLOWED',
      detail: 'MATCH_CLOCK_UNKNOWN',
    });
    expect(publicFor(room, harness.deps)).toMatchObject({ clockKnown: false, minPick: null, matchClock: null });

    const baselined = feed(room, harness.deps, HISTORY).state;
    expect(publicFor(baselined, harness.deps)).toMatchObject({
      clockKnown: true,
      matchClock: { minute: 30, extraMinute: null },
      minPick: 31,
      scoreAtOpen: { home: 1, away: 0 },
    });
    expect(pick(baselined, harness.deps, HOST, 30).rejection).toMatchObject({ submissionCode: 'OUT_OF_RANGE' });
    expect(pick(baselined, harness.deps, HOST, 31).rejection).toBeNull();
    expect(pick(baselined, harness.deps, HOST, 90).rejection).toBeNull();
  });

  it('rejects malformed picks', () => {
    const { harness, room } = pickedAt30([]);
    for (const [raw, code] of [
      [91, 'OUT_OF_RANGE'],
      [0, 'OUT_OF_RANGE'],
      [45.5, 'SCHEMA'],
      ['50', 'SCHEMA'],
    ] as const) {
      expect(pick(room, harness.deps, HOST, raw).rejection?.submissionCode).toBe(code);
    }
    const round = currentRound(room);
    const extra = reduceRoom(
      room,
      { type: 'SUBMIT_ANSWER', playerId: HOST, roundId: round?.id ?? ('' as never), payload: { minute: 50, x: 1 } },
      harness.deps,
    );
    expect(extra.rejection?.submissionCode).toBe('SCHEMA');
  });

  it('follows the clock as play goes on, re-validating changed picks', () => {
    const { harness, room } = pickedAt30([[HOST, 33]]);
    const later = feed(room, harness.deps, [...HISTORY, ev('s35', 'SHOT_OFF_TARGET', 35)]).state;
    expect(publicFor(later, harness.deps).minPick).toBe(36);
    // Changing a pick is allowed, but only to a minute still ahead.
    expect(pick(later, harness.deps, HOST, 34).rejection?.submissionCode).toBe('OUT_OF_RANGE');
    const changed = pick(later, harness.deps, HOST, 40);
    expect(changed.rejection).toBeNull();
    expect(changed.events[0]).toMatchObject({ type: 'SUBMISSION_ACCEPTED', replaced: true });
  });

  it('closes picks at the deadline but keeps the round open for the goal', () => {
    const { harness, room } = pickedAt30([[HOST, 40]]);
    harness.clock.advance(PICK_WINDOW + 1);
    expect(reduceRoom(room, { type: 'TICK' }, harness.deps).state).toBe(room);
    expect(pick(room, harness.deps, P2, 50).rejection?.code).toBe('DEADLINE_PASSED');
    expect(reduceRoom(room, { type: 'LOCK_ROUND', actorId: HOST }, harness.deps).rejection?.code).toBe('ROUND_NOT_LOCKABLE');
    expect(feed(room, harness.deps, [...HISTORY, goal('g41', 41)]).state.phase).toBe('roundReveal');
  });

  it('a round opened before kickoff takes picks from minute 1 straight away, at 0-0', () => {
    const harness = harnessFor(UPCOMING_FIXTURE);
    const room = startM7(harness);
    expect(publicFor(room, harness.deps)).toMatchObject({ clockKnown: true, minPick: 1, scoreAtOpen: { home: 0, away: 0 } });
    expect(pick(room, harness.deps, HOST, 1).rejection).toBeNull();
    // …and the very first batch after kickoff can settle it.
    const settled = feed(pick(room, harness.deps, HOST, 3).state, harness.deps, [ev('ko', 'KICK_OFF', 0), goal('g2', 2)]).state;
    expect(settled.phase).toBe('roundReveal');
    expect(solutionOf(settled)).toMatchObject({ outcome: 'goal', targetMinute: 2 });
  });

  it('opened at half-time: picks start at 46', () => {
    const harness = harnessFor(LIVE_FIXTURE);
    const room = feed(startM7(harness), harness.deps, [...HISTORY, ev('ht', 'HALF_TIME', 45, 2)]).state;
    expect(publicFor(room, harness.deps)).toMatchObject({ minPick: 46, matchClock: { minute: 45, extraMinute: 2 } });
    expect(pick(room, harness.deps, HOST, 45).rejection?.submissionCode).toBe('OUT_OF_RANGE');
    expect(pick(room, harness.deps, HOST, 46).rejection).toBeNull();
  });
});

/* -------------------------------- settlement -------------------------------- */

describe('M7 settles on the next goal', () => {
  it('closest wins, furthest drinks, and the round reveals itself', () => {
    const { harness, room } = pickedAt30([
      [HOST, 35],
      [P2, 40],
      [P3, 70],
    ]);
    const result = feed(room, harness.deps, [...HISTORY, ev('c33', 'CORNER', 33), goal('g38', 38, null, AWAY_TEAM_ID)]);
    const settled = result.state;
    expect(settled.phase).toBe('roundReveal');
    expect(result.events.map((event) => event.type)).toContain('ROUND_REVEALED');
    expect(solutionOf(settled)).toMatchObject({
      outcome: 'goal',
      targetMinute: 38,
      goal: { eventId: 'g38', type: 'GOAL', creditedSide: 'away', minute: 38 },
      settledAt: T0,
    });
    expect(currentRound(settled)?.outcome?.winnerIds).toEqual([P2]);
    expect(penaltiesOf(settled).map((entry) => [entry.recipientId, entry.reason, entry.appliedSips, entry.meta])).toEqual([
      [P3, 'DISTANCE_FROM_TARGET', 3, { distance: 32, furthest: true }],
    ]);
    expect(summaryOf(settled).picks).toEqual([
      { playerId: HOST, minute: 35, distance: 3 },
      { playerId: P2, minute: 40, distance: 2 },
      { playerId: P3, minute: 70, distance: 32 },
    ]);
    // Nobody hit it exactly: points for proximity, but no streak.
    const scores = currentRound(settled)?.outcome?.scores ?? [];
    expect(scores.every((entry) => !entry.correct)).toBe(true);
    expect(scores.find((entry) => entry.playerId === P2)?.points).toBeGreaterThan(
      scores.find((entry) => entry.playerId === HOST)?.points ?? 0,
    );
    expect(scores.find((entry) => entry.playerId === P3)?.points).toBe(0);
  });

  it('an exact snipe is a correct answer', () => {
    const { harness, room } = pickedAt30([
      [HOST, 38],
      [P2, 50],
    ]);
    const settled = feed(room, harness.deps, [...HISTORY, goal('g38', 38)]).state;
    const host = currentRound(settled)?.outcome?.scores.find((entry) => entry.playerId === HOST);
    expect(host).toMatchObject({ correct: true, breakdown: { accuracyFactor: 1 } });
    expect(settled.players.find((player) => player.id === HOST)?.streak).toBe(1);
  });

  it('ties: equal closest share the win; all equal means nobody is furthest; a lone picker never drinks', () => {
    const tied = pickedAt30([
      [HOST, 36],
      [P2, 40],
      [P3, 60],
    ]);
    const a = feed(tied.room, tied.harness.deps, [...HISTORY, goal('g38', 38)]).state;
    expect(currentRound(a)?.outcome?.winnerIds).toEqual([HOST, P2]);
    expect(penaltiesOf(a).map((entry) => entry.recipientId)).toEqual([P3]);

    const allEqual = pickedAt30([
      [HOST, 36],
      [P2, 40],
    ]);
    const b = feed(allEqual.room, allEqual.harness.deps, [...HISTORY, goal('g38', 38)]).state;
    expect(currentRound(b)?.outcome?.winnerIds).toEqual([HOST, P2]);
    expect(penaltiesOf(b)).toEqual([]);

    const lone = pickedAt30([[HOST, 89]]);
    const c = feed(lone.room, lone.harness.deps, [...HISTORY, goal('g38', 38)]).state;
    expect(currentRound(c)?.outcome?.winnerIds).toEqual([HOST]);
    expect(penaltiesOf(c)).toEqual([]);
  });

  it('two furthest picks both drink', () => {
    const { harness, room } = pickedAt30([
      [HOST, 38],
      [P2, 48],
      [P3, 48],
    ]);
    const settled = feed(room, harness.deps, [...HISTORY, goal('g38', 38)]).state;
    expect(penaltiesOf(settled).map((entry) => entry.recipientId)).toEqual([P2, P3]);
  });

  it('counts own goals (credited to the opponent) and scored penalties, never missed penalties', () => {
    const own = pickedAt30([[HOST, 50]]);
    const og = feed(own.room, own.harness.deps, [...HISTORY, ev('og', 'OWN_GOAL', 44, null, HOME_TEAM_ID)]).state;
    expect(solutionOf(og).goal).toMatchObject({ type: 'OWN_GOAL', creditedSide: 'away', minute: 44 });

    const pens = pickedAt30([[HOST, 50]]);
    const missed = feed(pens.room, pens.harness.deps, [...HISTORY, ev('pm', 'PENALTY_MISSED', 40, null, HOME_TEAM_ID)]).state;
    expect(missed.phase).toBe('playing');
    const scored = feed(missed, pens.harness.deps, [...HISTORY, ev('ps', 'PENALTY_SCORED', 52, null, HOME_TEAM_ID)]).state;
    expect(solutionOf(scored)).toMatchObject({ outcome: 'goal', targetMinute: 52, goal: { type: 'PENALTY_SCORED', creditedSide: 'home' } });
  });

  it('stoppage-time goals count as 45 and 90', () => {
    const first = pickedAt30([[HOST, 45]]);
    const fh = feed(first.room, first.harness.deps, [...HISTORY, goal('g45', 45, 2)]).state;
    expect(solutionOf(fh)).toMatchObject({ targetMinute: 45, goal: { minute: 45, extraMinute: 2 } });
    expect(currentRound(fh)?.outcome?.scores.find((entry) => entry.playerId === HOST)?.correct).toBe(true);

    const second = pickedAt30([[HOST, 90]]);
    const sh = feed(second.room, second.harness.deps, [...HISTORY, goal('g90', 90, 4)]).state;
    expect(solutionOf(sh).targetMinute).toBe(90);
  });

  it('with several goals in one poll, the earliest settles it', () => {
    const { harness, room } = pickedAt30([[HOST, 60]]);
    const settled = feed(room, harness.deps, [...HISTORY, goal('g55', 55), goal('g41', 41)]).state;
    expect(solutionOf(settled).goal?.eventId).toBe('g41');
  });

  it('a goal in the same poll as the round opening is history: the round waits for the next one', () => {
    const harness = harnessFor(LIVE_FIXTURE);
    const room = startM7(harness);
    const baselined = feed(room, harness.deps, [...HISTORY, goal('g31', 31, null, AWAY_TEAM_ID)]).state;
    expect(baselined.phase).toBe('playing');
    expect(publicFor(baselined, harness.deps)).toMatchObject({ scoreAtOpen: { home: 1, away: 1 }, minPick: 32 });
    const withPick = picks(baselined, harness.deps, [[HOST, 40]]);
    const settled = feed(withPick, harness.deps, [...HISTORY, goal('g31', 31, null, AWAY_TEAM_ID), goal('g39', 39)]).state;
    expect(solutionOf(settled).goal?.eventId).toBe('g39');
  });
});

describe('M7 without a goal', () => {
  it('settles no-goal at the regulation whistle, measured to 90, with no correct answers', () => {
    const { harness, room } = pickedAt30([
      [HOST, 88],
      [P2, 60],
      [P3, 31],
    ]);
    const settled = feed(room, harness.deps, [...HISTORY, ev('ft', 'FULL_TIME', 90, 5)]).state;
    expect(settled.phase).toBe('roundReveal');
    expect(solutionOf(settled)).toMatchObject({ outcome: 'no-goal', targetMinute: 90, goal: null });
    expect(currentRound(settled)?.outcome?.winnerIds).toEqual([HOST]);
    expect(currentRound(settled)?.outcome?.scores.every((entry) => !entry.correct)).toBe(true);
    expect(penaltiesOf(settled).map((entry) => [entry.recipientId, entry.reason])).toEqual([[P3, 'DISTANCE_FROM_TARGET']]);
  });

  it('ignores an extra-time goal listed after the regulation whistle', () => {
    const { harness, room } = pickedAt30([[HOST, 88]]);
    const settled = feed(room, harness.deps, [...HISTORY, ev('ft', 'FULL_TIME', 90, 5), goal('et', 97)]).state;
    expect(solutionOf(settled).outcome).toBe('no-goal');
  });

  it('is void at once when the round opens after the whistle, or with no minute left', () => {
    const harness = harnessFor(LIVE_FIXTURE);
    const over = feed(startM7(harness), harness.deps, [...HISTORY, ev('ft', 'FULL_TIME', 90, 5)]).state;
    expect(over.phase).toBe('roundReveal');
    expect(solutionOf(over)).toMatchObject({ outcome: 'void', voidReason: 'MATCH_OVER' });
    expect(penaltiesOf(over)).toEqual([]);
    expect(currentRound(over)?.outcome?.scores).toEqual([]);

    const stoppage = feed(startM7(harness), harness.deps, [...HISTORY, ev('f90', 'FOUL', 90, 2)]).state;
    expect(solutionOf(stoppage)).toMatchObject({ outcome: 'void', voidReason: 'NO_MINUTES_LEFT' });
  });

  it('a manual reveal before any goal or whistle voids the round without touching streaks', () => {
    const { harness, room } = pickedAt30([[HOST, 40]]);
    const primed = { ...room, players: room.players.map((player) => ({ ...player, streak: 2 })) };
    const revealed = reduceRoom(primed, { type: 'REVEAL_ROUND', actorId: HOST }, harness.deps).state;
    expect(summaryOf(revealed)).toMatchObject({ outcome: 'void', voidReason: 'ABANDONED', targetMinute: null });
    expect(penaltiesOf(revealed)).toEqual([]);
    expect(revealed.players.every((player) => player.streak === 2 && player.score === 0)).toBe(true);
  });
});

describe('M7 drinks for not picking', () => {
  it('only once the pick window had closed before the round settled', () => {
    const early = pickedAt30([
      [HOST, 40],
      [P2, 45],
    ]);
    const beforeDeadline = feed(early.room, early.harness.deps, [...HISTORY, goal('g33', 33)]).state;
    expect(penaltiesOf(beforeDeadline).some((entry) => entry.reason === 'NO_ANSWER')).toBe(false);

    const late = pickedAt30([
      [HOST, 40],
      [P2, 45],
    ]);
    late.harness.clock.advance(PICK_WINDOW);
    const afterDeadline = feed(late.room, late.harness.deps, [...HISTORY, goal('g33', 33)]).state;
    const silent = penaltiesOf(afterDeadline).filter((entry) => entry.reason === 'NO_ANSWER');
    expect(silent.map((entry) => entry.recipientId)).toEqual([P3]);
    expect(silent[0]?.meta).toEqual({ rolled: true });
  });

  it('the switch turns it off', () => {
    const { harness, room } = pickedAt30([[HOST, 40]], { ...M7_DEFAULT_CONFIG, noAnswerSips: 0, furthestSips: 0 });
    harness.clock.advance(PICK_WINDOW);
    expect(penaltiesOf(feed(room, harness.deps, [...HISTORY, goal('g33', 33)]).state)).toEqual([]);
  });

  it('respects the room caps', () => {
    const { harness, room } = pickedAt30([
      [HOST, 38],
      [P2, 80],
    ]);
    const capped: RoomState = {
      ...room,
      settings: mergeRoomSettings(room.settings, { penaltyCaps: { perPenalty: 2, perRound: 10, perSession: 60 } }),
    };
    const settled = feed(capped, harness.deps, [...HISTORY, goal('g38', 38)]).state;
    expect(penaltiesOf(settled)[0]).toMatchObject({ recipientId: P2, requestedSips: 3, appliedSips: 2, cappedBy: 'perPenalty' });
  });
});

/* ------------------------------ leaks + determinism ------------------------------ */

describe('M7 projection and replay', () => {
  it('never shows a rival’s pick before the reveal', () => {
    const { harness, room } = pickedAt30([
      [HOST, 37],
      [P2, 64],
    ]);
    const view = projectFor(room, P2, harness.deps);
    expect(view.round?.visibility).toBe('pre-reveal');
    expect(view.round?.yourSubmission).toEqual({ minute: 64 });
    expect(JSON.stringify(view)).not.toContain('37');
    expect(view.round?.submissionStatus.find((entry) => entry.playerId === HOST)?.submitted).toBe(true);
    expect(JSON.stringify(projectFor(room, null, harness.deps))).not.toContain('64');
  });

  it('replays byte-for-byte and survives a JSON round-trip on every dispatch', () => {
    const play = (roundTrip: boolean): RoomState => {
      const harness = harnessFor(LIVE_FIXTURE);
      let room = startM7(harness, { seed: 7 });
      const apply = (action: RoomAction): void => {
        room = reduceRoom(room, action, harness.deps).state;
        if (roundTrip) room = JSON.parse(JSON.stringify(room)) as RoomState;
      };
      const roundId = () => currentRound(room)?.id ?? ('' as never);
      apply({ type: 'MATCH_EVENTS', events: HISTORY });
      apply({ type: 'SUBMIT_ANSWER', playerId: HOST, roundId: roundId(), payload: { minute: 40 } });
      apply({ type: 'SUBMIT_ANSWER', playerId: P2, roundId: roundId(), payload: { minute: 70 } });
      harness.clock.advance(PICK_WINDOW);
      apply({ type: 'MATCH_EVENTS', events: [...HISTORY, goal('g44', 44)] });
      return room;
    };
    const first = play(false);
    expect(JSON.stringify(play(false))).toBe(JSON.stringify(first));
    expect(play(true)).toEqual(first);
    expect(first.penalties.map((entry) => entry.reason).sort()).toEqual(['DISTANCE_FROM_TARGET', 'NO_ANSWER']);
  });
});

/* ------------------------- recorded match: PSG 6-1 Slovan ------------------------- */

describe('M7 against the recorded PSG 6-1 Slovan Bratislava timeline (401915445)', () => {
  const events = PSG_SLOVAN_EVENTS;
  /** The feed as a poll would return it once the event with `id` has been published. */
  const pollThrough = (id: string): readonly MatchEvent[] => {
    const index = events.findIndex((event) => event.id === id);
    if (index < 0) throw new Error(`no event ${id}`);
    return events.slice(0, index + 1);
  };
  const idAt = (type: MatchEvent['type'], minute: number): string => {
    const found = events.find((event) => event.type === type && event.minute === minute);
    if (found === undefined) throw new Error(`no ${type} at ${minute}`);
    return found.id;
  };
  const lastBefore = (minute: number): string => {
    const found = [...events].reverse().find((event) => event.minute < minute);
    if (found === undefined) throw new Error(`nothing before ${minute}`);
    return found.id;
  };

  it('is the recorded data the test believes it is', () => {
    const goals = events.filter((event) => event.type === 'GOAL').map((event) => `${event.minute}:${event.teamId}`);
    expect(goals).toEqual(['17:160', '23:160', '31:160', '47:160', '57:160', '58:521', '87:160']);
    expect(events.at(-1)).toMatchObject({ type: 'FULL_TIME', minute: 90, extraMinute: 2 });
  });

  it('plays six rounds through the reducer as the match unfolds, each settling on the right event', () => {
    const upcoming = { ...PSG_SLOVAN_FIXTURE, status: 'SCHEDULED' as const, kickoff: new Date(T0 + 60_000).toISOString() };
    const live = { ...PSG_SLOVAN_FIXTURE, status: 'LIVE' as const, kickoff: new Date(T0 - 60_000).toISOString() };
    const harness = makeHarness({ data: sampleData({ fixture: upcoming, lineups: null }) });
    const liveDeps: EngineDeps = { ...harness.deps, data: sampleData({ fixture: live, lineups: null }) };
    let room = startM7(harness, { rounds: 6 });

    const settle = (polls: readonly (readonly MatchEvent[])[], chosen: readonly (readonly [PlayerId, number])[]) => {
      // Polls arrive every ~15 s; the pick window closes before the settling poll.
      const [baseline, ...rest] = polls;
      if (baseline !== undefined) room = feed(room, liveDeps, baseline).state;
      room = picks(room, liveDeps, chosen);
      harness.clock.advance(PICK_WINDOW);
      for (const poll of rest) {
        if (room.phase !== 'playing') break;
        room = feed(room, liveDeps, poll).state;
        harness.clock.advance(15_000);
      }
      const settled = { solution: solutionOf(room), summary: summaryOf(room), winners: currentRound(room)?.outcome?.winnerIds };
      room = reduceAll(
        room,
        [
          { type: 'ADVANCE', actorId: HOST },
          { type: 'ADVANCE', actorId: HOST },
        ],
        liveDeps,
      ).state;
      return settled;
    };

    // Round 1 — opened before kickoff: the first poll is live; Dembélé's 17' settles it.
    expect(currentRound(room)?.liveWindow?.baselineSource).toBe('pre-kickoff');
    const r1 = settle(
      [[], pollThrough(lastBefore(17)), pollThrough(idAt('GOAL', 17)), pollThrough(idAt('GOAL', 23))],
      [
        [HOST, 10],
        [P2, 18],
        [P3, 80],
      ],
    );
    expect(r1.solution).toMatchObject({ outcome: 'goal', targetMinute: 17, goal: { playerName: 'Ousmane Dembélé', creditedSide: 'home' } });
    expect(r1.winners).toEqual([P2]);

    // Round 2 — opened at 20': the 17' goal is history, the next one (23') settles it.
    const r2 = settle([pollThrough(lastBefore(21)), pollThrough(idAt('GOAL', 23))], [[HOST, 22], [P2, 30]]);
    expect(r2.solution).toMatchObject({ outcome: 'goal', targetMinute: 23 });
    expect(r2.winners).toEqual([HOST]);

    // Round 3 — opened at half-time (45+2'): picks start at 46; Ferran Torres' 47' settles it.
    const r3 = settle([pollThrough(idAt('HALF_TIME', 45)), pollThrough(idAt('GOAL', 47))], [[HOST, 46], [P2, 60]]);
    expect(r3.solution).toMatchObject({ outcome: 'goal', targetMinute: 47, goal: { playerName: 'Ferran Torres' } });

    // Round 4 — opened just after the 57' goal, but the poll that baselines it already carries
    // Slovan's 58' goal: both are history, and Fabián Ruiz's 87' settles it.
    const r4 = settle([pollThrough(idAt('GOAL', 58)), pollThrough(idAt('GOAL', 87))], [[HOST, 85], [P2, 60]]);
    expect(r4.solution).toMatchObject({ outcome: 'goal', targetMinute: 87, goal: { playerName: 'Fabián Ruiz' } });
    expect(r4.winners).toEqual([HOST]);

    // Round 5 — opened at 88': no more goals, so the 90+2' whistle settles it as no-goal (target 90).
    const r5 = settle([pollThrough(lastBefore(89)), pollThrough(events.at(-1)?.id ?? '')], [[HOST, 89], [P2, 90]]);
    expect(r5.solution).toMatchObject({ outcome: 'no-goal', targetMinute: 90 });
    expect(r5.winners).toEqual([P2]);

    // Round 6 — opened after full time: void at once, nothing charged.
    const before = room.penalties.length;
    const r6 = settle([events], []);
    expect(r6.solution).toMatchObject({ outcome: 'void', voidReason: 'MATCH_OVER' });
    expect(room.penalties.length).toBe(before);

    expect(activeSession(room)?.finishedAt).not.toBeNull();
    expect(activeSession(room)?.rounds).toHaveLength(6);
  });
});

/* ------------------------ clock never known during the pick window ------------------------ */

describe('M7 never charges for a pick window in which no pick was possible (release QA)', () => {
  it('kickoff passed, feed empty all window: every pick refused, and nobody drinks for not picking', () => {
    // Scheduled kickoff 5 min before the round opened, but the feed has no events yet (delayed start).
    const delayed = { ...FIXTURE, status: 'SCHEDULED' as const, kickoff: new Date(T0 - 300_000).toISOString() };
    const harness = harnessFor(delayed);
    let room = startM7(harness);
    expect(currentRound(room)?.liveWindow?.baselineSource).toBeNull();
    for (const playerId of [HOST, P2, P3]) {
      expect(pick(room, harness.deps, playerId, 30).rejection?.detail).toBe('MATCH_CLOCK_UNKNOWN');
    }
    harness.clock.advance(PICK_WINDOW + 1_000);
    room = feed(room, harness.deps, [ev('ko', 'KICK_OFF', 0)]).state;
    expect(pick(room, harness.deps, HOST, 30).rejection?.code).toBe('DEADLINE_PASSED');
    room = feed(room, harness.deps, [ev('ko', 'KICK_OFF', 0), goal('g20', 20)]).state;
    expect(currentRound(room)?.status).toBe('resolved');
    expect(room.penalties.filter((entry) => entry.reason === 'NO_ANSWER')).toEqual([]);
  });

  it('counts only the part of the window after the clock became known (and after joining)', () => {
    const run = (baselineAfterMs: number) => {
      const harness = harnessFor(LIVE_FIXTURE);
      let room = startM7(harness);
      harness.clock.advance(baselineAfterMs);
      room = feed(room, harness.deps, HISTORY).state;
      room = picks(room, harness.deps, [[HOST, 40]]);
      harness.clock.advance(PICK_WINDOW);
      room = feed(room, harness.deps, [...HISTORY, goal('g44', 44)]).state;
      return room.penalties.filter((entry) => entry.reason === 'NO_ANSWER').map((entry) => entry.recipientId);
    };
    // Clock known 1 s in: 59 s of real window, so the silent players drink.
    expect(run(1_000)).toEqual([P2, P3]);
    // Clock known 55 s into a 60 s window: 5 s is no real chance.
    expect(run(55_000)).toEqual([]);
  });

  it('a player who joined as the pick window was closing does not drink for it', () => {
    const harness = harnessFor(LIVE_FIXTURE);
    let room = startM7(harness);
    room = feed(room, harness.deps, HISTORY).state;
    room = picks(room, harness.deps, [[HOST, 40]]);
    harness.clock.advance(PICK_WINDOW - 5_000);
    room = reduceRoom(room, { type: 'PLAYER_JOIN', playerId: 'late' as PlayerId, nickname: 'Late', isGuest: true }, harness.deps).state;
    harness.clock.advance(10_000);
    room = feed(room, harness.deps, [...HISTORY, goal('g44', 44)]).state;
    expect(room.penalties.filter((entry) => entry.reason === 'NO_ANSWER').map((entry) => entry.recipientId)).toEqual([P2, P3]);
  });
});
