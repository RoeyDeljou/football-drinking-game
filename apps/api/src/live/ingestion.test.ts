import type { FixtureId, MatchEvent } from '@fdg/football-data';
import { asFixtureId } from '@fdg/football-data';
import type { RoomId } from '@fdg/game-core';
import { describe, expect, it } from 'vitest';
import type { DispatchOutcome } from '../engine/dispatch.js';
import type { RoomRecord } from '../rooms/store.js';
import type { LiveScheduler } from './ingestion.js';
import { createLiveIngestion } from './ingestion.js';

/* A deterministic scheduler: timers only fire when the test advances time. */
const createFakeScheduler = () => {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const scheduler: LiveScheduler = {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    await flush();
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
      await flush();
    }
    now = target;
  };
  return { scheduler, advance, flush, pending: () => timers.size };
};

const FIXTURE = asFixtureId('fx1');
const event = (id: string, type: MatchEvent['type'] = 'GOAL', fixtureId: FixtureId = FIXTURE): MatchEvent => ({
  id,
  fixtureId,
  type,
  minute: 10,
  extraMinute: null,
  teamId: null,
  playerId: null,
  playerName: null,
  relatedPlayerId: null,
  detail: null,
});

type Status = 'SCHEDULED' | 'LIVE' | 'FINISHED' | 'POSTPONED' | 'CANCELLED';

const playerLine = (goals: number) => ({
  playerId: 'p1', teamId: 't1', minutesPlayed: 90, goals, assists: 0, shots: 1, shotsOnTarget: 1, passes: null,
  passAccuracy: null, tackles: null, duelsWon: null, foulsCommitted: 0, rating: null,
});

const rec = (roomId: string): RoomRecord => ({ state: { id: roomId }, meta: {} }) as unknown as RoomRecord;

const setup = (initialNeeds: Record<string, readonly string[]> = {}, opts: { reap?: boolean; nowMs?: number } = {}) => {
  const clock = createFakeScheduler();
  const feed = { stamp: 0, goals: 0, kickoff: 'not-a-date', status: 'LIVE' as Status, events: [] as MatchEvent[], fail: 0, polls: 0, throwNext: false, nullNext: false };
  const needs: Record<string, readonly string[]> = { ...initialNeeds };
  const delivered: Array<{ roomId: string; events: readonly MatchEvent[] }> = [];
  const changed: string[] = [];
  let nowMs = opts.nowMs ?? 0;
  const statsRooms = new Set<string>();
  const statsDelivered: Array<{ roomId: string; asOf: string; goals: number; afterEventBatches: number }> = [];
  const eventsToo = new Set<string>();
  const goneRooms = new Set<string>();
  const missingRooms = new Set<string>();
  const rejectWith: { code: string | null } = { code: null };

  const service = createLiveIngestion({
    provider: {
      getLiveMatchState: async (id) => {
        feed.polls += 1;
        if (feed.throwNext) throw new Error('boom');
        if (feed.fail > 0) {
          feed.fail -= 1;
          return { ok: false, error: { kind: 'UPSTREAM', message: 'down', retryable: true }, notes: [] } as never;
        }
        if (feed.nullNext) return { ok: true, value: null, notes: [], fromCache: false };
        return {
          ok: true,
          notes: [],
          fromCache: false,
          value: {
            fixture: { id, status: feed.status, kickoff: feed.kickoff },
            events: feed.events.map((e) => ({ ...e, fixtureId: id })),
            teamStats: [],
            playerStats: [playerLine(feed.goals)],
            updatedAt: new Date(1_000_000 + (feed.stamp += 1) * 1000).toISOString(),
          },
        } as never;
      },
    },
    dispatchMatchEvents: async (roomId, events) => {
      delivered.push({ roomId, events });
      if (goneRooms.has(roomId)) return null;
      return {
        rejection: rejectWith.code === null ? null : { code: rejectWith.code, detail: null },
        changed: true,
        record: rec(roomId),
      } as unknown as DispatchOutcome;
    },
    dispatchMatchStats: async (roomId, action) => {
      statsDelivered.push({ roomId, asOf: action.asOf, goals: action.playerStats[0]?.goals ?? -1, afterEventBatches: delivered.length });
      if (goneRooms.has(roomId)) return null;
      return {
        rejection: rejectWith.code === null ? null : { code: rejectWith.code, detail: null },
        changed: true,
        record: rec(roomId),
      } as unknown as DispatchOutcome;
    },
    onRoomChanged: (record) => changed.push(record.state.id),
    plan: (record) =>
      (needs[record.state.id] ?? []).map((fixtureId) => ({
        fixtureId: asFixtureId(fixtureId),
        roundKey: 'r1',
        events: !statsRooms.has(record.state.id) || eventsToo.has(record.state.id),
        stats: statsRooms.has(record.state.id),
      })),
    scheduler: clock.scheduler,
    random: () => 0.5,
    now: () => nowMs,
    ...(opts.reap === true ? { loadRoom: async (id: RoomId) => (missingRooms.has(id) ? null : rec(id)) } : {}),
    log: { warn: () => undefined },
    config: { finishedWithoutFullTimeMaxMs: 20_000, reapIntervalMs: 30_000, kickoffLeadMs: 2000, liveIntervalMs: 1000, preKickoffIntervalMs: 5000, maxBackoffMs: 8000, backoffFactor: 2, jitterRatio: 0.1 },
  });
  const sync = (roomId: string, fixtures: readonly string[]): void => {
    needs[roomId] = fixtures;
    service.roomChanged(rec(roomId));
  };
  return { statsRooms, eventsToo, statsDelivered, clock, feed, delivered, changed, service, rejectWith, goneRooms, missingRooms, sync, setNow: (ms: number) => { nowMs = ms; } };
};

const ROOM_A = 'a' as RoomId;

describe('live ingestion scheduler', () => {
  it('starts polling on first need, immediately, and repeats each interval', async () => {
    const t = setup();
    t.feed.events = [event('e1')];
    t.sync('a', ['fx1']);
    expect(t.feed.polls).toBe(0);
    await t.clock.advance(0);
    expect(t.feed.polls).toBe(1);
    expect(t.delivered).toHaveLength(1);
    expect(t.changed).toEqual(['a']);
    await t.clock.advance(1000);
    expect(t.feed.polls).toBe(2);
    await t.clock.advance(3000);
    expect(t.feed.polls).toBe(5);
    await t.service.close();
  });

  it('shares one poll per fixture across rooms', async () => {
    const t = setup();
    t.feed.events = [event('e1')];
    t.sync('a', ['fx1']);
    t.sync('b', ['fx1']);
    await t.clock.advance(0);
    expect(t.feed.polls).toBe(1);
    expect(t.delivered.map((d) => d.roomId).sort()).toEqual(['a', 'b']);
    await t.clock.advance(1000);
    expect(t.feed.polls).toBe(2);
    expect(t.service.watchedFixtureIds()).toHaveLength(1);
    await t.service.close();
  });

  it('serves a late-joining room from cache and does not add a second poll chain', async () => {
    const t = setup();
    t.feed.events = [event('e1')];
    t.sync('a', ['fx1']);
    await t.clock.advance(0);
    t.sync('b', ['fx1']);
    await t.clock.advance(0);
    expect(t.feed.polls).toBe(1);
    expect(t.delivered.filter((d) => d.roomId === 'b')).toHaveLength(1);
    await t.service.close();
  });

  it('stops when the last room stops needing the fixture', async () => {
    const t = setup();
    t.sync('a', ['fx1']);
    t.sync('b', ['fx1']);
    await t.clock.advance(0);
    t.sync('a', []);
    expect(t.service.watchedFixtureIds()).toHaveLength(1);
    t.sync('b', []);
    expect(t.service.watchedFixtureIds()).toHaveLength(0);
    expect(t.clock.pending()).toBe(0);
    const polls = t.feed.polls;
    await t.clock.advance(60_000);
    expect(t.feed.polls).toBe(polls);
  });

  it('roomRemoved detaches the room', async () => {
    const t = setup();
    t.sync('a', ['fx1']);
    t.service.roomRemoved(ROOM_A);
    expect(t.service.watchedFixtureIds()).toHaveLength(0);
    expect(t.clock.pending()).toBe(0);
  });

  it('detaches a room whose dispatch reports it no longer exists', async () => {
    const t = setup();
    t.goneRooms.add('a');
    t.feed.events = [event('e1')];
    t.sync('a', ['fx1']);
    await t.clock.advance(0);
    expect(t.service.watchedFixtureIds()).toHaveLength(0);
    expect(t.clock.pending()).toBe(0);
  });

  it('never overlaps two in-flight polls of one fixture', async () => {
    const clock = createFakeScheduler();
    let inFlight = 0;
    let maxInFlight = 0;
    let release: () => void = () => undefined;
    const service = createLiveIngestion({
      provider: {
        getLiveMatchState: async (id) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          inFlight -= 1;
          return { ok: true, notes: [], fromCache: false, value: { fixture: { id, status: 'LIVE' }, events: [] } } as never;
        },
      },
      dispatchMatchEvents: async () => null,
      onRoomChanged: () => undefined,
      plan: () => [{ fixtureId: FIXTURE, roundKey: 'r' }],
      scheduler: clock.scheduler,
      log: { warn: () => undefined },
      config: { liveIntervalMs: 1000 },
    });
    service.roomChanged(rec('a'));
    await clock.advance(0);
    // Slow provider: several intervals pass while the first poll is still pending.
    await clock.advance(10_000);
    service.roomChanged(rec('b'));
    service.roomChanged(rec('a'));
    await clock.advance(10_000);
    expect(maxInFlight).toBe(1);
    release();
    await service.close();
  });

  it('backs off exponentially on errors, caps, and recovers to the normal interval', async () => {
    const t = setup();
    t.feed.fail = 4;
    t.sync('a', ['fx1']);
    await t.clock.advance(0); // fail 1 -> next in 1000
    expect(t.feed.polls).toBe(1);
    await t.clock.advance(999);
    expect(t.feed.polls).toBe(1);
    await t.clock.advance(1); // poll 2 fails -> next 2000
    expect(t.feed.polls).toBe(2);
    await t.clock.advance(2000); // poll 3 fails -> 4000
    expect(t.feed.polls).toBe(3);
    await t.clock.advance(4000); // poll 4 fails -> 8000 (cap)
    expect(t.feed.polls).toBe(4);
    await t.clock.advance(7999);
    expect(t.feed.polls).toBe(4);
    await t.clock.advance(1); // poll 5 succeeds
    expect(t.feed.polls).toBe(5);
    await t.clock.advance(1000); // back to normal interval
    expect(t.feed.polls).toBe(6);
    await t.service.close();
  });

  it('survives thrown provider errors and null (unknown fixture) results', async () => {
    const t = setup();
    t.feed.throwNext = true;
    t.sync('a', ['fx1']);
    await t.clock.advance(0);
    t.feed.throwNext = false;
    t.feed.nullNext = true;
    await t.clock.advance(1000);
    t.feed.nullNext = false;
    t.feed.events = [event('e1')];
    await t.clock.advance(2000);
    expect(t.delivered).toHaveLength(1);
    await t.service.close();
  });

  it('tolerates dispatch rejections and drops malformed or foreign events', async () => {
    const t = setup();
    t.rejectWith.code = 'ROUND_CLOSED';
    t.feed.events = [event('e1'), { ...event('bad'), minute: -3 }];
    t.sync('a', ['fx1']);
    await t.clock.advance(0);
    expect(t.delivered[0]?.events.map((e) => e.id)).toEqual(['e1']);
    expect(t.changed).toEqual([]);
    await t.service.close();
  });

  it('re-sends the full, id-stable event list every poll (idempotence is the reducer\'s job)', async () => {
    const t = setup();
    t.feed.events = [event('e1')];
    t.sync('a', ['fx1']);
    await t.clock.advance(0);
    await t.clock.advance(1000);
    expect(t.delivered.map((d) => d.events.map((e) => e.id))).toEqual([['e1'], ['e1']]);
    await t.service.close();
  });

  it('polls a finished-while-watched fixture once more, then stops; stopped watcher is not restarted by room syncs', async () => {
    const t = setup();
    t.feed.events = [event('e1')];
    t.sync('a', ['fx1']);
    await t.clock.advance(0);
    t.feed.status = 'FINISHED';
    t.feed.events = [event('e1'), event('ft', 'FULL_TIME')];
    await t.clock.advance(1000); // sees FINISHED, schedules confirm poll
    expect(t.delivered.at(-1)?.events.map((e) => e.id)).toEqual(['e1', 'ft']);
    await t.clock.advance(1000); // confirm poll
    const polls = t.feed.polls;
    expect(t.clock.pending()).toBe(0);
    for (let i = 0; i < 5; i += 1) t.sync('a', ['fx1']); // ticks keep syncing the room
    await t.clock.advance(60_000);
    expect(t.feed.polls).toBe(polls);
    expect(t.service.activePollCount()).toBe(0);
    await t.service.close();
  });

  it('a fixture first seen already FINISHED is polled once', async () => {
    const t = setup();
    t.feed.status = 'FINISHED';
    t.feed.events = [event('ft', 'FULL_TIME')];
    t.sync('a', ['fx1']);
    await t.clock.advance(60_000);
    expect(t.feed.polls).toBe(1);
    expect(t.delivered).toHaveLength(1);
    await t.service.close();
  });

  it('CANCELLED stops immediately', async () => {
    const t = setup();
    t.feed.status = 'CANCELLED';
    t.sync('a', ['fx1']);
    await t.clock.advance(60_000);
    expect(t.feed.polls).toBe(1);
    expect(t.clock.pending()).toBe(0);
  });

  it('DELAYED -> POSTPONED keeps polling slowly, then LIVE resumes and delivers events', async () => {
    const t = setup();
    t.feed.status = 'POSTPONED'; // ESPN maps STATUS_DELAYED to this
    t.sync('a', ['fx1']);
    await t.clock.advance(0);
    expect(t.feed.polls).toBe(1);
    await t.clock.advance(4999);
    expect(t.feed.polls).toBe(1);
    await t.clock.advance(1); // slow (pre-kickoff) cadence
    expect(t.feed.polls).toBe(2);
    await t.clock.advance(10_000);
    expect(t.feed.polls).toBe(4);
    t.feed.status = 'LIVE';
    t.feed.events = [event('k', 'KICK_OFF')];
    await t.clock.advance(5000);
    expect(t.delivered.at(-1)?.events.map((e) => e.id)).toEqual(['k']);
    const polls = t.feed.polls;
    await t.clock.advance(3000); // now at the live cadence
    expect(t.feed.polls).toBe(polls + 3);
    await t.service.close();
  });

  it('a match suspended mid-play (POSTPONED) then resumed keeps delivering', async () => {
    const t = setup();
    t.feed.events = [event('g1')];
    t.sync('a', ['fx1']);
    await t.clock.advance(0);
    t.feed.status = 'POSTPONED';
    await t.clock.advance(1000);
    const suspended = t.feed.polls;
    await t.clock.advance(5000);
    expect(t.feed.polls).toBe(suspended + 1);
    t.feed.status = 'LIVE';
    t.feed.events = [event('g1'), event('g2')];
    await t.clock.advance(5000);
    expect(t.delivered.at(-1)?.events.map((e) => e.id)).toEqual(['g1', 'g2']);
    await t.service.close();
  });

  it('a postponed watcher is released when its room vanishes without a dispatch (and with no events)', async () => {
    const t = setup({}, { reap: true });
    t.feed.status = 'POSTPONED';
    t.sync('a', ['fx1']);
    await t.clock.advance(0);
    t.missingRooms.add('a');
    await t.clock.advance(30_000);
    expect(t.service.watchedFixtureIds()).toHaveLength(0);
    expect(t.clock.pending()).toBe(0);
  });

  it('FINISHED without FULL_TIME polls slowly until FULL_TIME appears, then stops', async () => {
    const t = setup();
    t.feed.status = 'FINISHED';
    t.feed.events = [event('g1')];
    t.sync('a', ['fx1']);
    await t.clock.advance(0);
    expect(t.feed.polls).toBe(1);
    t.setNow(5000);
    await t.clock.advance(5000);
    expect(t.feed.polls).toBe(2); // slow cadence, still waiting
    t.feed.events = [event('g1'), event('ft', 'FULL_TIME')];
    t.setNow(10_000);
    await t.clock.advance(5000);
    expect(t.delivered.at(-1)?.events.map((e) => e.id)).toEqual(['g1', 'ft']);
    const polls = t.feed.polls;
    expect(t.clock.pending()).toBe(0);
    await t.clock.advance(60_000);
    expect(t.feed.polls).toBe(polls);
  });

  it('gives up waiting for FULL_TIME once the bound passes', async () => {
    const t = setup();
    t.feed.status = 'FINISHED';
    t.feed.events = [event('g1')];
    t.sync('a', ['fx1']);
    await t.clock.advance(0);
    for (let ms = 5000; ms <= 15_000; ms += 5000) {
      t.setNow(ms);
      await t.clock.advance(5000);
    }
    expect(t.clock.pending()).toBe(1); // still polling below the 20s bound
    t.setNow(20_000);
    await t.clock.advance(5000);
    const polls = t.feed.polls;
    expect(t.clock.pending()).toBe(0);
    await t.clock.advance(60_000);
    expect(t.feed.polls).toBe(polls);
  });

  it('uses the slower pre-kickoff interval while SCHEDULED', async () => {
    const t = setup();
    t.feed.status = 'SCHEDULED';
    t.sync('a', ['fx1']);
    await t.clock.advance(0);
    await t.clock.advance(4999);
    expect(t.feed.polls).toBe(1);
    await t.clock.advance(1);
    expect(t.feed.polls).toBe(2);
    await t.service.close();
  });

  it('polls each fixture independently for a gameday-style multi-fixture room', async () => {
    const t = setup();
    t.sync('a', ['fx1', 'fx2']);
    await t.clock.advance(0);
    expect(t.feed.polls).toBe(2);
    expect(t.service.watchedFixtureIds()).toHaveLength(2);
    await t.service.close();
  });

  it('close() clears every timer, waits for in-flight polls and ignores later syncs', async () => {
    const t = setup();
    t.sync('a', ['fx1']);
    await t.clock.advance(0);
    await t.service.close();
    expect(t.clock.pending()).toBe(0);
    t.sync('a', ['fx1']);
    expect(t.clock.pending()).toBe(0);
    await t.clock.advance(60_000);
    expect(t.feed.polls).toBe(1);
  });

  it('tightens to the live cadence within the lead window before scheduled kickoff', async () => {
    // kickoff at t=20000, lead 2000 -> pre-kickoff interval (5000) until 18000, then live interval (1000).
    const t = setup({}, { nowMs: 0 });
    t.feed.status = 'SCHEDULED';
    t.feed.kickoff = new Date(20_000).toISOString();
    t.sync('a', ['fx1']);
    await t.clock.advance(0); // poll 1 at t=0: 18000ms until the window -> capped at 5000
    await t.clock.advance(4999);
    expect(t.feed.polls).toBe(1);
    await t.clock.advance(1);
    expect(t.feed.polls).toBe(2);
    await t.service.close();

    const near = setup({}, { nowMs: 19_000 }); // inside the window -> live cadence
    near.feed.status = 'SCHEDULED';
    near.feed.kickoff = new Date(20_000).toISOString();
    near.sync('a', ['fx1']);
    await near.clock.advance(0);
    await near.clock.advance(1000);
    expect(near.feed.polls).toBe(2);
    await near.service.close();

    const late = setup({}, { nowMs: 25_000 }); // scheduled kickoff passed, status still SCHEDULED -> live cadence
    late.feed.status = 'SCHEDULED';
    late.feed.kickoff = new Date(20_000).toISOString();
    late.sync('a', ['fx1']);
    await late.clock.advance(0);
    await late.clock.advance(1000);
    expect(late.feed.polls).toBe(2);
    await late.service.close();
  });

  it('never runs two polls of one fixture at once when the last room detaches and a new one attaches mid-poll', async () => {
    const clock = createFakeScheduler();
    let inFlight = 0;
    let maxInFlight = 0;
    let polls = 0;
    const releases: Array<() => void> = [];
    const service = createLiveIngestion({
      provider: {
        getLiveMatchState: async (id) => {
          polls += 1;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((resolve) => releases.push(resolve));
          inFlight -= 1;
          return { ok: true, notes: [], fromCache: false, value: { fixture: { id, status: 'LIVE', kickoff: 'x' }, events: [] } } as never;
        },
      },
      dispatchMatchEvents: async () => null,
      onRoomChanged: () => undefined,
      plan: (record) => (record.state.id === ('none' as RoomId) ? [] : [{ fixtureId: FIXTURE, roundKey: 'r' }]),
      scheduler: clock.scheduler,
      random: () => 0.5,
      log: { warn: () => undefined },
      config: { liveIntervalMs: 1000, jitterRatio: 0 },
    });
    service.roomChanged(rec('a'));
    await clock.advance(0);
    expect(polls).toBe(1); // poll 1 is now in flight
    service.roomChanged(rec('a'));
    service.roomRemoved('a' as RoomId); // last room detaches mid-poll
    expect(service.watchedFixtureIds()).toHaveLength(0);
    service.roomChanged(rec('b')); // a new watcher for the same fixture
    await clock.advance(0);
    await clock.advance(5000);
    expect(polls).toBe(1); // the new watcher's first poll waits for the in-flight one
    releases.shift()?.();
    await clock.advance(0);
    expect(polls).toBe(2);
    expect(maxInFlight).toBe(1);
    releases.shift()?.();
    await clock.advance(0);
    await service.close();
  });

  it('reaps a stopped watcher whose room was removed without a dispatch, and clears its timers', async () => {
    const t = setup({}, { reap: true });
    t.feed.status = 'FINISHED';
    t.feed.events = [event('ft', 'FULL_TIME')];
    t.sync('a', ['fx1']);
    await t.clock.advance(0);
    expect(t.service.watchedFixtureIds()).toHaveLength(1);
    expect(t.clock.pending()).toBe(1); // only the reap timer
    await t.clock.advance(30_000); // room still exists: stays, reap re-armed
    expect(t.service.watchedFixtureIds()).toHaveLength(1);
    expect(t.clock.pending()).toBe(1);
    t.missingRooms.add('a'); // removed from the store with no dispatch
    await t.clock.advance(30_000);
    expect(t.service.watchedFixtureIds()).toHaveLength(0);
    expect(t.clock.pending()).toBe(0);
    expect(t.feed.polls).toBe(1);
  });

  it('close() clears a pending reap timer', async () => {
    const t = setup({}, { reap: true });
    t.feed.status = 'FINISHED';
    t.feed.events = [event('ft', 'FULL_TIME')];
    t.sync('a', ['fx1']);
    await t.clock.advance(0);
    expect(t.clock.pending()).toBe(1);
    await t.service.close();
    expect(t.clock.pending()).toBe(0);
  });

  it('delivers an empty list once per (room, round) as a baseline, then skips empty resends', async () => {
    const t = setup();
    t.sync('a', ['fx1']);
    await t.clock.advance(0);
    expect(t.delivered).toHaveLength(1);
    expect(t.delivered[0]?.events).toEqual([]);
    await t.clock.advance(3000);
    expect(t.feed.polls).toBe(4);
    expect(t.delivered).toHaveLength(1); // empty resends are skipped
    // a second room joining a watcher that already has an (empty) cache gets its own baseline from cache
    t.sync('b', ['fx1']);
    await t.clock.advance(0);
    expect(t.delivered.filter((d) => d.roomId === 'b')).toHaveLength(1);
    expect(t.delivered.at(-1)?.events).toEqual([]);
    await t.service.close();
  });

  it('a new round of the same room gets a fresh empty baseline from cache', async () => {
    const clock = createFakeScheduler();
    const delivered: Array<readonly MatchEvent[]> = [];
    let round = 'r1';
    let polls = 0;
    const service = createLiveIngestion({
      provider: {
        getLiveMatchState: async (id) => {
          polls += 1;
          return { ok: true, notes: [], fromCache: false, value: { fixture: { id, status: 'LIVE', kickoff: 'x' }, events: [] } } as never;
        },
      },
      dispatchMatchEvents: async (_room, events) => {
        delivered.push(events);
        return { rejection: null, changed: false, record: rec('a') } as unknown as DispatchOutcome;
      },
      onRoomChanged: () => undefined,
      plan: () => [{ fixtureId: FIXTURE, roundKey: round }],
      scheduler: clock.scheduler,
      random: () => 0.5,
      log: { warn: () => undefined },
      config: { liveIntervalMs: 1000, jitterRatio: 0 },
    });
    service.roomChanged(rec('a'));
    await clock.advance(0);
    await clock.advance(2000);
    expect(delivered).toHaveLength(1);
    round = 'r2';
    service.roomChanged(rec('a'));
    await clock.advance(0);
    expect(delivered).toHaveLength(2); // new round: baseline delivered even though the list is empty
    await clock.advance(3000);
    expect(delivered).toHaveLength(2);
    expect(polls).toBeGreaterThan(3);
    await service.close();
  });

  it('a rejected baseline delivery is retried on the next poll', async () => {
    const t = setup();
    t.rejectWith.code = 'ROUND_CLOSED';
    t.sync('a', ['fx1']);
    await t.clock.advance(0);
    await t.clock.advance(1000);
    expect(t.delivered).toHaveLength(2); // not marked as baselined, so empty is sent again
    t.rejectWith.code = null;
    await t.clock.advance(1000);
    expect(t.delivered).toHaveLength(3);
    await t.clock.advance(3000);
    expect(t.delivered).toHaveLength(3);
    await t.service.close();
  });

  it('sends MATCH_STATS only to stats rooms, after that poll\'s events, and skips unchanged snapshots', async () => {
    const t = setup();
    t.statsRooms.add('s');
    t.eventsToo.add('s');
    t.sync('s', ['fx1']);
    t.sync('e', ['fx1']); // events-only room
    t.feed.events = [event('e1')];
    await t.clock.advance(0);
    expect(t.statsDelivered.map((d) => d.roomId)).toEqual(['s']);
    expect(t.delivered.map((d) => d.roomId).sort()).toEqual(['e', 's']);
    // events for room s were delivered before its stats
    expect(t.statsDelivered[0]?.afterEventBatches).toBeGreaterThanOrEqual(1);
    await t.clock.advance(3000); // three more polls, stats content identical (asOf differs every poll)
    expect(t.feed.polls).toBe(4);
    expect(t.statsDelivered).toHaveLength(1);
    t.feed.goals = 2; // stats change -> delivered again
    await t.clock.advance(1000);
    expect(t.statsDelivered.map((d) => d.goals)).toEqual([0, 2]);
    await t.service.close();
  });

  it('a stats-only room receives no MATCH_EVENTS', async () => {
    const t = setup();
    t.statsRooms.add('s');
    t.feed.events = [event('e1')];
    t.sync('s', ['fx1']);
    await t.clock.advance(0);
    expect(t.delivered).toEqual([]);
    expect(t.statsDelivered).toHaveLength(1);
    await t.service.close();
  });

  it('delivers a post-whistle snapshot even when the stats are identical (FULL_TIME flips the content key)', async () => {
    const t = setup();
    t.statsRooms.add('s');
    t.eventsToo.add('s');
    t.feed.events = [event('g')];
    t.sync('s', ['fx1']);
    await t.clock.advance(0);
    await t.clock.advance(1000);
    expect(t.statsDelivered).toHaveLength(1);
    t.feed.status = 'FINISHED';
    t.feed.events = [event('g'), event('ft', 'FULL_TIME')]; // whistle and (unchanged) final stats in the same poll
    await t.clock.advance(1000);
    expect(t.statsDelivered).toHaveLength(2);
    // events of that poll were delivered before the stats
    expect(t.delivered.at(-1)?.events.map((e) => e.id)).toEqual(['g', 'ft']);
    expect(t.statsDelivered[1]?.afterEventBatches).toBe(t.delivered.length);
    await t.clock.advance(1000); // the one confirming poll: unchanged, nothing new to send
    expect(t.statsDelivered).toHaveLength(2);
    expect(t.clock.pending()).toBe(0);
  });

  it('a stats room attaching later is served the cached snapshot; rejections are quiet and retried', async () => {
    const t = setup();
    t.statsRooms.add('s');
    t.sync('x', ['fx1']);
    await t.clock.advance(0);
    t.sync('s', ['fx1']);
    await t.clock.advance(0);
    expect(t.statsDelivered.map((d) => d.roomId)).toEqual(['s']);
    t.rejectWith.code = 'ROUND_CLOSED';
    t.feed.goals = 5;
    await t.clock.advance(1000);
    t.rejectWith.code = 'INVALID_STATS';
    await t.clock.advance(1000);
    t.rejectWith.code = null;
    await t.clock.advance(1000);
    expect(t.statsDelivered.filter((d) => d.goals === 5).length).toBe(3); // retried until accepted
    await t.clock.advance(3000);
    expect(t.statsDelivered.filter((d) => d.goals === 5).length).toBe(3); // then no more
    await t.service.close();
  });

  it('records the latest observed status (kept after the watcher goes) and re-broadcasts rooms on a status change', async () => {
    const t = setup({}, { reap: true });
    expect(t.service.latestStatus(asFixtureId('fx1'))).toBeNull();
    t.sync('a', ['fx1']);
    await t.clock.advance(0);
    expect(t.service.latestStatus(asFixtureId('fx1'))?.status).toBe('LIVE');
    const before = t.changed.length;
    t.feed.status = 'FINISHED';
    t.feed.events = [event('ft', 'FULL_TIME')];
    await t.clock.advance(1000);
    expect(t.service.latestStatus(asFixtureId('fx1'))?.status).toBe('FINISHED');
    expect(t.changed.length - before).toBeGreaterThanOrEqual(2); // delivery + status broadcast
    t.sync('a', []); // watcher gone, status retained
    expect(t.service.watchedFixtureIds()).toHaveLength(0);
    expect(t.service.latestStatus(asFixtureId('fx1'))?.status).toBe('FINISHED');
    await t.service.close();
  });
});
