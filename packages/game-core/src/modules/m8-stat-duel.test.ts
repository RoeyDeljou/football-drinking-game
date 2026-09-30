import type { Fixture, FixtureId, FootballPlayerId, MatchEvent, PlayerMatchStats } from '@fdg/football-data';
import { describe, expect, it } from 'vitest';
import type { RoomAction } from '../actions.js';
import type { Harness } from '../harness.test-utils.js';
import {
  ALL_BUILT,
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
import { asGameModuleId, asPlayerId } from '../ids.js';
import { projectFor } from '../projection.js';
import type { EngineDeps, Reduction } from '../reducer.js';
import { reduceAll, reduceRoom } from '../reducer.js';
import type { RoomState } from '../state.js';
import { currentRound, mergeRoomSettings } from '../state.js';
import {
  PSG_SLOVAN_EVENTS,
  PSG_SLOVAN_FINAL_PLAYER_STATS,
  PSG_SLOVAN_FINAL_TEAM_STATS,
  PSG_SLOVAN_FIXTURE,
  PSG_SLOVAN_LINEUPS,
} from './fixtures/psg-slovan-401915445.test-utils.js';
import { isMixable } from './mixed.js';
import type { M8PublicPayload, M8Solution, M8Stat } from './m8-stat-duel.js';
import { M8_DEFAULT_CONFIG, M8_ID, m8StatDuel as module, m8StatValue, playM8Bracket } from './m8-stat-duel.js';

const LIVE_FIXTURE: Fixture = { ...FIXTURE, status: 'LIVE', kickoff: new Date(T0 - 3_600_000).toISOString() };
const UPCOMING_FIXTURE: Fixture = { ...FIXTURE, status: 'SCHEDULED', kickoff: new Date(T0 + 3_600_000).toISOString() };
const WINDOW = M8_DEFAULT_CONFIG.pickWindowMs;
const P4 = asPlayerId('p4');

const fb = (index: number): FootballPlayerId => {
  const id = ALL_BUILT[index]?.player.id;
  if (id === undefined) throw new Error('no footballer');
  return id;
};

interface Line {
  readonly shots?: number;
  readonly sot?: number;
  readonly goals?: number;
  readonly assists?: number;
  readonly fouls?: number;
}
const statRow = (playerId: FootballPlayerId, line: Line): PlayerMatchStats => ({
  playerId,
  teamId: HOME_TEAM_ID,
  minutesPlayed: 90,
  goals: line.goals ?? 0,
  assists: line.assists ?? 0,
  shots: line.shots ?? 0,
  shotsOnTarget: line.sot ?? 0,
  passes: null,
  passAccuracy: null,
  tackles: null,
  duelsWon: null,
  foulsCommitted: line.fouls ?? null,
  rating: null,
});
let asOfCounter = 0;
const stats = (lines: ReadonlyArray<readonly [FootballPlayerId, Line]>, asOf?: string, fixtureId: string = FIXTURE.id): RoomAction => {
  asOfCounter += 1;
  return {
    type: 'MATCH_STATS',
    fixtureId: fixtureId as FixtureId,
    asOf: asOf ?? new Date(Date.UTC(2026, 0, 1, 0, 0, asOfCounter)).toISOString(),
    playerStats: lines.map(([id, line]) => statRow(id, line)),
    teamStats: [],
  };
};

const start = (harness: Harness, options: { config?: unknown; seed?: number; players?: readonly PlayerId[] } = {}): RoomState => {
  const result = reduceAll(
    newRoom(T0, options.seed ?? 42),
    [
      ...(options.players ?? [P2, P3, P4]).map((playerId) => ({ type: 'PLAYER_JOIN' as const, playerId, nickname: playerId, isGuest: true })),
      { type: 'SELECT_GAME', actorId: HOST, moduleId: M8_ID, config: options.config ?? null },
      { type: 'START_SESSION', actorId: HOST },
    ],
    harness.deps,
  );
  expect(result.rejection).toBeNull();
  return result.state;
};
const feed = (room: RoomState, deps: EngineDeps, events: readonly MatchEvent[]): Reduction =>
  reduceRoom(room, { type: 'MATCH_EVENTS', events }, deps);
const pick = (room: RoomState, deps: EngineDeps, playerId: PlayerId, footballerId: unknown): Reduction =>
  reduceRoom(room, { type: 'SUBMIT_ANSWER', playerId, roundId: currentRound(room)?.id ?? ('' as never), payload: { footballerId } }, deps);
const payloadOf = (room: RoomState): M8PublicPayload => currentRound(room)?.publicPayload as M8PublicPayload;
const solutionOf = (room: RoomState): M8Solution => currentRound(room)?.solution as M8Solution;
const summaryOf = (room: RoomState) =>
  currentRound(room)?.outcome?.summary as {
    status: string;
    endedBy: string | null;
    picks: { playerId: string; footballerId: string; defaulted: boolean }[];
    duels: { level: number; stat: M8Stat; loserId: string | null; winnerId: string; decidedBy: M8Stat | null }[];
    championId: string | null;
    lines: Record<string, number | string>[];
  };

const HISTORY: readonly MatchEvent[] = [matchEvent('KICK_OFF', { id: 'ko', minute: 0 }), matchEvent('FOUL', { id: 'f30', minute: 30 })];
const WHISTLE = [...HISTORY, matchEvent('FULL_TIME', { id: 'ft', minute: 90, extraMinute: 4 })];

/** Mid-match room: baselined at 30', every player has picked footballer `index` from `picks`. */
const pickedRoom = (picks: Readonly<Record<string, FootballPlayerId>>, config: Partial<typeof M8_DEFAULT_CONFIG> = {}, fixture = LIVE_FIXTURE) => {
  const harness = makeHarness({ data: sampleData({ fixture }) });
  let room = start(harness, { config: { ...M8_DEFAULT_CONFIG, ...config } });
  room = feed(room, harness.deps, HISTORY).state;
  for (const [playerId, footballerId] of Object.entries(picks)) {
    const result = pick(room, harness.deps, asPlayerId(playerId), footballerId);
    expect(result.rejection).toBeNull();
    room = result.state;
  }
  return { harness, room };
};

/* --------------------------------- contract -------------------------------- */

describe('M8 contract and generation', () => {
  it('is a live long-running bet observing events and stats, never mixed', () => {
    expect(module.kind).toBe('long-running-bet');
    expect(module.supportsLiveEvents).toBe(true);
    expect(module.supportsLiveStats).toBe(true);
    expect(module.liveEventWindow).toBe('since-round-open');
    expect(module.dataRequirements).toEqual(['hasLineups', 'hasLiveEvents', 'hasPlayerMatchStats']);
    expect(module.minPlayers).toBe(2);
    expect(isMixable(module, 'matchday')).toBe(false);
    expect(module.parseConfig({ ...M8_DEFAULT_CONFIG, stats: ['PASSES'] }).ok).toBe(false);
    expect(module.parseConfig({ ...M8_DEFAULT_CONFIG, stats: ['SHOTS', 'SHOTS'] }).ok).toBe(false);
  });

  it('seeds a bracket with one stat per level and deals every player a distinct private default', () => {
    for (const [count, levels] of [
      [2, 1],
      [3, 2],
      [4, 2],
      [5, 3],
      [8, 3],
    ] as const) {
      const players = [HOST, ...Array.from({ length: count - 1 }, (_, index) => asPlayerId(`x${index}`))];
      const round = mustGenerate(module, { players });
      const payload = round.publicPayload as M8PublicPayload;
      expect([...payload.seeds].sort()).toEqual([...players].sort());
      expect(payload.levelStats).toHaveLength(levels);
      expect(new Set(payload.levelStats).size).toBe(Math.min(levels, 4));
      const defaults = players.map((playerId) => (round.privatePayloads[playerId] as { defaultPick: string }).defaultPick);
      expect(new Set(defaults).size).toBe(count);
      expect(payload.options).toHaveLength(22);
      expect(round.answerWindowMs).toBe(WINDOW);
    }
    expect(generateWith(module, { players: [HOST] })).toMatchObject({ ok: false, reason: 'NOT_ENOUGH_PLAYERS' });
    expect(generateWith(module, { data: sampleData({ lineups: null }) })).toMatchObject({ ok: false, reason: 'INSUFFICIENT_DATA' });
    expect(generateWith(module, { data: sampleData({ fixture: { ...FIXTURE, status: 'FINISHED' } }) })).toMatchObject({
      ok: false,
      reason: 'WRONG_ROUND_CONTEXT',
    });
    expect(mustGenerate(module, { seed: 3 })).toEqual(mustGenerate(module, { seed: 3 }));
  });

  it('validates picks: starters only, bracket members only, changeable in the window', () => {
    const { harness, room } = pickedRoom({});
    expect(pick(room, harness.deps, HOST, 'not-a-player').rejection?.submissionCode).toBe('UNKNOWN_OPTION');
    expect(pick(room, harness.deps, HOST, 42).rejection?.submissionCode).toBe('SCHEMA');
    const joined = reduceRoom(room, { type: 'PLAYER_JOIN', playerId: asPlayerId('late'), nickname: 'Late', isGuest: true }, harness.deps).state;
    expect(pick(joined, harness.deps, asPlayerId('late'), fb(3)).rejection?.submissionCode).toBe('NOT_ALLOWED');
    const first = pick(room, harness.deps, HOST, fb(3)).state;
    const changed = pick(first, harness.deps, HOST, fb(4));
    expect(changed.rejection).toBeNull();
    harness.clock.advance(WINDOW + 1);
    expect(pick(changed.state, harness.deps, HOST, fb(5)).rejection?.code).toBe('DEADLINE_PASSED');
  });

  it('never shows a rival’s pick or default before the reveal', () => {
    const { harness, room } = pickedRoom({ [HOST]: fb(3) });
    const hostDefault = (currentRound(room)?.privatePayloads[HOST] as { defaultPick: string }).defaultPick;
    const p2View = projectFor(room, P2, harness.deps);
    expect(p2View.round?.privatePayload).toEqual(currentRound(room)?.privatePayloads[P2]);
    expect(JSON.stringify(p2View.round?.privatePayload)).not.toContain(hostDefault);
    expect(p2View.round?.yourSubmission).toBeNull();
    expect(projectFor(room, null, harness.deps).round?.privatePayload).toBeNull();
    expect(projectFor(room, HOST, harness.deps).round?.yourSubmission).toEqual({ footballerId: fb(3) });
    expect(p2View.round && 'solution' in p2View.round).toBe(false);
  });
});

/* ------------------------------- MATCH_STATS ------------------------------- */

describe('MATCH_STATS (engine contract)', () => {
  it('is validated, ignored when not newer, and rejected outside an open round', () => {
    const { harness, room } = pickedRoom({});
    const bad = reduceRoom(room, { ...stats([]), asOf: 'yesterday' } as RoomAction, harness.deps);
    expect(bad.rejection?.code).toBe('INVALID_STATS');
    const negative = reduceRoom(room, stats([[fb(1), { shots: -1 }]]), harness.deps);
    expect(negative.rejection?.code).toBe('INVALID_STATS');

    const first = reduceRoom(room, stats([[fb(1), { shots: 1 }]], '2026-01-02T00:00:10Z'), harness.deps);
    expect(first.rejection).toBeNull();
    expect(currentRound(first.state)?.statsAsOf).toBe(Date.parse('2026-01-02T00:00:10Z'));
    // Same or older snapshot: nothing happens.
    expect(reduceRoom(first.state, stats([[fb(1), { shots: 9 }]], '2026-01-02T00:00:10Z'), harness.deps).state).toBe(first.state);
    expect(reduceRoom(first.state, stats([[fb(1), { shots: 9 }]], '2026-01-02T00:00:05Z'), harness.deps).state).toBe(first.state);

    expect(reduceRoom(newRoom(), stats([]), harness.deps).rejection?.code).toBe('WRONG_PHASE');
    const revealed = reduceRoom(first.state, { type: 'REVEAL_ROUND', actorId: HOST }, harness.deps).state;
    expect(revealed.phase).toBe('roundReveal');
  });

  it('is a no-op for modules without a stats observer, and for another fixture', () => {
    const harness = makeHarness({ data: sampleData({ fixture: LIVE_FIXTURE }) });
    const m7Room = reduceAll(
      newRoom(),
      [
        { type: 'PLAYER_JOIN', playerId: P2, nickname: 'Bea', isGuest: true },
        { type: 'SELECT_GAME', actorId: HOST, moduleId: asGameModuleId('M7'), config: null },
        { type: 'START_SESSION', actorId: HOST },
      ],
      harness.deps,
    ).state;
    expect(reduceRoom(m7Room, stats([]), harness.deps).state).toBe(m7Room);

    const { harness: h2, room } = pickedRoom({});
    const foreign = reduceRoom(room, stats([[fb(1), { shots: 3 }]], undefined, 'other-fixture'), h2.deps).state;
    expect(solutionOf(foreign).latest).toBeNull();
  });
});

/* ------------------------------- the bracket ------------------------------- */

describe('playM8Bracket (pure)', () => {
  const snap = (lines: ReadonlyArray<readonly [FootballPlayerId, Line]>) => ({
    asOf: 0,
    receivedAt: 0,
    rows: lines.map(([id, line]) => ({
      footballerId: id,
      shots: line.shots ?? 0,
      shotsOnTarget: line.sot ?? 0,
      goalInvolvements: (line.goals ?? 0) + (line.assists ?? 0),
      fouls: line.fouls ?? 0,
      minutes: 90,
    })),
  });
  const A = asPlayerId('a');
  const B = asPlayerId('b');
  const C = asPlayerId('c');
  const D = asPlayerId('d');
  const E = asPlayerId('e');
  const man: Record<string, FootballPlayerId> = { a: fb(1), b: fb(2), c: fb(3), d: fb(4), e: fb(5) };
  const pickOf = (playerId: PlayerId) => man[playerId] ?? fb(0);

  it('pairs seeds in order, advances winners, and measures final − baseline', () => {
    const from = snap([[fb(1), { shots: 4 }]]);
    const to = snap([
      [fb(1), { shots: 5, goals: 1 }],
      [fb(2), { shots: 2 }],
      [fb(3), { shots: 3, sot: 3 }],
      [fb(4), { shots: 0 }],
    ]);
    expect(m8StatValue('SHOTS', fb(1), from, to)).toBe(1);
    const bracket = playM8Bracket([A, B, C, D], ['SHOTS', 'GOAL_INVOLVEMENTS'], pickOf, from, to);
    expect(bracket.duels.map((duel) => [duel.level, duel.playerA, duel.playerB, duel.winnerId, duel.loserId])).toEqual([
      [1, A, B, B, A], // 1 shot since the baseline vs 2
      [1, C, D, C, D],
      [2, B, C, C, B], // goal involvements 0-0 → shots on target 0-3
    ]);
    expect(bracket.duels[2]?.decidedBy).toBe('SHOTS_ON_TARGET');
    expect(bracket.championId).toBe(C);
    expect(bracket.wins).toEqual({ [B]: 1, [C]: 2 });
  });

  it('fewer fouls wins FEWEST_FOULS; a complete tie sends the higher seed on and nobody loses', () => {
    const to = snap([
      [fb(1), { fouls: 3 }],
      [fb(2), { fouls: 1 }],
    ]);
    const fouls = playM8Bracket([A, B], ['FEWEST_FOULS'], pickOf, null, to);
    expect(fouls.duels[0]).toMatchObject({ winnerId: B, loserId: A, valueA: 3, valueB: 1 });
    const tie = playM8Bracket([C, D], ['SHOTS'], pickOf, null, snap([]));
    expect(tie.duels[0]).toMatchObject({ winnerId: C, loserId: null, decidedBy: null });
    expect(tie.championId).toBe(C);
  });

  it('gives the odd player out a bye', () => {
    const bracket = playM8Bracket([A, B, C, D, E], ['SHOTS'], pickOf, null, snap([[fb(2), { shots: 1 }]]));
    expect(bracket.byes).toEqual([
      { level: 1, playerId: E },
      { level: 2, playerId: E },
    ]);
    expect(bracket.duels).toHaveLength(4);
    expect(bracket.championId).not.toBeNull();
  });
});

/* -------------------------------- settlement -------------------------------- */

describe('M8 settlement through the reducer', () => {
  const picks = { [HOST]: fb(1), [P2]: fb(2), [P3]: fb(3), [P4]: fb(4) };

  it('measures from the last snapshot before picks lock and settles on the first after the whistle', () => {
    const { harness, room: picked } = pickedRoom(picks, { stats: ['SHOTS'] });
    let room = reduceRoom(picked, stats([[fb(1), { shots: 5 }], [fb(2), { shots: 1 }]]), harness.deps).state;
    harness.clock.advance(WINDOW);
    room = reduceRoom(room, stats([[fb(1), { shots: 6 }], [fb(2), { shots: 2 }]]), harness.deps).state;
    expect(solutionOf(room).baseline?.rows.find((row) => row.footballerId === fb(1))?.shots).toBe(5);
    room = feed(room, harness.deps, WHISTLE).state;
    expect(room.phase).toBe('playing');
    expect(payloadOf(room).whistle).toBe(true);
    const final = [
      [fb(1), { shots: 6 }],
      [fb(2), { shots: 4 }],
      [fb(3), { shots: 1 }],
      [fb(4), { shots: 0 }],
    ] as const;
    room = reduceRoom(room, stats(final), harness.deps).state;
    expect(room.phase).toBe('roundReveal');
    expect(solutionOf(room)).toMatchObject({ status: 'settled', endedBy: 'FULL_TIME' });
    const summary = summaryOf(room);
    // Since the baseline: fb(1) 1 shot, fb(2) 3, fb(3) 1, fb(4) 0.
    expect(summary.lines.find((line) => line['footballerId'] === fb(2))?.['SHOTS']).toBe(3);
    expect(summary.championId).toBe(P2);
    expect(summary.picks.every((entry) => !entry.defaulted)).toBe(true);
    const losers = summary.duels.flatMap((duel) => (duel.loserId === null ? [] : [duel.loserId]));
    const charged = room.penalties.filter((entry) => entry.reason === 'DUEL_LOST');
    expect(charged.map((entry) => entry.recipientId)).toEqual(losers);
    expect(charged.every((entry) => entry.appliedSips === 2 && entry.meta?.['stat'] === 'SHOTS')).toBe(true);
    const outcome = currentRound(room)?.outcome;
    expect(outcome?.winnerIds).toEqual([P2]);
    expect(outcome?.scores.find((entry) => entry.playerId === P2)).toMatchObject({ correct: true });
  });

  it('with no snapshot before picks lock, the first one after is the baseline', () => {
    const { harness, room: picked } = pickedRoom(picks, { stats: ['SHOTS'] });
    harness.clock.advance(WINDOW);
    let room = reduceRoom(picked, stats([[fb(1), { shots: 9 }]]), harness.deps).state;
    expect(solutionOf(room).baseline?.rows[0]?.shots).toBe(9);
    room = feed(room, harness.deps, WHISTLE).state;
    room = reduceRoom(room, stats([[fb(1), { shots: 9 }], [fb(2), { shots: 1 }]]), harness.deps).state;
    expect(summaryOf(room).lines.find((line) => line['footballerId'] === fb(1))?.['SHOTS']).toBe(0);
  });

  it('a round opened before kickoff measures from zero', () => {
    const { harness, room: picked } = pickedRoom(picks, { stats: ['SHOTS'] }, UPCOMING_FIXTURE);
    harness.clock.advance(WINDOW);
    let room = feed(picked, harness.deps, [matchEvent('FULL_TIME', { id: 'ft', minute: 90 })]).state;
    room = reduceRoom(room, stats([[fb(3), { shots: 2 }]]), harness.deps).state;
    expect(solutionOf(room).baseline?.rows).toEqual([]);
    expect(summaryOf(room).championId).toBe(P3);
  });

  it('waits for a snapshot after the whistle (stats sent before the events of the same poll)', () => {
    const { harness, room: picked } = pickedRoom(picks);
    harness.clock.advance(WINDOW);
    let room = reduceRoom(picked, stats([[fb(1), { shots: 1 }]]), harness.deps).state;
    const same = stats([[fb(1), { shots: 2 }]], '2026-02-01T00:00:00Z');
    room = reduceRoom(room, same, harness.deps).state;
    room = feed(room, harness.deps, WHISTLE).state;
    // A re-send of the same snapshot is ignored…
    expect(reduceRoom(room, same, harness.deps).state).toBe(room);
    // …the confirming poll's newer one settles.
    room = reduceRoom(room, stats([[fb(1), { shots: 2 }]], '2026-02-01T00:00:15Z'), harness.deps).state;
    expect(solutionOf(room).status).toBe('settled');
  });

  it('non-pickers duel with their dealt default; nobody drinks for not picking', () => {
    const { harness, room: picked } = pickedRoom({ [HOST]: fb(1) }, { stats: ['SHOTS'] });
    const defaults = Object.fromEntries(
      [P2, P3, P4].map((playerId) => [playerId, (currentRound(picked)?.privatePayloads[playerId] as { defaultPick: string }).defaultPick]),
    );
    harness.clock.advance(WINDOW);
    let room = reduceRoom(picked, stats([]), harness.deps).state;
    room = feed(room, harness.deps, WHISTLE).state;
    room = reduceRoom(room, stats([[fb(1), { shots: 1 }]]), harness.deps).state;
    const summary = summaryOf(room);
    for (const entry of summary.picks.filter((pickEntry) => pickEntry.playerId !== HOST)) {
      expect(entry).toMatchObject({ defaulted: true, footballerId: defaults[entry.playerId] });
    }
    expect(room.penalties.some((entry) => entry.reason === 'NO_ANSWER')).toBe(false);
  });

  it('void: opened after full time, whistle before picks lock, or a reveal with nothing to measure', () => {
    const harness = makeHarness({ data: sampleData({ fixture: LIVE_FIXTURE }) });
    const over = feed(start(harness), harness.deps, WHISTLE).state;
    expect(solutionOf(over)).toMatchObject({ status: 'void', endedBy: 'MATCH_OVER' });
    expect(over.penalties).toEqual([]);

    // The whistle blows while picks are still open: there is no stats window to duel on.
    const early = pickedRoom(picks);
    let room = feed(early.room, early.harness.deps, WHISTLE).state;
    room = reduceRoom(room, stats([[fb(1), { shots: 1 }]]), early.harness.deps).state;
    expect(room.phase).toBe('roundReveal');
    expect(solutionOf(room)).toMatchObject({ status: 'void', endedBy: 'NO_PLAY' });
    expect(room.penalties).toEqual([]);

    const bare = pickedRoom(picks);
    const revealed = reduceRoom(bare.room, { type: 'REVEAL_ROUND', actorId: HOST }, bare.harness.deps).state;
    expect(summaryOf(revealed)).toMatchObject({ status: 'void', endedBy: 'NO_PLAY', championId: null });
    expect(currentRound(revealed)?.outcome?.scores).toEqual([]);
  });

  it('a host reveal mid-match settles the bracket on the stats so far', () => {
    const { harness, room: picked } = pickedRoom(picks, { stats: ['SHOTS'] });
    harness.clock.advance(WINDOW);
    let room = reduceRoom(picked, stats([]), harness.deps).state;
    room = reduceRoom(room, stats([[fb(4), { shots: 3 }]]), harness.deps).state;
    room = reduceRoom(room, { type: 'REVEAL_ROUND', actorId: HOST }, harness.deps).state;
    expect(summaryOf(room)).toMatchObject({ status: 'settled', endedBy: 'HOST', championId: P4 });
  });

  it('caps apply, a departed loser has nobody to drink it, and replays are byte-identical', () => {
    const play = () => {
      const { harness, room: picked } = pickedRoom(picks, { stats: ['SHOTS'], duelSips: 10 });
      let room = { ...picked, settings: mergeRoomSettings(picked.settings, { penaltyCaps: { perPenalty: 4, perRound: 10, perSession: 60 } }) };
      room = reduceRoom(room, { type: 'PLAYER_LEAVE', playerId: P4 }, harness.deps).state;
      harness.clock.advance(WINDOW);
      room = reduceRoom(room, stats([], '2026-03-01T00:00:00Z'), harness.deps).state;
      room = feed(room, harness.deps, WHISTLE).state;
      return reduceRoom(
        room,
        stats([[fb(1), { shots: 3 }], [fb(2), { shots: 2 }], [fb(3), { shots: 1 }]], '2026-03-01T00:00:15Z'),
        harness.deps,
      ).state;
    };
    const room = play();
    const charged = room.penalties.filter((entry) => entry.reason === 'DUEL_LOST');
    expect(charged.every((entry) => entry.appliedSips === 4 && entry.cappedBy === 'perPenalty')).toBe(true);
    expect(charged.some((entry) => entry.recipientId === P4)).toBe(false);
    expect(JSON.stringify(play())).toBe(JSON.stringify(room));
  });
});

/* ------------------------- recorded match: PSG 6-1 Slovan ------------------------- */

describe('M8 against the recorded PSG 6-1 Slovan Bratislava timeline (401915445)', () => {
  const DEMBELE = '229744';
  const FERRAN = '265869';
  const CAMARA = '310419';
  const RUIZ = '214596';

  it('picked before kickoff, played to the whistle, settled on the recorded final stat line', () => {
    const upcoming = { ...PSG_SLOVAN_FIXTURE, status: 'SCHEDULED' as const, kickoff: new Date(T0 + 120_000).toISOString() };
    for (const seed of [1, 7, 42, 99]) {
      const harness = makeHarness({ data: sampleData({ fixture: upcoming, lineups: PSG_SLOVAN_LINEUPS }) });
      let room = start(harness, { seed, config: { ...M8_DEFAULT_CONFIG, stats: ['GOAL_INVOLVEMENTS'] } });
      for (const [playerId, footballerId] of [
        [HOST, DEMBELE],
        [P2, FERRAN],
        [P3, CAMARA],
        [P4, RUIZ],
      ] as const) {
        room = pick(room, harness.deps, playerId, footballerId).state;
      }
      harness.clock.advance(WINDOW);
      for (let index = 0; index < PSG_SLOVAN_EVENTS.length; index += 1) {
        room = feed(room, harness.deps, PSG_SLOVAN_EVENTS.slice(0, index + 1)).state;
      }
      expect(payloadOf(room).whistle).toBe(true);
      room = reduceRoom(
        room,
        {
          type: 'MATCH_STATS',
          fixtureId: PSG_SLOVAN_FIXTURE.id,
          asOf: '2026-09-09T20:55:00.000Z',
          playerStats: PSG_SLOVAN_FINAL_PLAYER_STATS,
          teamStats: PSG_SLOVAN_FINAL_TEAM_STATS,
        },
        harness.deps,
      ).state;
      expect(solutionOf(room).status).toBe('settled');
      const summary = summaryOf(room);
      const line = (id: string) => summary.lines.find((entry) => entry['footballerId'] === id);
      // Dembélé 2G+2A, 10 shots (3 on target); Ferran Torres 3G, 6 (3); Camara 1G, 5 (2); Fabián Ruiz 1G, 4 (1).
      expect(line(DEMBELE)).toMatchObject({ GOAL_INVOLVEMENTS: 4, SHOTS: 10, SHOTS_ON_TARGET: 3, FEWEST_FOULS: 1 });
      expect(line(FERRAN)).toMatchObject({ GOAL_INVOLVEMENTS: 3, SHOTS: 6, SHOTS_ON_TARGET: 3, FEWEST_FOULS: 0 });
      expect(line(CAMARA)).toMatchObject({ GOAL_INVOLVEMENTS: 1, SHOTS_ON_TARGET: 2 });
      expect(line(RUIZ)).toMatchObject({ GOAL_INVOLVEMENTS: 1, SHOTS_ON_TARGET: 1 });
      // Dembélé tops every duel on goal involvements, whatever the seeding.
      expect(summary.championId).toBe(HOST);
      expect(summary.duels).toHaveLength(3);
      // Camara v Ruiz (1-1 on involvements) goes to shots on target, 2-1, whenever they meet.
      const camaraRuiz = summary.duels.find((duel) => [duel.winnerId, duel.loserId].sort().join() === [P3, P4].sort().join());
      if (camaraRuiz !== undefined) expect(camaraRuiz).toMatchObject({ winnerId: P3, decidedBy: 'SHOTS_ON_TARGET' });
      expect(room.penalties.filter((entry) => entry.reason === 'DUEL_LOST')).toHaveLength(3);
      expect(room.penalties.some((entry) => entry.reason === 'DUEL_LOST' && entry.recipientId === HOST)).toBe(false);
    }
  });
});
