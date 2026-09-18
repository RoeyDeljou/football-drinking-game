/**
 * The one place `reduceRoom` is called from the transport. Every socket event and every
 * system-driven action (ticks, loading progress, match events) funnels through here, so
 * persistence and per-recipient projection never drift from what actually got dispatched.
 *
 * Concurrency: `dispatchAction` owns the entire load -> reduce -> save round trip for a room, and
 * every call for the same `roomId` is serialized through a per-room queue. This is load-bearing,
 * not defensive dead code: with today's in-memory `RoomStore` every `await` in the round trip
 * resolves in a microtask, so two concurrent dispatches for the same room *happen* to interleave
 * safely — but the moment `RoomStore` is Redis-backed (the documented plan) or a cache miss does
 * real I/O, two callers racing `load()` before either `save()`s would silently lose one dispatch's
 * effect (reproduced directly: two concurrent `SUBMIT_ANSWER`s from one snapshot dropped one
 * submission). Queuing here means no call site has to know or remember to serialize itself.
 */

import type { EngineEvent, EngineRejection, PlayerId, ProjectedRoom, RoomAction, RoomId, RoomState } from '@fdg/game-core';
import { activePlayers, projectFor, projectForHostScreen, reduceRoom } from '@fdg/game-core';
import type { AppContext } from '../context.js';
import { persistEngineEvents } from '../persistence/results.js';
import type { RoomRecord } from '../rooms/store.js';
import { buildEngineDeps, registry } from './deps.js';

export interface DispatchResult {
  readonly record: RoomRecord;
  readonly events: readonly EngineEvent[];
  readonly rejection: EngineRejection | null;
  readonly changed: boolean;
}

export interface DispatchOutcome extends DispatchResult {
  /** Per-active-player projection, ready to broadcast. */
  readonly projections: ReadonlyMap<PlayerId, ProjectedRoom>;
  /** The shared "big screen" projection (`viewerId: null`). */
  readonly hostScreen: ProjectedRoom;
}

/** roomId -> tail of the serialized queue for that room. Module-level by design: it must be shared
 * by every caller in the process, the same way a real Redis-backed `RoomStore` would need a
 * distributed lock shared by every process. */
const roomQueues = new Map<RoomId, Promise<unknown>>();

const enqueueForRoom = <T>(roomId: RoomId, task: () => Promise<T>): Promise<T> => {
  const tail = roomQueues.get(roomId) ?? Promise.resolve();
  const settleQuietly = (): undefined => undefined;
  const run = tail.then(task, task);
  // Keep the tail alive for the *next* caller even if this task rejects, and don't leak memory by
  // growing the map forever — each entry is overwritten by the next dispatch for that room.
  roomQueues.set(roomId, run.then(settleQuietly, settleQuietly));
  return run;
};

const project = (state: RoomState, clock: { now(): number }): { projections: Map<PlayerId, ProjectedRoom>; hostScreen: ProjectedRoom } => {
  const projections = new Map<PlayerId, ProjectedRoom>();
  for (const player of activePlayers(state)) {
    projections.set(player.id, projectFor(state, player.id, { modules: registry, clock }));
  }
  return { projections, hostScreen: projectForHostScreen(state, { modules: registry, clock }) };
};

/**
 * Dispatch one action against a room. Loads the current record itself (inside the per-room queue,
 * never from a snapshot the caller might be holding stale) and returns `null` if the room does not
 * exist — callers should treat that exactly like any other "room not found" REST/socket error.
 */
export const dispatchAction = async (
  ctx: AppContext,
  roomId: RoomId,
  action: RoomAction,
): Promise<DispatchOutcome | null> =>
  enqueueForRoom(roomId, async () => {
    const before = await ctx.roomStore.load(roomId);
    if (before === null) return null;

    const deps = await buildEngineDeps(ctx, before.state, before.meta, action);
    const reduction = reduceRoom(before.state, action, deps);
    const changed = reduction.state !== before.state;

    const record: RoomRecord = { state: reduction.state, meta: before.meta };
    if (changed) {
      await ctx.roomStore.save(record);
      await persistEngineEvents(ctx.prisma, reduction.state, reduction.events);
    }

    const { projections, hostScreen } = project(record.state, deps.clock);
    return { record, events: reduction.events, rejection: reduction.rejection, changed, projections, hostScreen };
  });

/** Convenience for a fresh `RoomState` that was never in the store (only used right at creation). */
export const projectRoom = (record: RoomRecord): { projections: ReadonlyMap<PlayerId, ProjectedRoom>; hostScreen: ProjectedRoom } =>
  project(record.state, { now: () => Date.now() });

export type { RoomState };
