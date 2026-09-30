/**
 * Live-event ingestion: polls `FootballDataProvider.getLiveMatchState` once per watched fixture per
 * interval (shared by every room watching it) and dispatches `MATCH_EVENTS` to each room through the
 * normal dispatch path.
 *
 * Lifecycle
 * - `roomChanged(record)` is called after every dispatch (see `engine/dispatch.ts`). It recomputes the
 *   room's fixture needs (`watch-plan.ts`) and attaches/detaches the room to per-fixture watchers.
 * - The first room attaching to a fixture starts its poll chain (immediate first poll). The chain is
 *   setTimeout-after-completion, so two polls of one fixture can never overlap.
 * - Errors (failed result, unknown fixture, throw) back off exponentially, capped, and never escape.
 * - A fixture observed FINISHED gets one confirming poll (when the transition was seen live) so
 *   full-time events land, then its timer stops. POSTPONED/CANCELLED stop immediately. A stopped
 *   watcher stays registered (with its last events cached) until no room references it, so the
 *   per-second room tick cannot restart polling; a room attaching later is served from the cache.
 * - Last room detaches -> timer cleared, watcher deleted. `close()` clears everything.
 *
 * Idempotency: event ids are provider-stable and the reducer de-duplicates by id, so every poll
 * simply delivers the full event list; unchanged batches are no-ops (no save, no broadcast).
 */

import type { FixtureId, FootballDataProvider, MatchEvent } from '@fdg/football-data';
import type { RoomId } from '@fdg/game-core';
import type { DispatchOutcome } from '../engine/dispatch.js';
import type { RoomRecord } from '../rooms/store.js';
import type { LiveIngestionConfig, LiveIngestionConfigInput } from './schemas.js';
import { fixtureStatusSchema, liveIngestionConfigSchema, matchEventShapeSchema } from './schemas.js';
import type { WatchNeed } from './watch-plan.js';

export type TimerHandle = unknown;

export interface LiveScheduler {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const systemScheduler: LiveScheduler = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface LiveLogger {
  warn(message: string, detail?: unknown): void;
}

export interface LiveIngestionDeps {
  readonly provider: Pick<FootballDataProvider, 'getLiveMatchState'>;
  readonly dispatchMatchEvents: (roomId: RoomId, events: readonly MatchEvent[]) => Promise<DispatchOutcome | null>;
  readonly onRoomChanged: (record: RoomRecord) => void;
  /** Which fixtures a room needs right now (`planWatch` in production; stubbed in unit tests). */
  readonly plan: (record: RoomRecord) => readonly WatchNeed[];
  readonly scheduler?: LiveScheduler;
  readonly random?: () => number;
  /** Wall clock for kickoff-proximity decisions (default `Date.now`). */
  readonly now?: () => number;
  /** Room existence lookup used to reap stopped watchers whose rooms vanished without a dispatch. */
  readonly loadRoom?: (roomId: RoomId) => Promise<RoomRecord | null>;
  readonly log?: LiveLogger;
  readonly config?: LiveIngestionConfigInput;
}

export interface LiveIngestion {
  roomChanged(record: RoomRecord): void;
  roomRemoved(roomId: RoomId): void;
  /** Fixture ids that currently have a watcher (polling or stopped-but-referenced). */
  watchedFixtureIds(): readonly FixtureId[];
  /** Fixture ids with an armed or in-flight poll (diagnostics/tests). */
  activePollCount(): number;
  /** Resolves once no poll or delivery is in flight (tests/diagnostics). */
  idle(): Promise<void>;
  close(): Promise<void>;
}

const BENIGN_REJECTIONS = new Set(['ROUND_CLOSED', 'WRONG_PHASE', 'NO_ACTIVE_SESSION', 'ROOM_TERMINAL']);

interface Watcher {
  readonly fixtureId: FixtureId;
  readonly rooms: Map<RoomId, string>;
  timer: TimerHandle | null;
  reapTimer: TimerHandle | null;
  inFlight: Promise<void> | null;
  failures: number;
  sawNotFinished: boolean;
  finishedPolls: number;
  done: boolean;
  /** When a FINISHED state without a FULL_TIME event was first seen (bounds the slow wait for one). */
  finishedSeenAt: number | null;
  lastEvents: readonly MatchEvent[] | null;
}

export const createLiveIngestion = (deps: LiveIngestionDeps): LiveIngestion => {
  const config: LiveIngestionConfig = liveIngestionConfigSchema.parse(deps.config ?? {});
  const scheduler = deps.scheduler ?? systemScheduler;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const log: LiveLogger = deps.log ?? { warn: (m, d) => console.warn(`[live] ${m}`, d ?? '') };

  const watchers = new Map<FixtureId, Watcher>();
  const roomFixtures = new Map<RoomId, Set<FixtureId>>();
  const pending = new Set<Promise<unknown>>();
  /** Tail of the poll chain per fixture. Survives watcher recreation so two polls of one fixture can never overlap. */
  const inFlightByFixture = new Map<FixtureId, Promise<void>>();
  let closed = false;

  const track = (promise: Promise<unknown>): void => {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise));
  };

  const jittered = (ms: number): number => {
    const spread = (random() - 0.5) * 2 * config.jitterRatio;
    return Math.max(0, Math.round(ms * (1 + spread)));
  };

  const armTimer = (watcher: Watcher, delayMs: number): void => {
    if (closed || watchers.get(watcher.fixtureId) !== watcher || watcher.done) return;
    if (watcher.timer !== null) scheduler.clearTimeout(watcher.timer);
    watcher.timer = scheduler.setTimeout(() => {
      watcher.timer = null;
      startPoll(watcher);
    }, delayMs);
  };

  /**
   * A stopped watcher has no poll timer, so a room removed from the store without any dispatch would never
   * be detached from it. Periodically re-check its rooms against the store (armed only while stopped).
   */
  const armReap = (watcher: Watcher): void => {
    if (closed || deps.loadRoom === undefined || watchers.get(watcher.fixtureId) !== watcher) return;
    if (watcher.reapTimer !== null) scheduler.clearTimeout(watcher.reapTimer);
    watcher.reapTimer = scheduler.setTimeout(() => {
      watcher.reapTimer = null;
      track(reap(watcher));
    }, config.reapIntervalMs);
  };

  const reap = async (watcher: Watcher): Promise<void> => {
    const loadRoom = deps.loadRoom;
    if (loadRoom === undefined) return;
    for (const roomId of [...watcher.rooms.keys()]) {
      try {
        const record = await loadRoom(roomId);
        if (closed) return;
        if (record === null) detach(roomId, watcher.fixtureId);
        else api.roomChanged(record);
      } catch (error) {
        log.warn(`reap failed for room ${roomId}`, error);
      }
    }
    if (!closed && watchers.get(watcher.fixtureId) === watcher) armReap(watcher);
  };

  /** Delay before the next poll of a fixture that has not finished. Tightens to the live cadence near kickoff. */
  const cadenceFor = (status: string, kickoff: string, slowWhenPast: boolean): number => {
    if (status !== 'SCHEDULED') return config.liveIntervalMs;
    const untilKickoff = Date.parse(kickoff) - now();
    if (!Number.isFinite(untilKickoff)) return config.preKickoffIntervalMs;
    const untilWindow = untilKickoff - config.kickoffLeadMs;
    if (untilWindow <= 0) return slowWhenPast && untilKickoff <= 0 ? config.preKickoffIntervalMs : config.liveIntervalMs;
    return Math.max(config.liveIntervalMs, Math.min(config.preKickoffIntervalMs, untilWindow));
  };

  const dropWatcher = (watcher: Watcher): void => {
    if (watcher.timer !== null) scheduler.clearTimeout(watcher.timer);
    watcher.timer = null;
    if (watcher.reapTimer !== null) scheduler.clearTimeout(watcher.reapTimer);
    watcher.reapTimer = null;
    watchers.delete(watcher.fixtureId);
  };

  const detach = (roomId: RoomId, fixtureId: FixtureId): void => {
    const watcher = watchers.get(fixtureId);
    roomFixtures.get(roomId)?.delete(fixtureId);
    if (roomFixtures.get(roomId)?.size === 0) roomFixtures.delete(roomId);
    if (watcher === undefined) return;
    watcher.rooms.delete(roomId);
    if (watcher.rooms.size === 0) dropWatcher(watcher);
  };

  const validEvents = (fixtureId: FixtureId, events: readonly MatchEvent[]): readonly MatchEvent[] => {
    const good: MatchEvent[] = [];
    let dropped = 0;
    for (const event of events) {
      if (event.fixtureId === fixtureId && matchEventShapeSchema.safeParse(event).success) good.push(event);
      else dropped += 1;
    }
    if (dropped > 0) log.warn(`dropped ${String(dropped)} malformed/foreign event(s) for fixture ${fixtureId}`);
    return good;
  };

  const deliver = async (roomId: RoomId, events: readonly MatchEvent[]): Promise<void> => {
    if (events.length === 0) return;
    try {
      const outcome = await deps.dispatchMatchEvents(roomId, events);
      if (outcome === null) {
        for (const fixtureId of [...(roomFixtures.get(roomId) ?? [])]) detach(roomId, fixtureId);
        return;
      }
      if (outcome.rejection !== null) {
        if (!BENIGN_REJECTIONS.has(outcome.rejection.code)) {
          log.warn(`MATCH_EVENTS rejected for room ${roomId}: ${outcome.rejection.code}`);
        }
        return;
      }
      if (outcome.changed) deps.onRoomChanged(outcome.record);
    } catch (error) {
      log.warn(`MATCH_EVENTS dispatch failed for room ${roomId}`, error);
    }
  };

  const fail = (watcher: Watcher, reason: string, detail?: unknown): void => {
    watcher.failures += 1;
    if (watcher.failures === 1 || watcher.failures % 10 === 0) {
      log.warn(`poll failed for fixture ${watcher.fixtureId} (x${String(watcher.failures)}): ${reason}`, detail);
    }
    const delay = Math.min(
      config.maxBackoffMs,
      config.liveIntervalMs * config.backoffFactor ** (watcher.failures - 1),
    );
    armTimer(watcher, jittered(delay));
  };

  const runPoll = async (watcher: Watcher): Promise<void> => {
    let state;
    try {
      const result = await deps.provider.getLiveMatchState(watcher.fixtureId);
      if (!result.ok) {
        fail(watcher, result.error.message);
        return;
      }
      state = result.value;
    } catch (error) {
      fail(watcher, 'provider threw', error);
      return;
    }
    if (state === null) {
      fail(watcher, 'unknown fixture');
      return;
    }
    if (closed || watchers.get(watcher.fixtureId) !== watcher) return;

    watcher.failures = 0;
    const events = validEvents(watcher.fixtureId, state.events);
    watcher.lastEvents = events;
    const status = fixtureStatusSchema.safeParse(state.fixture.status);
    const current = status.success ? status.data : 'LIVE';

    for (const roomId of [...watcher.rooms.keys()]) await deliver(roomId, events);
    if (closed || watchers.get(watcher.fixtureId) !== watcher) return;

    if (current === 'FINISHED') {
      const hasFullTime = events.some((event) => event.type === 'FULL_TIME');
      if (hasFullTime) {
        watcher.finishedPolls += 1;
        // Seen live -> one confirming poll (late plays); first seen already finished -> stop now.
        if (!watcher.sawNotFinished || watcher.finishedPolls >= 2 || watcher.finishedSeenAt !== null) watcher.done = true;
        else armTimer(watcher, jittered(config.liveIntervalMs));
      } else {
        // The provider withholds FULL_TIME when the events do not add up to the score, and keeps the summary on a
        // short TTL so missing plays can land: keep polling slowly until one appears or the bound passes.
        watcher.finishedSeenAt ??= now();
        if (now() - watcher.finishedSeenAt >= config.finishedWithoutFullTimeMaxMs) {
          log.warn(`giving up waiting for FULL_TIME on finished fixture ${watcher.fixtureId}`);
          watcher.done = true;
        } else {
          armTimer(watcher, jittered(config.preKickoffIntervalMs));
        }
      }
    } else if (current === 'CANCELLED') {
      watcher.done = true;
    } else if (current === 'POSTPONED') {
      // Also what providers report for a delayed kickoff or a suspended match: keep polling (slowly, tightening
      // near a known kickoff) so play resuming is noticed. Only CANCELLED is terminal.
      watcher.finishedSeenAt = null;
      armTimer(watcher, jittered(cadenceFor('SCHEDULED', state.fixture.kickoff, true)));
    } else {
      watcher.sawNotFinished = true;
      watcher.finishedSeenAt = null;
      armTimer(watcher, jittered(cadenceFor(current, state.fixture.kickoff, false)));
    }
    if (watcher.done) {
      if (watcher.timer !== null) scheduler.clearTimeout(watcher.timer);
      watcher.timer = null;
      armReap(watcher);
    }
  };

  const startPoll = (watcher: Watcher): void => {
    if (closed || watcher.inFlight !== null || watchers.get(watcher.fixtureId) !== watcher || watcher.done) return;
    // Chain behind any poll still running for this fixture (e.g. a previous watcher's, after the last room
    // detached and a new one attached mid-poll): never two in flight per fixture.
    const prior = inFlightByFixture.get(watcher.fixtureId) ?? Promise.resolve();
    const run: Promise<void> = prior
      .then(() => (closed || watchers.get(watcher.fixtureId) !== watcher ? undefined : runPoll(watcher)))
      .catch((error: unknown) => log.warn(`unexpected poll error for fixture ${watcher.fixtureId}`, error))
      .finally(() => {
        watcher.inFlight = null;
        if (inFlightByFixture.get(watcher.fixtureId) === run) inFlightByFixture.delete(watcher.fixtureId);
      });
    inFlightByFixture.set(watcher.fixtureId, run);
    watcher.inFlight = run;
    track(run);
  };

  const attach = (roomId: RoomId, need: WatchNeed): void => {
    let watcher = watchers.get(need.fixtureId);
    const isNew = watcher === undefined;
    if (watcher === undefined) {
      watcher = {
        fixtureId: need.fixtureId,
        rooms: new Map(),
        timer: null,
        reapTimer: null,
        inFlight: null,
        failures: 0,
        sawNotFinished: false,
        finishedPolls: 0,
        done: false,
        finishedSeenAt: null,
        lastEvents: null,
      };
      watchers.set(need.fixtureId, watcher);
    }
    const previousKey = watcher.rooms.get(roomId);
    watcher.rooms.set(roomId, need.roundKey);
    let set = roomFixtures.get(roomId);
    if (set === undefined) {
      set = new Set();
      roomFixtures.set(roomId, set);
    }
    set.add(need.fixtureId);

    if (isNew) {
      armTimer(watcher, 0);
      armReap(watcher); // long-lived watchers (postponed / awaiting full time) must not outlive their rooms
    } else if (previousKey !== need.roundKey && watcher.lastEvents !== null) {
      // Room (or its round) is new to a watcher that already has events: serve them from cache now.
      track(deliver(roomId, watcher.lastEvents));
    }
  };

  const api: LiveIngestion = {
    roomChanged: (record) => {
      if (closed) return;
      try {
        const needs = deps.plan(record);
        const roomId = record.state.id;
        const wanted = new Set(needs.map((need) => need.fixtureId));
        for (const fixtureId of [...(roomFixtures.get(roomId) ?? [])]) {
          if (!wanted.has(fixtureId)) detach(roomId, fixtureId);
        }
        for (const need of needs) {
          if (watchers.get(need.fixtureId)?.rooms.get(roomId) === need.roundKey) continue;
          attach(roomId, need);
        }
      } catch (error) {
        log.warn('roomChanged failed', error);
      }
    },
    roomRemoved: (roomId) => {
      for (const fixtureId of [...(roomFixtures.get(roomId) ?? [])]) detach(roomId, fixtureId);
    },
    watchedFixtureIds: () => [...watchers.keys()],
    activePollCount: () =>
      [...watchers.values()].filter((watcher) => watcher.timer !== null || watcher.inFlight !== null).length,
    idle: async () => {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
    close: async () => {
      closed = true;
      for (const watcher of watchers.values()) {
        if (watcher.timer !== null) scheduler.clearTimeout(watcher.timer);
        watcher.timer = null;
        if (watcher.reapTimer !== null) scheduler.clearTimeout(watcher.reapTimer);
        watcher.reapTimer = null;
      }
      watchers.clear();
      roomFixtures.clear();
      await Promise.allSettled([...pending]);
    },
  };
  return api;
};
