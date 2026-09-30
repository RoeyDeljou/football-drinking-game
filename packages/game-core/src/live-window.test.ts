import type { Fixture, MatchEvent } from '@fdg/football-data';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RoomAction } from './actions.js';
import type { Harness } from './harness.test-utils.js';
import {
  AWAY_TEAM_ID,
  FIXTURE,
  HOME_TEAM_ID,
  HOST,
  makeHarness,
  matchEvent,
  newRoom,
  P2,
  sampleData,
  T0,
} from './harness.test-utils.js';
import { asGameModuleId } from './ids.js';
import type { LiveEventWindow } from './live-window.js';
import { initialLiveWindow, stepLiveWindow } from './live-window.js';
import { compareMatchClock, goalCreditedSide, latestClockOf } from './match-events.js';
import { defineGameModule } from './module.js';
import { createModuleRegistry } from './modules/registry.js';
import { m1MatchMarkets } from './modules/m1-match-markets.js';
import type { EngineDeps } from './reducer.js';
import { reduceAll, reduceRoom } from './reducer.js';
import type { RoomState } from './state.js';
import { currentRound } from './state.js';

/* --------------------------------- fixtures -------------------------------- */

/** Kicked off an hour before T0 and live: rounds open mid-match. */
const LIVE_FIXTURE: Fixture = { ...FIXTURE, status: 'LIVE', kickoff: new Date(T0 - 3_600_000).toISOString() };
/** Kicks off an hour after T0: rounds open pre-kickoff. */
const UPCOMING_FIXTURE: Fixture = { ...FIXTURE, status: 'SCHEDULED', kickoff: new Date(T0 + 3_600_000).toISOString() };

const ev = (id: string, type: MatchEvent['type'], minute: number, extraMinute: number | null = null): MatchEvent =>
  matchEvent(type, { id, minute, extraMinute, teamId: type === 'GOAL' ? HOME_TEAM_ID : null });

/**
 * A probe live module (since-round-open by default): it records every event id and history id the
 * engine hands it, so the tests can see exactly what a round reacts to. A GOAL resolves the round.
 */
const PROBE_ID = asGameModuleId('PROBE');
const probePayload = z
  .object({
    seen: z.array(z.string()),
    history: z.array(z.string()),
    calls: z.number().int(),
    windows: z.array(z.string()),
  })
  .strict();
const empty = z.object({}).strict();
const probe = defineGameModule<{
  config: z.infer<typeof empty>;
  publicPayload: z.infer<typeof probePayload>;
  privatePayload: null;
  solution: z.infer<typeof empty>;
  submission: z.infer<typeof empty>;
}>({
  id: PROBE_ID,
  category: 'matchday',
  kind: 'long-running-bet',
  dataRequirements: [],
  minPlayers: 1,
  maxPlayers: null,
  allowResubmission: false,
  defaultConfig: {},
  configSchema: empty,
  publicPayloadSchema: probePayload,
  privatePayloadSchema: z.null(),
  solutionSchema: empty,
  submissionSchema: empty,
  generateRound: (ctx) => ({
    ok: true,
    round: {
      publicPayload: { seen: [], history: [], calls: 0, windows: [] },
      privatePayloads: {},
      solution: {},
      contentKey: `probe-${ctx.roundIndex}`,
      answerWindowMs: null,
      turnOrder: null,
    },
  }),
  validateSubmission: () => ({ ok: true, payload: {} }),
  observeEvents: (ctx) => ({
    publicPayload: {
      seen: [...ctx.round.publicPayload.seen, ...ctx.events.map((event) => event.id)],
      history: [...ctx.round.publicPayload.history, ...ctx.history.map((event) => event.id)],
      calls: ctx.round.publicPayload.calls + 1,
      windows: [...ctx.round.publicPayload.windows, JSON.stringify(ctx.round.liveWindow)],
    },
    solution: {},
    privatePayloads: {},
    penalties: [],
    scoreDeltas: [],
    resolved: ctx.events.some((event) => event.type === 'GOAL'),
  }),
  scoreRound: () => ({ scores: [], winnerIds: [], penalties: [], summary: null }),
  projectRound: (ctx) => ({ publicPayload: ctx.round.publicPayload, privatePayload: null, solution: null }),
});

const harnessFor = (fixture: Fixture): Harness =>
  makeHarness({
    data: sampleData({ fixture }),
    modules: createModuleRegistry([probe, m1MatchMarkets]),
  });

const start = (harness: Harness, moduleId = PROBE_ID, rounds = 3): RoomState => {
  const result = reduceAll(
    newRoom(),
    [
      { type: 'PLAYER_JOIN', playerId: P2, nickname: 'Bea', isGuest: true },
      { type: 'UPDATE_SETTINGS', actorId: HOST, patch: { roundsPerSession: rounds } },
      { type: 'SELECT_GAME', actorId: HOST, moduleId, config: null },
      { type: 'START_SESSION', actorId: HOST },
    ],
    harness.deps,
  );
  expect(result.rejection).toBeNull();
  return result.state;
};

const feed = (room: RoomState, deps: EngineDeps, events: readonly MatchEvent[]) =>
  reduceRoom(room, { type: 'MATCH_EVENTS', events }, deps);

const probeOf = (room: RoomState): z.infer<typeof probePayload> =>
  probePayload.parse(currentRound(room)?.publicPayload);

const nextRound = (room: RoomState, deps: EngineDeps): RoomState =>
  reduceAll(
    room,
    [
      ...(room.phase === 'playing' ? [{ type: 'REVEAL_ROUND', actorId: HOST } as RoomAction] : []),
      { type: 'ADVANCE', actorId: HOST },
      { type: 'ADVANCE', actorId: HOST },
    ],
    deps,
  ).state;

/* --------------------------------- pure step -------------------------------- */

describe('stepLiveWindow (pure)', () => {
  const baseline = [ev('a', 'KICK_OFF', 0), ev('b', 'CORNER', 12), ev('c', 'GOAL', 30)];

  it('turns the first batch of an un-baselined window into history, clocked at its latest event', () => {
    const step = stepLiveWindow({ baselineSource: null, openedAt: null, latest: null }, baseline, new Set());
    expect(step.kind).toBe('baseline');
    if (step.kind !== 'baseline') return;
    expect(step.history.map((event) => event.id)).toEqual(['a', 'b', 'c']);
    expect(step.window).toEqual({
      baselineSource: 'first-batch',
      openedAt: { minute: 30, extraMinute: null },
      latest: { minute: 30, extraMinute: null },
    });
  });

  it('an empty first batch is a valid pre-kickoff baseline with no clock', () => {
    const step = stepLiveWindow({ baselineSource: null, openedAt: null, latest: null }, [], new Set());
    expect(step).toEqual({
      kind: 'baseline',
      window: { baselineSource: 'first-batch', openedAt: null, latest: null },
      history: [],
    });
  });

  it('after the baseline: drops seen ids, duplicates within the batch, and back-filled history', () => {
    const window: LiveEventWindow = {
      baselineSource: 'first-batch',
      openedAt: { minute: 30, extraMinute: null },
      latest: { minute: 30, extraMinute: null },
    };
    const batch = [
      ...baseline,
      ev('late', 'FOUL', 29), // new id, but earlier than the round: back-filled history
      ev('same-minute', 'CORNER', 30), // the minute the round opened in is still live
      ev('d', 'SHOT_ON_TARGET', 33),
      ev('d', 'SHOT_ON_TARGET', 33), // duplicate inside the batch
    ];
    const step = stepLiveWindow(window, batch, new Set(['a', 'b', 'c']));
    expect(step.kind).toBe('events');
    if (step.kind !== 'events') return;
    expect(step.fresh.map((event) => event.id)).toEqual(['same-minute', 'd']);
    expect(step.window?.latest).toEqual({ minute: 33, extraMinute: null });
    expect(step.window?.openedAt).toEqual({ minute: 30, extraMinute: null });
  });

  it('orders stoppage time correctly across half-time: 45+5 is before 46, 90+4 before 91', () => {
    const window: LiveEventWindow = {
      baselineSource: 'first-batch',
      openedAt: { minute: 45, extraMinute: 2 },
      latest: { minute: 45, extraMinute: 2 },
    };
    const step = stepLiveWindow(
      window,
      [ev('fh', 'FOUL', 45, 1), ev('ht+', 'CORNER', 45, 3), ev('sh', 'CORNER', 46)],
      new Set(),
    );
    if (step.kind !== 'events') throw new Error('expected events');
    expect(step.fresh.map((event) => event.id)).toEqual(['ht+', 'sh']);
    expect(compareMatchClock({ minute: 90, extraMinute: 4 }, { minute: 91, extraMinute: null })).toBeLessThan(0);
    expect(latestClockOf([ev('x', 'FOUL', 45, 5), ev('y', 'FOUL', 46)])).toEqual({ minute: 46, extraMinute: null });
  });

  it('never floors a FULL_TIME: a whistle outside the baseline blew after the round opened', () => {
    const window: LiveEventWindow = {
      baselineSource: 'first-batch',
      openedAt: { minute: 90, extraMinute: 3 },
      latest: { minute: 90, extraMinute: 3 },
    };
    const step = stepLiveWindow(window, [ev('ft', 'FULL_TIME', 90)], new Set());
    if (step.kind !== 'events') throw new Error('expected events');
    expect(step.fresh.map((event) => event.id)).toEqual(['ft']);
  });

  it('is plain id dedupe for whole-match rounds (window null)', () => {
    const step = stepLiveWindow(null, [...baseline, ev('a', 'KICK_OFF', 0)], new Set(['b']));
    expect(step).toEqual({ kind: 'events', window: null, fresh: [baseline[0], baseline[2]] });
  });
});

describe('initialLiveWindow', () => {
  it('is null for whole-match modules', () => {
    expect(initialLiveWindow('whole-match', LIVE_FIXTURE, T0)).toBeNull();
  });

  it('baselines at build time only when the fixture is still scheduled and its kickoff is in the future', () => {
    expect(initialLiveWindow('since-round-open', UPCOMING_FIXTURE, T0)?.baselineSource).toBe('pre-kickoff');
    // Kickoff time passed (a stale SCHEDULED status is not trusted) …
    expect(initialLiveWindow('since-round-open', { ...UPCOMING_FIXTURE, kickoff: LIVE_FIXTURE.kickoff }, T0)?.baselineSource).toBeNull();
    // … already live …
    expect(initialLiveWindow('since-round-open', { ...UPCOMING_FIXTURE, status: 'LIVE' }, T0)?.baselineSource).toBeNull();
    // … unparsable kickoff, or no fixture at all: wait for the first batch.
    expect(initialLiveWindow('since-round-open', { ...UPCOMING_FIXTURE, kickoff: 'soon' }, T0)?.baselineSource).toBeNull();
    expect(initialLiveWindow('since-round-open', null, T0)?.baselineSource).toBeNull();
  });
});

/* ------------------------------ through the reducer ------------------------------ */

describe('MATCH_EVENTS with a since-round-open module', () => {
  const firstHalf = [ev('ko', 'KICK_OFF', 0), ev('c1', 'CORNER', 8), ev('g1', 'GOAL', 17), ev('f1', 'FOUL', 20)];

  it('a round opened mid-match takes the first batch as history and never reacts to it', () => {
    const { deps } = harnessFor(LIVE_FIXTURE);
    const room = start(harnessFor(LIVE_FIXTURE));
    expect(currentRound(room)?.liveWindow).toEqual({ baselineSource: null, openedAt: null, latest: null });

    const baselined = feed(room, deps, firstHalf);
    expect(baselined.rejection).toBeNull();
    expect(baselined.events).toEqual([{ type: 'ROUND_UPDATED', roundId: currentRound(room)?.id }]);
    // Still playing: the 17' goal in the baseline did not resolve the round.
    expect(baselined.state.phase).toBe('playing');
    expect(probeOf(baselined.state)).toMatchObject({ seen: [], history: ['ko', 'c1', 'g1', 'f1'], calls: 1 });
    expect(currentRound(baselined.state)?.observedEventIds).toEqual(['ko', 'c1', 'g1', 'f1']);
    expect(currentRound(baselined.state)?.liveWindow).toEqual({
      baselineSource: 'first-batch',
      openedAt: { minute: 20, extraMinute: null },
      latest: { minute: 20, extraMinute: null },
    });

    // The next poll re-sends everything plus one new play: only the new play reaches the module.
    const next = feed(baselined.state, deps, [...firstHalf, ev('s1', 'SHOT_ON_TARGET', 22)]);
    expect(probeOf(next.state)).toMatchObject({ seen: ['s1'], history: ['ko', 'c1', 'g1', 'f1'], calls: 2 });
    // The module saw the updated window (this batch folded into `latest`).
    expect(JSON.parse(probeOf(next.state).windows[1] ?? 'null')).toMatchObject({ latest: { minute: 22 } });

    // An identical re-poll is a no-op: same state object, nothing to broadcast.
    const again = feed(next.state, deps, [...firstHalf, ev('s1', 'SHOT_ON_TARGET', 22)]);
    expect(again.state).toBe(next.state);
    expect(again.rejection).toBeNull();
  });

  it('a new round of the same session ignores every event from before it opened (the known gap)', () => {
    const harness = harnessFor(LIVE_FIXTURE);
    let room = start(harness);
    room = feed(room, harness.deps, firstHalf).state;
    // Round 1 resolves on a live goal.
    const upTo30 = [...firstHalf, ev('g2', 'GOAL', 30)];
    room = feed(room, harness.deps, upTo30).state;
    expect(room.phase).toBe('roundReveal');

    // Round 2 opens; meanwhile a corner happened during the reveal/intermission.
    room = nextRound(room, harness.deps);
    expect(room.phase).toBe('playing');
    expect(currentRound(room)?.index).toBe(1);
    const upTo34 = [...upTo30, ev('c2', 'CORNER', 34)];
    const baselined = feed(room, harness.deps, upTo34).state;
    // Neither goal (17', 30') nor the intermission corner is a live event for round 2.
    expect(baselined.phase).toBe('playing');
    expect(probeOf(baselined)).toMatchObject({ seen: [], history: ['ko', 'c1', 'g1', 'f1', 'g2', 'c2'] });

    const later = feed(baselined, harness.deps, [...upTo34, ev('g3', 'GOAL', 41)]).state;
    expect(later.phase).toBe('roundReveal');
    expect(probeOf(later).seen).toEqual(['g3']);
  });

  it('drops a back-filled play (new id, earlier minute) without recording it, deterministically', () => {
    const { deps } = harnessFor(LIVE_FIXTURE);
    const baselined = feed(start(harnessFor(LIVE_FIXTURE)), deps, firstHalf).state;
    const backfilled = [...firstHalf, ev('late-goal', 'GOAL', 19)];
    const result = feed(baselined, deps, backfilled);
    expect(result.state).toBe(baselined);
    expect(currentRound(result.state)?.observedEventIds).not.toContain('late-goal');
    // Every later poll re-filters it identically.
    expect(feed(result.state, deps, backfilled).state).toBe(baselined);
  });

  it('a round built before kickoff starts baselined: the very first batch is live', () => {
    const harness = harnessFor(UPCOMING_FIXTURE);
    const room = start(harness);
    expect(currentRound(room)?.liveWindow).toEqual({ baselineSource: 'pre-kickoff', openedAt: null, latest: null });
    const first = feed(room, harness.deps, [ev('ko', 'KICK_OFF', 0), ev('c1', 'CORNER', 1)]).state;
    expect(probeOf(first)).toMatchObject({ seen: ['ko', 'c1'], history: [], calls: 1 });
    // …so a goal in the first poll after kickoff counts.
    const goal = feed(first, harness.deps, [ev('ko', 'KICK_OFF', 0), ev('g', 'GOAL', 1)]).state;
    expect(goal.phase).toBe('roundReveal');
  });

  it('an empty first batch baselines the round (and commits), so the next batch is live', () => {
    const { deps } = harnessFor(LIVE_FIXTURE);
    const room = start(harnessFor(LIVE_FIXTURE));
    const empty = feed(room, deps, []);
    expect(empty.state).not.toBe(room);
    expect(currentRound(empty.state)?.liveWindow?.baselineSource).toBe('first-batch');
    const live = feed(empty.state, deps, [ev('ko', 'KICK_OFF', 0), ev('g', 'GOAL', 3)]).state;
    expect(live.phase).toBe('roundReveal');
    expect(probeOf(live).seen).toEqual(['ko', 'g']);
  });

  it('a module can resolve on its baseline call (e.g. the match is already over)', () => {
    const { deps } = harnessFor(LIVE_FIXTURE);
    const room = start(harnessFor(LIVE_FIXTURE));
    // The probe resolves only on a live GOAL, so it stays open: history alone never settles it.
    const baselined = feed(room, deps, [...firstHalf, ev('ft', 'FULL_TIME', 90, 4)]).state;
    expect(baselined.phase).toBe('playing');
    expect(probeOf(baselined).history).toContain('ft');
  });
});

describe('MATCH_EVENTS with a whole-match module (M1) is unchanged', () => {
  it('M1 declares whole-match, has no window, and folds a mid-match first batch in full', () => {
    expect(m1MatchMarkets.liveEventWindow).toBe('whole-match');
    const harness = harnessFor(LIVE_FIXTURE);
    const room = start(harness, m1MatchMarkets.id, 1);
    expect(currentRound(room)?.liveWindow).toBeNull();
    const result = feed(room, harness.deps, [
      ev('ko', 'KICK_OFF', 0),
      matchEvent('GOAL', { id: 'g1', minute: 17, teamId: HOME_TEAM_ID }),
      matchEvent('OWN_GOAL', { id: 'og', minute: 20, teamId: HOME_TEAM_ID }),
    ]).state;
    const counters = (currentRound(result)?.publicPayload as { counters: { homeGoals: number; awayGoals: number } })
      .counters;
    // The goals before the batch arrived all count; the home player's own goal counts for away.
    expect([counters.homeGoals, counters.awayGoals]).toEqual([1, 1]);
    expect(currentRound(result)?.observedEventIds).toEqual(['ko', 'g1', 'og']);
  });
});

describe('rounds stored before live windows existed', () => {
  it('a round with no liveWindow field keeps plain id dedupe instead of crashing', () => {
    const harness = harnessFor(LIVE_FIXTURE);
    const room = start(harness);
    const legacy = JSON.parse(JSON.stringify(room)) as RoomState;
    const session = legacy.sessions[0];
    const round = session?.rounds[0];
    if (session === undefined || round === undefined) throw new Error('no round');
    const { liveWindow: _dropped, ...withoutWindow } = round;
    const stored = { ...legacy, sessions: [{ ...session, rounds: [withoutWindow as typeof round] }] };
    const result = feed(stored, harness.deps, [ev('g', 'GOAL', 10)]);
    expect(result.rejection).toBeNull();
    expect(result.state.phase).toBe('roundReveal');
  });
});

describe('goal attribution convention', () => {
  it('credits GOAL/PENALTY_SCORED to teamId and OWN_GOAL to the opponent of teamId', () => {
    const credit = (type: MatchEvent['type'], teamId: typeof HOME_TEAM_ID) =>
      goalCreditedSide(matchEvent(type, { teamId }), HOME_TEAM_ID, AWAY_TEAM_ID);
    expect(credit('GOAL', HOME_TEAM_ID)).toBe('home');
    expect(credit('PENALTY_SCORED', AWAY_TEAM_ID)).toBe('away');
    expect(credit('OWN_GOAL', HOME_TEAM_ID)).toBe('away');
    expect(credit('OWN_GOAL', AWAY_TEAM_ID)).toBe('home');
    expect(credit('PENALTY_MISSED', HOME_TEAM_ID)).toBeNull();
    expect(goalCreditedSide(matchEvent('GOAL', { teamId: null }), HOME_TEAM_ID, AWAY_TEAM_ID)).toBeNull();
  });
});
