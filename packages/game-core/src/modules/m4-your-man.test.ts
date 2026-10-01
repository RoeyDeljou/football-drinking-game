import type { Fixture, FootballPlayerId, MatchEvent } from '@fdg/football-data';
import { describe, expect, it } from 'vitest';
import type { Harness } from '../harness.test-utils.js';
import {
  ALL_BUILT,
  FIXTURE,
  generateWith,
  HOME_TEAM_ID,
  HOST,
  LINEUPS,
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
import { PSG_SLOVAN_EVENTS, PSG_SLOVAN_FIXTURE, PSG_SLOVAN_LINEUPS } from './fixtures/psg-slovan-401915445.test-utils.js';
import { isMixable } from './mixed.js';
import type { M4PublicPayload, M4Solution } from './m4-your-man.js';
import { draftStarters, M4_DEFAULT_CONFIG, M4_ID, m4ActionsOf, m4YourMan as module } from './m4-your-man.js';

const LIVE_FIXTURE: Fixture = { ...FIXTURE, status: 'LIVE', kickoff: new Date(T0 - 3_600_000).toISOString() };
const fb = (index: number): FootballPlayerId => {
  const id = ALL_BUILT[index]?.player.id;
  if (id === undefined) throw new Error('no footballer');
  return id;
};
const ev = (
  id: string,
  type: MatchEvent['type'],
  minute: number,
  playerId: FootballPlayerId | null = null,
  relatedPlayerId: FootballPlayerId | null = null,
): MatchEvent => ({ ...matchEvent(type, { id, minute, playerId, teamId: HOME_TEAM_ID }), relatedPlayerId });

const HISTORY: readonly MatchEvent[] = [ev('ko', 'KICK_OFF', 0), ev('f30', 'FOUL', 30, fb(5))];

const start = (harness: Harness, options: { config?: unknown; seed?: number; players?: readonly PlayerId[] } = {}): RoomState => {
  const result = reduceAll(
    newRoom(T0, options.seed ?? 42),
    [
      ...(options.players ?? [P2, P3]).map((playerId) => ({ type: 'PLAYER_JOIN' as const, playerId, nickname: playerId, isGuest: true })),
      { type: 'SELECT_GAME', actorId: HOST, moduleId: M4_ID, config: options.config ?? null },
      { type: 'START_SESSION', actorId: HOST },
    ],
    harness.deps,
  );
  expect(result.rejection).toBeNull();
  return result.state;
};
const feed = (room: RoomState, deps: EngineDeps, events: readonly MatchEvent[]): Reduction =>
  reduceRoom(room, { type: 'MATCH_EVENTS', events }, deps);
const payloadOf = (room: RoomState): M4PublicPayload => currentRound(room)?.publicPayload as M4PublicPayload;
const manOf = (room: RoomState, playerId: PlayerId): FootballPlayerId | null | undefined =>
  payloadOf(room).draft.find((entry) => entry.playerId === playerId)?.current;
const roundPenalties = (room: RoomState) => room.penalties.filter((entry) => entry.roundId === currentRound(room)?.id);

/** Mid-match room (baselined at 30') where the host's man is `man`. */
const hostWith = (man: FootballPlayerId, config: Partial<typeof M4_DEFAULT_CONFIG> = {}) => {
  const harness = makeHarness({ data: sampleData({ fixture: LIVE_FIXTURE }) });
  for (let seed = 1; seed < 400; seed += 1) {
    const room = start(harness, { seed, config: { ...M4_DEFAULT_CONFIG, ...config } });
    if (manOf(room, HOST) === man) return { harness, room: feed(room, harness.deps, HISTORY).state };
  }
  throw new Error('no seed drafts that man to the host');
};

describe('M4 contract and draft', () => {
  it('is a live private-card round, never mixed, taking no submissions', () => {
    expect(module.kind).toBe('private-card');
    expect(module.liveEventWindow).toBe('since-round-open');
    expect(module.dataRequirements).toEqual(['hasLineups', 'hasLiveEvents']);
    expect(isMixable(module, 'matchday')).toBe(false);
    const { harness, room } = hostWith(fb(8));
    const submit = reduceRoom(room, { type: 'SUBMIT_ANSWER', playerId: HOST, roundId: currentRound(room)?.id ?? ('' as never), payload: {} }, harness.deps);
    expect(submit.rejection?.submissionCode).toBe('NOT_ALLOWED');
  });

  it('drafts distinct outfield starters while they last, then a fresh lap; deterministic', () => {
    const pool = Array.from({ length: 5 }, (_, index) => fb(index));
    const ids = Array.from({ length: 7 }, (_, index) => asPlayerId(`p${index}`));
    const draft = draftStarters(ids, pool, createSeededRng(4).shuffle);
    expect(new Set(draft.slice(0, 5).map((entry) => entry.current)).size).toBe(5);
    expect(draft.every((entry) => entry.chain[0]?.via === 'draft' && !entry.sentOff)).toBe(true);
    expect(draftStarters(ids, pool, createSeededRng(4).shuffle)).toEqual(draft);
    const round = mustGenerate(module, { players: [HOST, P2, P3] });
    const goalkeepers = [LINEUPS.home, LINEUPS.away].flatMap((side) => side.startingXI.filter((entry) => entry.position === 'GK')).map((entry) => entry.playerId);
    for (const entry of (round.publicPayload as M4PublicPayload).draft) expect(goalkeepers).not.toContain(entry.current);
    expect((round.publicPayload as M4PublicPayload).roster).toHaveLength(22);
    const withKeepers = mustGenerate(module, { players: Array.from({ length: 22 }, (_, index) => asPlayerId(`q${index}`)), config: { ...M4_DEFAULT_CONFIG, includeGoalkeepers: true } });
    expect(new Set((withKeepers.publicPayload as M4PublicPayload).draft.map((entry) => entry.current)).size).toBe(22);
  });

  it('refuses without a fixture, without starters, or once the match is over', () => {
    expect(generateWith(module, { data: sampleData({ fixture: null }) })).toMatchObject({ ok: false, reason: 'INSUFFICIENT_DATA' });
    expect(generateWith(module, { data: sampleData({ lineups: null }) })).toMatchObject({ ok: false, reason: 'INSUFFICIENT_DATA' });
    expect(generateWith(module, { data: sampleData({ fixture: { ...FIXTURE, status: 'FINISHED' } }) })).toMatchObject({
      ok: false,
      reason: 'WRONG_ROUND_CONTEXT',
    });
  });

  it('m4ActionsOf reads the per-player feed data', () => {
    expect(m4ActionsOf(ev('f', 'FOUL', 1, fb(1)))).toEqual([[fb(1), 'FOUL']]);
    expect(m4ActionsOf(ev('pm', 'PENALTY_MISSED', 1, fb(1)))).toEqual([[fb(1), 'MISS']]);
    expect(m4ActionsOf(ev('g', 'GOAL', 1, fb(1), fb(2)))).toEqual([
      [fb(1), 'GOAL'],
      [fb(2), 'ASSIST'],
    ]);
    expect(m4ActionsOf(ev('y2', 'SECOND_YELLOW', 1, fb(1)))).toEqual([[fb(1), 'RED']]);
    expect(m4ActionsOf(ev('sot', 'SHOT_ON_TARGET', 1, fb(1)))).toEqual([]);
    expect(m4ActionsOf(ev('nobody', 'FOUL', 1, null))).toEqual([]);
  });
});

describe('M4 drinks', () => {
  it('your man fouls, misses and gets booked: you drink, at once', () => {
    const man = fb(8);
    const { harness, room } = hostWith(man);
    const next = feed(room, harness.deps, [...HISTORY, ev('f', 'FOUL', 31, man), ev('m', 'SHOT_OFF_TARGET', 32, man), ev('y', 'YELLOW_CARD', 33, man)]).state;
    expect(roundPenalties(next).map((entry) => [entry.recipientId, entry.target, entry.appliedSips, entry.meta?.['action']])).toEqual([
      [HOST, 'self', 1, 'FOUL'],
      [HOST, 'self', 1, 'MISS'],
      [HOST, 'self', 2, 'YELLOW'],
    ]);
    expect(payloadOf(next).log.map((entry) => entry.action)).toEqual(['FOUL', 'MISS', 'YELLOW']);
    // A re-poll never charges twice; the 30' foul (history) never charged at all.
    expect(feed(next, harness.deps, [...HISTORY, ev('f', 'FOUL', 31, man)]).state).toBe(next);
  });

  it('your man scores or assists: everyone else drinks', () => {
    const man = fb(8);
    const { harness, room } = hostWith(man);
    const next = feed(room, harness.deps, [...HISTORY, ev('g', 'GOAL', 40, man, fb(9)), ev('g2', 'GOAL', 44, fb(9), man)]).state;
    const charged = roundPenalties(next);
    expect(charged.filter((entry) => entry.playerId === HOST).map((entry) => [entry.recipientId, entry.target, entry.appliedSips, entry.meta?.['action']])).toEqual([
      [P2, 'others', 2, 'GOAL'],
      [P3, 'others', 2, 'GOAL'],
      [P2, 'others', 1, 'ASSIST'],
      [P3, 'others', 1, 'ASSIST'],
    ]);
    expect(charged.some((entry) => entry.recipientId === HOST && entry.playerId === HOST)).toBe(false);
  });

  it('an own goal and a red card cost you; after a red you have nobody', () => {
    const man = fb(8);
    const { harness, room } = hostWith(man);
    const next = feed(room, harness.deps, [...HISTORY, ev('og', 'OWN_GOAL', 35, man), ev('r', 'RED_CARD', 36, man), ev('f', 'FOUL', 37, man)]).state;
    expect(roundPenalties(next).filter((entry) => entry.recipientId === HOST).map((entry) => entry.requestedSips)).toEqual([3, 4]);
    expect(payloadOf(next).draft.find((entry) => entry.playerId === HOST)).toMatchObject({ current: null, sentOff: true });
  });

  it('substitution: you inherit the player coming on', () => {
    const man = fb(8);
    const sub = fb(20);
    const { harness, room } = hostWith(man);
    const next = feed(room, harness.deps, [...HISTORY, ev('s', 'SUBSTITUTION', 60, man, sub), ev('m', 'SHOT_OFF_TARGET', 61, man), ev('m2', 'SHOT_OFF_TARGET', 62, sub)]).state;
    const host = payloadOf(next).draft.find((entry) => entry.playerId === HOST);
    expect(host?.current).toBe(sub);
    expect(host?.chain).toEqual([
      { footballerId: man, via: 'draft', eventId: null },
      { footballerId: sub, via: 'substitution', eventId: 's' },
    ]);
    // Only the new man's miss is yours.
    expect(payloadOf(next).log.filter((entry) => entry.ownerIds.includes(HOST)).map((entry) => entry.eventId)).toEqual(['m2']);
  });

  it('opened mid-match: the history hands you the replacement, but nothing in it drinks', () => {
    const man = fb(8);
    const sub = fb(20);
    const harness = makeHarness({ data: sampleData({ fixture: LIVE_FIXTURE }) });
    for (let seed = 1; seed < 400; seed += 1) {
      const room = start(harness, { seed });
      if (manOf(room, HOST) !== man) continue;
      const baselined = feed(room, harness.deps, [...HISTORY, ev('g', 'GOAL', 20, man), ev('s', 'SUBSTITUTION', 25, man, sub)]).state;
      expect(manOf(baselined, HOST)).toBe(sub);
      expect(roundPenalties(baselined)).toEqual([]);
      expect(payloadOf(baselined).log).toEqual([]);
      return;
    }
    throw new Error('no seed');
  });

  it('config 0 turns a line off; room caps bound the rest', () => {
    const man = fb(8);
    const { harness, room } = hostWith(man, { foulSips: 0, missSips: 5 });
    const capped = { ...room, settings: mergeRoomSettings(room.settings, { penaltyCaps: { perPenalty: 10, perRound: 7, perSession: 60 } }) };
    const next = feed(capped, harness.deps, [...HISTORY, ev('f', 'FOUL', 31, man), ev('m1', 'SHOT_OFF_TARGET', 32, man), ev('m2', 'SHOT_OFF_TARGET', 33, man)]).state;
    expect(payloadOf(next).log).toHaveLength(3);
    expect(roundPenalties(next).map((entry) => [entry.requestedSips, entry.appliedSips])).toEqual([
      [5, 5],
      [5, 2],
    ]);
  });

  it('late joiners are not drafted; a departed owner no longer drinks', () => {
    const man = fb(8);
    const { harness, room } = hostWith(man);
    let state = reduceRoom(room, { type: 'PLAYER_JOIN', playerId: asPlayerId('late'), nickname: 'Late', isGuest: true }, harness.deps).state;
    expect(payloadOf(state).draft.some((entry) => entry.playerId === 'late')).toBe(false);
    state = reduceRoom(state, { type: 'PLAYER_LEAVE', playerId: HOST }, harness.deps).state;
    state = feed(state, harness.deps, [...HISTORY, ev('f', 'FOUL', 31, man)]).state;
    expect(roundPenalties(state)).toEqual([]);
  });

  it('ends at the whistle; void after it; reveal shows the tallies, no points', () => {
    const man = fb(8);
    const { harness, room } = hostWith(man);
    const ended = feed(room, harness.deps, [...HISTORY, ev('g', 'GOAL', 50, man), ev('ft', 'FULL_TIME', 90), ev('et', 'FOUL', 95, man)]).state;
    expect(ended.phase).toBe('roundReveal');
    expect(currentRound(ended)?.solution as M4Solution).toEqual({ status: 'ended', endedBy: 'FULL_TIME' });
    expect(payloadOf(ended).log).toHaveLength(1);
    const outcome = currentRound(ended)?.outcome;
    expect(outcome?.scores).toEqual([]);
    expect(outcome?.winnerIds).toEqual([HOST]);
    expect(outcome?.summary).toMatchObject({ endedBy: 'FULL_TIME' });

    const harness2 = makeHarness({ data: sampleData({ fixture: LIVE_FIXTURE }) });
    const over = feed(start(harness2), harness2.deps, [...HISTORY, ev('ft', 'FULL_TIME', 90)]).state;
    expect(currentRound(over)?.solution as M4Solution).toEqual({ status: 'void', endedBy: 'MATCH_OVER' });
  });

  it('draft and log are public to every viewer', () => {
    const { harness, room } = hostWith(fb(8));
    const view = projectFor(room, P3, harness.deps).round?.publicPayload as M4PublicPayload;
    expect(view.draft.map((entry) => entry.playerId)).toEqual([HOST, P2, P3]);
    expect(view.clockKnown).toBe(true);
  });
});

/* ------------------------- recorded match: PSG 6-1 Slovan ------------------------- */

describe('M4 against the recorded PSG 6-1 Slovan Bratislava timeline (401915445)', () => {
  const DEMBELE = '229744' as FootballPlayerId;
  const GODTS = '353363' as FootballPlayerId;
  const data = (status: 'SCHEDULED' | 'LIVE', kickoffOffset: number) =>
    sampleData({ fixture: { ...PSG_SLOVAN_FIXTURE, status, kickoff: new Date(T0 + kickoffOffset).toISOString() }, lineups: PSG_SLOVAN_LINEUPS });
  const withDembele = (harness: Harness): RoomState => {
    for (let seed = 1; seed < 500; seed += 1) {
      const room = start(harness, { seed, players: [P2] });
      if (manOf(room, HOST) === DEMBELE) return room;
    }
    throw new Error('no seed drafts Dembélé to the host');
  };
  const play = (room: RoomState, deps: EngineDeps, fromIndex: number): RoomState => {
    let state = room;
    for (let index = fromIndex; index < PSG_SLOVAN_EVENTS.length && state.phase === 'playing'; index += 1) {
      state = feed(state, deps, PSG_SLOVAN_EVENTS.slice(0, index + 1)).state;
    }
    return state;
  };

  it('drafted Dembélé before kickoff: his whole match, then Godts after the 64′ change', () => {
    const harness = makeHarness({ data: data('SCHEDULED', 60_000) });
    const ended = play(withDembele(harness), harness.deps, 0);
    expect(currentRound(ended)?.solution as M4Solution).toEqual({ status: 'ended', endedBy: 'FULL_TIME' });
    const mine = payloadOf(ended).log.filter((entry) => entry.ownerIds.includes(HOST));
    expect(mine.map((entry) => `${entry.action}@${entry.minute}`)).toEqual([
      'MISS@3',
      'MISS@7',
      'GOAL@17',
      'MISS@18',
      'GOAL@23',
      'FOUL@30',
      'ASSIST@31',
      'MISS@33',
      'MISS@40',
      'MISS@45',
      'ASSIST@57',
      'MISS@62',
      'MISS@90',
    ]);
    expect(mine.at(-1)?.footballerId).toBe(GODTS);
    expect(payloadOf(ended).draft.find((entry) => entry.playerId === HOST)?.chain.map((link) => link.footballerId)).toEqual([DEMBELE, GODTS]);
    // Host: 8 misses + 1 foul = 9 sips requested on himself (under the per-round cap of 10).
    const selfSips = ended.penalties.filter((entry) => entry.playerId === HOST && entry.target === 'self').reduce((sum, entry) => sum + entry.requestedSips, 0);
    expect(selfSips).toBe(9);
    // P2 drinks 2 goals × 2 + 2 assists × 1 for the host's man.
    const forHost = ended.penalties.filter((entry) => entry.playerId === HOST && entry.recipientId === P2).reduce((sum, entry) => sum + entry.requestedSips, 0);
    expect(forHost).toBe(6);
  });

  it('drafted Dembélé in a round opened at 69′: already Godts, and only his 90′ miss counts', () => {
    const harness = makeHarness({ data: data('LIVE', -60_000) });
    const room = withDembele(harness);
    const cut = PSG_SLOVAN_EVENTS.findIndex((event) => event.minute >= 70);
    const baselined = feed(room, harness.deps, PSG_SLOVAN_EVENTS.slice(0, cut)).state;
    expect(manOf(baselined, HOST)).toBe(GODTS);
    const ended = play(baselined, harness.deps, cut);
    expect(payloadOf(ended).log.filter((entry) => entry.ownerIds.includes(HOST)).map((entry) => `${entry.action}@${entry.minute}`)).toEqual(['MISS@90']);
  });
});
