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

type Status = 'SCHEDULED' | 'LIVE' | 'FINISHED' | 'POSTPONED';

const rec = (roomId: string): RoomRecord => ({ state: { id: roomId }, meta: {} }) as unknown as RoomRecord;

const setup = (initialNeeds: Record<string, readonly string[]> = {}) => {
  const clock = createFakeScheduler();
  const feed = { status: 'LIVE' as Status, events: [] as MatchEvent[], fail: 0, polls: 0, throwNext: false, nullNext: false };
  const needs: Record<string, readonly string[]> = { ...initialNeeds };
  const delivered: Array<{ roomId: string; events: readonly MatchEvent[] }> = [];
  const changed: string[] = [];
  const goneRooms = new Set<string>();
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
            fixture: { id, status: feed.status },
            events: feed.events.map((e) => ({ ...e, fixtureId: id })),
            teamStats: [],
            playerStats: [],
            updatedAt: '',
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
    onRoomChanged: (record) => changed.push(record.state.id),
    plan: (record) =>
      (needs[record.state.id] ?? []).map((fixtureId) => ({ fixtureId: asFixtureId(fixtureId), roundKey: 'r1' })),
    scheduler: clock.scheduler,
    random: () => 0.5,
    log: { warn: () => undefined },
    config: { liveIntervalMs: 1000, preKickoffIntervalMs: 5000, maxBackoffMs: 8000, backoffFactor: 2, jitterRatio: 0.1 },
  });
  const sync = (roomId: string, fixtures: readonly string[]): void => {
    needs[roomId] = fixtures;
    service.roomChanged(rec(roomId));
  };
  return { clock, feed, delivered, changed, service, rejectWith, goneRooms, sync };
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

  it('stops immediately for a postponed fixture', async () => {
    const t = setup();
    t.feed.status = 'POSTPONED';
    t.sync('a', ['fx1']);
    await t.clock.advance(60_000);
    expect(t.feed.polls).toBe(1);
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
});
