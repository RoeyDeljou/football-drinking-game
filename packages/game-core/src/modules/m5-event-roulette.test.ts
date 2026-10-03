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
import type { LiveEventKind } from './live-event-kinds.js';
import { liveEventKindOf, liveEventSideOf } from './live-event-kinds.js';
import { isMixable } from './mixed.js';
import type { M5PublicPayload, M5Solution } from './m5-event-roulette.js';
import { dealEventKinds, M5_DEFAULT_CONFIG, M5_DEFAULT_EVENT_KINDS, M5_ID, m5EventRoulette as module } from './m5-event-roulette.js';

const LIVE_FIXTURE: Fixture = { ...FIXTURE, status: 'LIVE', kickoff: new Date(T0 - 3_600_000).toISOString() };
const UPCOMING_FIXTURE: Fixture = { ...FIXTURE, status: 'SCHEDULED', kickoff: new Date(T0 + 3_600_000).toISOString() };

const ev = (id: string, type: MatchEvent['type'], minute: number, extraMinute: number | null = null, teamId: string | null = HOME_TEAM_ID): MatchEvent =>
  matchEvent(type, { id, minute, extraMinute, teamId: teamId as typeof HOME_TEAM_ID | null });

/** History up to 30': the round opens at minute 30. */
const HISTORY: readonly MatchEvent[] = [ev('ko', 'KICK_OFF', 0, null, null), ev('c10', 'CORNER', 10), ev('f30', 'FOUL', 30)];

const P4 = asPlayerId('p4');

const start = (
  harness: Harness,
  options: { config?: unknown; seed?: number; players?: readonly PlayerId[] } = {},
): RoomState => {
  const players = options.players ?? [P2, P3];
  const result = reduceAll(
    newRoom(T0, options.seed ?? 42),
    [
      ...players.map((playerId) => ({ type: 'PLAYER_JOIN' as const, playerId, nickname: playerId, isGuest: true })),
      { type: 'SELECT_GAME', actorId: HOST, moduleId: M5_ID, config: options.config ?? null },
      { type: 'START_SESSION', actorId: HOST },
    ],
    harness.deps,
  );
  expect(result.rejection).toBeNull();
  return result.state;
};

const feed = (room: RoomState, deps: EngineDeps, events: readonly MatchEvent[]): Reduction =>
  reduceRoom(room, { type: 'MATCH_EVENTS', events }, deps);

const payloadOf = (room: RoomState): M5PublicPayload => currentRound(room)?.publicPayload as M5PublicPayload;
const solutionOf = (room: RoomState): M5Solution => currentRound(room)?.solution as M5Solution;
const ownerOf = (room: RoomState, kind: LiveEventKind): PlayerId | undefined =>
  payloadOf(room).deal.find((entry) => entry.event === kind)?.playerId;
const roundPenalties = (room: RoomState) => room.penalties.filter((entry) => entry.roundId === currentRound(room)?.id);

/** A mid-match room, baselined at 30', with a deal where the host owns `kind`. */
const dealtAt30 = (kind: LiveEventKind, config: Partial<typeof M5_DEFAULT_CONFIG> = {}) => {
  const harness = makeHarness({ data: sampleData({ fixture: LIVE_FIXTURE }) });
  for (let seed = 1; seed < 200; seed += 1) {
    const room = start(harness, { seed, config: { ...M5_DEFAULT_CONFIG, ...config } });
    if (ownerOf(room, kind) === HOST) return { harness, room: feed(room, harness.deps, HISTORY).state };
  }
  throw new Error(`no seed deals ${kind} to the host`);
};

/* --------------------------------- contract -------------------------------- */

describe('M5 contract, config and deal', () => {
  it('is a live private-card round on the since-round-open window, never mixed, taking no submissions', () => {
    expect(module.kind).toBe('private-card');
    expect(module.supportsLiveEvents).toBe(true);
    expect(module.liveEventWindow).toBe('since-round-open');
    expect(module.dataRequirements).toEqual(['hasLiveEvents']);
    expect(isMixable(module, 'matchday')).toBe(false);
    const harness = makeHarness({ data: sampleData({ fixture: LIVE_FIXTURE }) });
    const room = start(harness);
    const submit = reduceRoom(
      room,
      { type: 'SUBMIT_ANSWER', playerId: HOST, roundId: currentRound(room)?.id ?? ('' as never), payload: {} },
      harness.deps,
    );
    expect(submit.rejection).toMatchObject({ code: 'INVALID_SUBMISSION', submissionCode: 'NOT_ALLOWED' });
    expect(currentRound(room)?.deadlineAt).toBeNull();
  });

  it('validates config: distinct kinds, window bounds, drinker toggle', () => {
    expect(module.parseConfig(M5_DEFAULT_CONFIG).ok).toBe(true);
    expect(module.parseConfig({ ...M5_DEFAULT_CONFIG, eventKinds: ['CORNER', 'CORNER'] }).ok).toBe(false);
    expect(module.parseConfig({ ...M5_DEFAULT_CONFIG, eventKinds: ['THROW_IN'] }).ok).toBe(false);
    expect(module.parseConfig({ ...M5_DEFAULT_CONFIG, eventKinds: [] }).ok).toBe(false);
    expect(module.parseConfig({ ...M5_DEFAULT_CONFIG, windowMinutes: 2 }).ok).toBe(false);
    expect(module.parseConfig({ ...M5_DEFAULT_CONFIG, drinker: 'host' }).ok).toBe(false);
    expect(M5_DEFAULT_EVENT_KINDS).not.toContain('GOAL');
  });

  it('deals distinct kinds while they last, then a fresh shuffled lap; deterministic per RNG state', () => {
    const ids = Array.from({ length: 9 }, (_, index) => asPlayerId(`p${index}`));
    const deal = dealEventKinds(ids, M5_DEFAULT_EVENT_KINDS, createSeededRng(3).shuffle);
    expect(deal.map((entry) => entry.playerId)).toEqual(ids);
    expect(new Set(deal.slice(0, 7).map((entry) => entry.event)).size).toBe(7);
    expect(new Set(deal.slice(7).map((entry) => entry.event)).size).toBe(2);
    expect(dealEventKinds(ids, M5_DEFAULT_EVENT_KINDS, createSeededRng(3).shuffle)).toEqual(deal);
    const deals = new Set(
      Array.from({ length: 30 }, (_, seed) => JSON.stringify(dealEventKinds(ids.slice(0, 3), M5_DEFAULT_EVENT_KINDS, createSeededRng(seed).shuffle))),
    );
    expect(deals.size).toBeGreaterThan(10);
  });

  it('deals every player present, from the configured kinds only', () => {
    const round = mustGenerate(module, { players: [HOST, P2, P3], config: { ...M5_DEFAULT_CONFIG, eventKinds: ['GOAL', 'CARD'] } });
    const deal = (round.publicPayload as M5PublicPayload).deal;
    expect(deal.map((entry) => entry.playerId)).toEqual([HOST, P2, P3]);
    for (const entry of deal) expect(['GOAL', 'CARD']).toContain(entry.event);
    expect(round.answerWindowMs).toBeNull();
    expect(round.solution).toEqual({ status: 'running', endedBy: null });
  });

  it('refuses without a fixture or once it is over, and keys every round apart', () => {
    expect(generateWith(module, { data: sampleData({ fixture: null }) })).toMatchObject({ ok: false, reason: 'INSUFFICIENT_DATA' });
    expect(generateWith(module, { data: sampleData({ fixture: { ...FIXTURE, status: 'FINISHED' } }) })).toMatchObject({
      ok: false,
      reason: 'WRONG_ROUND_CONTEXT',
    });
    const first = mustGenerate(module);
    expect(mustGenerate(module, { usedContentKeys: [first.contentKey] }).contentKey).not.toBe(first.contentKey);
  });
});

describe('the live-event kinds', () => {
  it('fold provider types into what a player sees, and credit own goals to the opponent', () => {
    expect(liveEventKindOf(ev('s', 'SAVE', 1))).toBe('SHOT_ON_TARGET');
    expect(liveEventKindOf(ev('r', 'RED_CARD', 1))).toBe('CARD');
    expect(liveEventKindOf(ev('y2', 'SECOND_YELLOW', 1))).toBe('CARD');
    expect(liveEventKindOf(ev('p', 'PENALTY_SCORED', 1))).toBe('GOAL');
    for (const type of ['THROW_IN', 'GOAL_KICK', 'KICK_OFF', 'HALF_TIME', 'VAR_CHECK', 'PENALTY_MISSED'] as const) {
      expect(liveEventKindOf(ev('x', type, 1))).toBeNull();
    }
    expect(liveEventSideOf(ev('og', 'OWN_GOAL', 1), HOME_TEAM_ID, AWAY_TEAM_ID)).toBe('away');
    expect(liveEventSideOf(ev('c', 'CORNER', 1, null, AWAY_TEAM_ID), HOME_TEAM_ID, AWAY_TEAM_ID)).toBe('away');
    expect(liveEventSideOf(ev('c', 'CORNER', 1, null, null), HOME_TEAM_ID, AWAY_TEAM_ID)).toBeNull();
  });
});

/* ---------------------------------- spins ---------------------------------- */

describe('M5 spins', () => {
  it('starts at the minute the round opened and ends windowMinutes later', () => {
    const { harness, room } = dealtAt30('CORNER');
    expect(payloadOf(room)).toMatchObject({ startMinute: 30, endMinute: 40, clockKnown: true, fires: [] });
    // The 10' corner was history: nobody drank for it.
    expect(roundPenalties(room)).toEqual([]);
    expect(projectFor(room, P2, harness.deps).round?.publicPayload).toMatchObject({ endMinute: 40 });
  });

  it('owner mode: your event fires, you drink, at once', () => {
    const { harness, room } = dealtAt30('CORNER');
    const next = feed(room, harness.deps, [...HISTORY, ev('c33', 'CORNER', 33, null, AWAY_TEAM_ID), ev('x', 'THROW_IN', 34)]).state;
    expect(next.phase).toBe('playing');
    expect(roundPenalties(next).map((entry) => [entry.recipientId, entry.target, entry.reason, entry.appliedSips, entry.meta])).toEqual([
      [HOST, 'self', 'ASSIGNED_EVENT_FIRED', 1, { kind: 'CORNER', eventId: 'c33', minute: 33 }],
    ]);
    expect(payloadOf(next).fires).toEqual([
      { eventId: 'c33', kind: 'CORNER', side: 'away', minute: 33, extraMinute: null, playerName: null, ownerIds: [HOST] },
    ]);
    // A re-poll never charges twice.
    expect(feed(next, harness.deps, [...HISTORY, ev('c33', 'CORNER', 33, null, AWAY_TEAM_ID)]).state).toBe(next);
  });

  it('others mode: everyone but the owner drinks', () => {
    const { harness, room } = dealtAt30('FOUL', { drinker: 'others', sipsPerFire: 2 });
    const next = feed(room, harness.deps, [...HISTORY, ev('f31', 'FOUL', 31)]).state;
    const charged = roundPenalties(next);
    expect(charged.map((entry) => entry.recipientId).sort()).toEqual([P2, P3].sort());
    expect(charged.every((entry) => entry.target === 'others' && entry.appliedSips === 2 && entry.playerId === HOST)).toBe(true);
  });

  it('counts saves as shots on target, and ignores kinds nobody holds', () => {
    const { harness, room } = dealtAt30('SHOT_ON_TARGET', { eventKinds: ['SHOT_ON_TARGET', 'CORNER', 'FOUL'] });
    const next = feed(room, harness.deps, [...HISTORY, ev('sv', 'SAVE', 31), ev('sub', 'SUBSTITUTION', 32)]).state;
    expect(payloadOf(next).fires.map((fire) => fire.eventId)).toEqual(['sv']);
  });

  it('ends at the first event at or past the end minute, which does not count', () => {
    const { harness, room } = dealtAt30('CORNER');
    const ended = feed(room, harness.deps, [...HISTORY, ev('c39', 'CORNER', 39), ev('c40', 'CORNER', 40), ev('c41', 'CORNER', 41)]).state;
    expect(ended.phase).toBe('roundReveal');
    expect(solutionOf(ended)).toEqual({ status: 'ended', endedBy: 'WINDOW_END' });
    expect(payloadOf(ended).fires.map((fire) => fire.eventId)).toEqual(['c39']);
  });

  it('spans half-time on scoreboard minutes: 45+3 and 46-49 count, 50 ends a spin opened at 40', () => {
    const harness = makeHarness({ data: sampleData({ fixture: LIVE_FIXTURE }) });
    let room = start(harness, { config: { ...M5_DEFAULT_CONFIG, eventKinds: ['CORNER'] }, players: [P2] });
    const history = [ev('ko', 'KICK_OFF', 0, null, null), ev('f40', 'FOUL', 40)];
    room = feed(room, harness.deps, history).state;
    expect(payloadOf(room).endMinute).toBe(50);
    room = feed(room, harness.deps, [
      ...history,
      ev('c45', 'CORNER', 45, 3),
      ev('ht', 'HALF_TIME', 45, 4, null),
      ev('c48', 'CORNER', 48),
      ev('c50', 'CORNER', 50),
    ]).state;
    expect(payloadOf(room).fires.map((fire) => fire.eventId)).toEqual(['c45', 'c48']);
    expect(solutionOf(room).endedBy).toBe('WINDOW_END');
  });

  it('ends at the regulation whistle, ignoring anything listed after it', () => {
    const { harness, room } = dealtAt30('CORNER', { windowMinutes: 45 });
    const ended = feed(room, harness.deps, [...HISTORY, ev('ft', 'FULL_TIME', 90, 3, null), ev('et', 'CORNER', 95)]).state;
    expect(solutionOf(ended)).toEqual({ status: 'ended', endedBy: 'FULL_TIME' });
    expect(payloadOf(ended).fires).toEqual([]);
  });

  it('is void, charging nothing, when it opens after full time', () => {
    const harness = makeHarness({ data: sampleData({ fixture: LIVE_FIXTURE }) });
    const room = feed(start(harness), harness.deps, [...HISTORY, ev('ft', 'FULL_TIME', 90, 3, null)]).state;
    expect(room.phase).toBe('roundReveal');
    expect(solutionOf(room)).toEqual({ status: 'void', endedBy: 'MATCH_OVER' });
    expect(roundPenalties(room)).toEqual([]);
    expect(currentRound(room)?.outcome?.winnerIds).toEqual([]);
  });

  it('a spin opened before kickoff starts at minute 0 and takes the first poll live', () => {
    const harness = makeHarness({ data: sampleData({ fixture: UPCOMING_FIXTURE }) });
    const room = start(harness, { config: { ...M5_DEFAULT_CONFIG, eventKinds: ['CORNER'] } });
    expect(projectFor(room, HOST, harness.deps).round?.publicPayload).toMatchObject({ startMinute: 0, endMinute: 10, clockKnown: true });
    const next = feed(room, harness.deps, [ev('ko', 'KICK_OFF', 0, null, null), ev('c2', 'CORNER', 2)]).state;
    // Every player holds CORNER (one kind, three players): each owner fires.
    expect(payloadOf(next).fires[0]?.ownerIds).toEqual([HOST, P2, P3]);
    expect(roundPenalties(next)).toHaveLength(3);
    expect(payloadOf(next).startMinute).toBe(0);
  });
});

describe('M5 fairness and caps', () => {
  it('a late joiner is not dealt; a departed owner no longer drinks', () => {
    const { harness, room } = dealtAt30('CORNER');
    let state = reduceRoom(room, { type: 'PLAYER_JOIN', playerId: P4, nickname: 'Late', isGuest: true }, harness.deps).state;
    expect(payloadOf(state).deal.some((entry) => entry.playerId === P4)).toBe(false);
    state = reduceRoom(state, { type: 'PLAYER_LEAVE', playerId: HOST }, harness.deps).state;
    state = feed(state, harness.deps, [...HISTORY, ev('c31', 'CORNER', 31)]).state;
    expect(payloadOf(state).fires).toHaveLength(1);
    expect(roundPenalties(state)).toEqual([]);
  });

  it('the room caps bound a foul-fest', () => {
    const { harness, room } = dealtAt30('FOUL', { sipsPerFire: 5 });
    const fouls = Array.from({ length: 5 }, (_, index) => ev(`f${index}`, 'FOUL', 31 + index));
    const capped = { ...room, settings: mergeRoomSettings(room.settings, { penaltyCaps: { perPenalty: 10, perRound: 8, perSession: 60 } }) };
    const next = feed(capped, harness.deps, [...HISTORY, ...fouls]).state;
    const host = roundPenalties(next).filter((entry) => entry.recipientId === HOST);
    expect(host.map((entry) => entry.appliedSips)).toEqual([5, 3, 0, 0, 0]);
    expect(next.players.find((player) => player.id === HOST)?.sips).toBe(8);
  });

  it('no points; winners are the quietest events (owner mode) or the loudest (others mode)', () => {
    const owner = dealtAt30('CORNER');
    const revealed = reduceRoom(
      feed(owner.room, owner.harness.deps, [...HISTORY, ev('c31', 'CORNER', 31)]).state,
      { type: 'REVEAL_ROUND', actorId: HOST },
      owner.harness.deps,
    ).state;
    expect(currentRound(revealed)?.outcome?.scores).toEqual([]);
    expect(currentRound(revealed)?.outcome?.winnerIds).toEqual([P2, P3]);
    expect(currentRound(revealed)?.outcome?.summary).toMatchObject({ status: 'ended', endedBy: 'HOST', totalFires: 1 });

    const others = dealtAt30('CORNER', { drinker: 'others' });
    const loud = reduceRoom(
      feed(others.room, others.harness.deps, [...HISTORY, ev('c31', 'CORNER', 31)]).state,
      { type: 'REVEAL_ROUND', actorId: HOST },
      others.harness.deps,
    ).state;
    expect(currentRound(loud)?.outcome?.winnerIds).toEqual([HOST]);
    expect(loud.players.every((player) => player.score === 0)).toBe(true);
  });

  it('replays byte-for-byte', () => {
    const play = () => {
      const { harness, room } = dealtAt30('FOUL');
      return feed(feed(room, harness.deps, [...HISTORY, ev('f31', 'FOUL', 31)]).state, harness.deps, [
        ...HISTORY,
        ev('f31', 'FOUL', 31),
        ev('c41', 'CORNER', 41),
      ]).state;
    };
    expect(JSON.stringify(play())).toBe(JSON.stringify(play()));
  });
});

/* ------------------------- recorded match: PSG 6-1 Slovan ------------------------- */

describe('M5 against the recorded PSG 6-1 Slovan Bratislava timeline (401915445)', () => {
  const through = (id: string): readonly MatchEvent[] => PSG_SLOVAN_EVENTS.slice(0, PSG_SLOVAN_EVENTS.findIndex((event) => event.id === id) + 1);
  const upcoming = { ...PSG_SLOVAN_FIXTURE, status: 'SCHEDULED' as const, kickoff: new Date(T0 + 60_000).toISOString() };
  const live = { ...PSG_SLOVAN_FIXTURE, status: 'LIVE' as const, kickoff: new Date(T0 - 60_000).toISOString() };
  const everyKind = { ...M5_DEFAULT_CONFIG, eventKinds: ['CORNER', 'FOUL', 'SHOT_ON_TARGET', 'SHOT_OFF_TARGET', 'SUBSTITUTION', 'OFFSIDE', 'GOAL', 'CARD'] };
  /** Eight players, so each of the eight kinds has exactly one owner. */
  const EIGHT = Array.from({ length: 7 }, (_, index) => asPlayerId(`q${index + 1}`));
  const firesByKind = (room: RoomState): Readonly<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const fire of payloadOf(room).fires) out[fire.kind] = (out[fire.kind] ?? 0) + 1;
    return out;
  };
  /** Feed the recording poll by poll (every event one poll), from `from` on, until the round ends. */
  const play = (room: RoomState, deps: EngineDeps, fromIndex: number): RoomState => {
    let state = room;
    for (let index = fromIndex; index < PSG_SLOVAN_EVENTS.length && state.phase === 'playing'; index += 1) {
      state = feed(state, deps, PSG_SLOVAN_EVENTS.slice(0, index + 1)).state;
    }
    return state;
  };

  it('a pre-kickoff 10-minute spin fires on exactly the plays of minutes 0-9 and ends on the 12th-minute foul', () => {
    const harness = makeHarness({ data: sampleData({ fixture: upcoming, lineups: null }) });
    const room = start(harness, { config: everyKind, players: EIGHT });
    const ended = play(room, harness.deps, 0);
    expect(solutionOf(ended)).toEqual({ status: 'ended', endedBy: 'WINDOW_END' });
    expect(new Set(payloadOf(ended).deal.map((entry) => entry.event)).size).toBe(8);
    expect(firesByKind(ended)).toEqual({ SHOT_OFF_TARGET: 3, SHOT_ON_TARGET: 1, CORNER: 1, FOUL: 2 });
    // Owner mode, 1 sip each: exactly one charge per fire of a dealt kind, to its owner.
    const charged = ended.penalties.filter((entry) => entry.reason === 'ASSIGNED_EVENT_FIRED');
    expect(charged).toHaveLength(7);
    for (const entry of charged) expect(ownerOf(ended, entry.meta?.['kind'] as LiveEventKind)).toBe(entry.recipientId);
  });

  it('a spin opened on the 54\u2032 feed runs 54-63, never re-firing its baseline, and ends at the first 64\u2032 play', () => {
    const harness = makeHarness({ data: sampleData({ fixture: live, lineups: null }) });
    let room = start(harness, { config: everyKind, players: EIGHT });
    const lastBefore55 = [...PSG_SLOVAN_EVENTS].reverse().find((event) => event.minute < 55);
    room = feed(room, harness.deps, through(lastBefore55?.id ?? '')).state;
    expect(payloadOf(room).startMinute).toBe(lastBefore55?.minute);
    const ended = play(room, harness.deps, PSG_SLOVAN_EVENTS.findIndex((event) => event.minute >= 55));
    expect(solutionOf(ended).endedBy).toBe('WINDOW_END');
    // After the baseline (the 54' shot is history): 55' offside, 56' corner, 57'/58' goals (Slovan's
    // credited away), 58'/61'/62' shots off, the two 60' Slovan subs; the 64' subs end it.
    expect(firesByKind(ended)).toEqual({ OFFSIDE: 1, CORNER: 1, GOAL: 2, SHOT_OFF_TARGET: 3, SUBSTITUTION: 2 });
    expect(payloadOf(ended).fires.every((fire) => fire.minute >= 55 && fire.minute < 64)).toBe(true);
    expect(payloadOf(ended).fires.filter((fire) => fire.kind === 'GOAL').map((fire) => fire.side)).toEqual(['home', 'away']);
  });
});

describe('M5 label overrides', () => {
  it('validates labels: known kinds only, trimmed, 1..40 chars, optional', () => {
    expect(module.parseConfig(M5_DEFAULT_CONFIG)).toEqual({ ok: true, config: M5_DEFAULT_CONFIG });
    const parsed = module.parseConfig({ ...M5_DEFAULT_CONFIG, labels: { CORNER: '  Flag kick ', FOUL: 'Hack' } });
    expect(parsed).toEqual({ ok: true, config: { ...M5_DEFAULT_CONFIG, labels: { CORNER: 'Flag kick', FOUL: 'Hack' } } });
    const issues = (labels: unknown): string => {
      const result = module.parseConfig({ ...M5_DEFAULT_CONFIG, labels });
      return result.ok ? '' : result.issues.join('; ');
    };
    expect(issues({ THROW_IN: 'x' })).toContain('labels.THROW_IN');
    expect(issues({ CORNER: '   ' })).toContain('labels.CORNER');
    expect(issues({ CORNER: 'x'.repeat(41) })).toContain('labels.CORNER');
    expect(issues({ CORNER: 3 })).toContain('labels.CORNER');
  });

  it('copies the labels into the public payload ({} by default), visible to every viewer', () => {
    const harness = makeHarness({ data: sampleData({ fixture: LIVE_FIXTURE }) });
    expect(payloadOf(start(harness)).labels).toEqual({});
    const room = start(harness, { config: { ...M5_DEFAULT_CONFIG, labels: { CARD: 'Booking!' } } });
    expect(payloadOf(room).labels).toEqual({ CARD: 'Booking!' });
    for (const viewer of [HOST, P2, null]) {
      const view = projectFor(room, viewer, harness.deps).round;
      expect((view?.publicPayload as M5PublicPayload).labels).toEqual({ CARD: 'Booking!' });
      expect(view?.solution ?? null).toBeNull();
    }
  });
});
