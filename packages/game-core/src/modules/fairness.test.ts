/**
 * Release-QA regressions: sessions that cannot outlive their content, no drinks for a window a player
 * never had, and one rejection code for "that match is over".
 */

import type { Fixture } from '@fdg/football-data';
import { describe, expect, it } from 'vitest';
import type { RoomAction } from '../actions.js';
import type { Harness } from '../harness.test-utils.js';
import { FIXTURE, HOST, LINEUPS, makeHarness, newRoom, P2, sampleData, sub, T0 } from '../harness.test-utils.js';
import type { GameModuleId, PlayerId } from '../ids.js';
import { asGameModuleId, asPlayerId } from '../ids.js';
import type { RoomState } from '../state.js';
import { activeSession, currentRound } from '../state.js';
import { reduceAll, reduceRoom } from '../reducer.js';
import { fairNonSubmitters, LATE_JOIN_MIN_ANSWER_MS } from './helpers.js';
import { M10_ID, m10LineupRecall } from './m10-lineup-recall.js';
import { M2_ID } from './m2-who-is-that-player.js';
import { M3_ID } from './m3-shirt-number.js';

const LATE = asPlayerId('late');

const startRoom = (harness: Harness, moduleId: GameModuleId, rounds?: number): RoomState => {
  const actions: RoomAction[] = [
    { type: 'PLAYER_JOIN', playerId: P2, nickname: 'Bea', isGuest: true },
    ...(rounds === undefined ? [] : [{ type: 'UPDATE_SETTINGS' as const, actorId: HOST, patch: { roundsPerSession: rounds } }]),
    { type: 'SELECT_GAME', actorId: HOST, moduleId, config: null },
    { type: 'START_SESSION', actorId: HOST },
  ];
  const result = reduceAll(newRoom(), actions, harness.deps);
  expect(result.rejection).toBeNull();
  return result.state;
};

describe('M10 sessions end after the XIs they can serve', () => {
  it('a default 8-round room plans 2 rounds and ends cleanly with SESSION_FINISHED', () => {
    const harness = makeHarness();
    let room = startRoom(harness, M10_ID);
    expect(room.settings.roundsPerSession).toBe(8);
    expect(activeSession(room)?.roundsPlanned).toBe(2);
    const events: string[] = [];
    for (let guard = 0; guard < 6; guard += 1) {
      if (room.phase === 'playing') room = reduceRoom(room, { type: 'REVEAL_ROUND', actorId: HOST }, harness.deps).state;
      const advanced = reduceRoom(room, { type: 'ADVANCE', actorId: HOST }, harness.deps);
      events.push(...advanced.events.map((event) => event.type));
      room = advanced.state;
      if (room.phase === 'intermission' && activeSession(room)?.finishedAt !== null) break;
      room = reduceRoom(room, { type: 'ADVANCE', actorId: HOST }, harness.deps).state;
    }
    expect(events).toContain('SESSION_FINISHED');
    expect(activeSession(room)?.rounds).toHaveLength(2);
    expect(reduceRoom(room, { type: 'ADVANCE', actorId: HOST }, harness.deps).rejection?.code).toBe('SESSION_FINISHED');
  });

  it('plans one round when only one XI is usable, and never more than the room asks for', () => {
    const oneSide = makeHarness({
      data: sampleData({ lineups: { ...LINEUPS, away: { ...LINEUPS.away, startingXI: [] } } }),
    });
    expect(activeSession(startRoom(oneSide, M10_ID))?.roundsPlanned).toBe(1);
    expect(activeSession(startRoom(makeHarness(), M10_ID, 1))?.roundsPlanned).toBe(1);
    expect(m10LineupRecall.maxRoundsPerSession).toBe(2);
    expect(m10LineupRecall.plannedRounds({ config: m10LineupRecall.defaultConfig, data: sampleData({ lineups: null }) })).toBe(0);
  });
});

describe('no NO_ANSWER for a player who joined too late to answer', () => {
  it('fairNonSubmitters: a fair share is min(20 s, half the window) before the deadline', () => {
    const round = { startedAt: T0, deadlineAt: T0 + 90_000 };
    const view = (id: PlayerId, joinedAt: number) => ({ id, nickname: id, connected: true, score: 0, streak: 0, joinedAt });
    const players = [
      view(HOST, T0 - 5_000),
      view(P2, T0 + 90_000 - LATE_JOIN_MIN_ANSWER_MS),
      view(LATE, T0 + 90_000 - LATE_JOIN_MIN_ANSWER_MS + 1),
    ];
    expect(fairNonSubmitters(players, [], round)).toEqual([HOST, P2]);
    expect(fairNonSubmitters(players, [sub(HOST, {})], round)).toEqual([P2]);
    // A 15 s window: half of it (7.5 s) is the fair share.
    const short = { startedAt: T0, deadlineAt: T0 + 15_000 };
    const joined = (at: number) => [view(LATE, at)];
    expect(fairNonSubmitters(joined(T0 + 7_500), [], short)).toEqual([LATE]);
    expect(fairNonSubmitters(joined(T0 + 7_501), [], short)).toEqual([]);
    expect(fairNonSubmitters(joined(T0 + 999_999), [], { startedAt: T0, deadlineAt: null })).toEqual([LATE]);
  });

  for (const moduleId of [M10_ID, M2_ID, M3_ID]) {
    it(`${moduleId}: a player joining seconds before the deadline is not charged; one who had the window is`, () => {
      const harness = makeHarness();
      let room = startRoom(harness, moduleId);
      const round = currentRound(room);
      const window = (round?.deadlineAt ?? 0) - (round?.startedAt ?? 0);
      harness.clock.advance(window - 3_000);
      room = reduceRoom(room, { type: 'PLAYER_JOIN', playerId: LATE, nickname: 'Late', isGuest: true }, harness.deps).state;
      harness.clock.advance(3_001);
      room = reduceRoom(room, { type: 'TICK' }, harness.deps).state;
      expect(room.phase).toBe('roundReveal');
      const silent = room.penalties.filter((entry) => entry.reason === 'NO_ANSWER').map((entry) => entry.recipientId);
      expect(silent).toContain(HOST);
      expect(silent).toContain(P2);
      expect(silent).not.toContain(LATE);
    });
  }
});

describe('every live module refuses a finished match the same way', () => {
  const finished: Fixture = { ...FIXTURE, status: 'FINISHED' };
  for (const id of ['M1', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9']) {
    it(`${id}: ROUND_GENERATION_FAILED with detail WRONG_ROUND_CONTEXT`, () => {
      const harness = makeHarness({ data: sampleData({ fixture: finished }) });
      const players: PlayerId[] = [P2, asPlayerId('p3')];
      const result = reduceAll(
        newRoom(),
        [
          ...players.map((playerId) => ({ type: 'PLAYER_JOIN' as const, playerId, nickname: playerId, isGuest: true })),
          { type: 'SELECT_GAME', actorId: HOST, moduleId: asGameModuleId(id), config: null },
          { type: 'START_SESSION', actorId: HOST },
        ],
        harness.deps,
      );
      expect(result.rejection?.code).toBe('ROUND_GENERATION_FAILED');
      expect(result.rejection?.detail).toBe('WRONG_ROUND_CONTEXT:fixture FINISHED');
    });
  }
});
