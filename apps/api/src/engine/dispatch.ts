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

import type {
  EngineEvent,
  EngineRejection,
  PlayerId,
  ProjectedRoom,
  RoomAction,
  RoomId,
  RoomState,
} from '@fdg/game-core';
import { activePlayers, projectFor, projectForHostScreen, reduceRoom } from '@fdg/game-core';
import type { Reduction } from '@fdg/game-core';
import type { FixtureId, FixtureStatus } from '@fdg/football-data';
import type { AppContext } from '../context.js';
import { persistEngineEvents } from '../persistence/results.js';
import type { RoomMeta, RoomRecord } from '../rooms/store.js';
import { roomFixtureIds } from '../rooms/store.js';
import type { EngineDepsCandidate } from './deps.js';
import { buildEngineDepsResolution, registry } from './deps.js';
import type { CurrentFixtureSummary } from './fixture-annotation.js';
import { syncFixtureStatus } from './fixture-status.js';
import { resolveCurrentFixtureAnnotation } from './fixture-annotation.js';
import { pinRoundFixture } from './gameday-cache.js';

export interface DispatchResult {
  readonly record: RoomRecord;
  readonly events: readonly EngineEvent[];
  readonly rejection: EngineRejection | null;
  readonly changed: boolean;
}

/**
 * The engine's own `ProjectedRoom` plus one API-layer-only annotation: which fixture the current
 * round is about (`null` for a general room, or before any matchday data has been prefetched yet).
 * See `fixture-annotation.ts` for why this lives here rather than inside `game-core`'s projection.
 */
export interface RoomBroadcastPayload extends ProjectedRoom {
  readonly currentFixture: CurrentFixtureSummary | null;
  /**
   * Single-fixture matchday rooms: the fixture's status from the cache-only sources (ingestion's latest observation,
   * else the prefetched bundle); `null` otherwise. Re-broadcast when the watched fixture's status changes. REST
   * (`GET /rooms/:id`) is the authoritative, fresher source. See `fixture-status.ts`.
   */
  readonly fixtureStatus: FixtureStatus | null;
  /**
   * Every fixture the room is tied to (`[]` for general/gameday rooms): the single fixture, or the pool's list in the
   * host's order. Per-round fixture is `currentFixture`. See `rooms/routes.ts`.
   */
  readonly fixtureIds: readonly string[];
}

export interface DispatchOutcome extends DispatchResult {
  /** Per-active-player projection, ready to broadcast. */
  readonly projections: ReadonlyMap<PlayerId, RoomBroadcastPayload>;
  /** The shared "big screen" projection (`viewerId: null`). */
  readonly hostScreen: RoomBroadcastPayload;
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

const project = (
  state: RoomState,
  meta: RoomMeta,
  clock: { now(): number },
  fixtureStatus: FixtureStatus | null,
): { projections: Map<PlayerId, RoomBroadcastPayload>; hostScreen: RoomBroadcastPayload } => {
  const currentFixture = resolveCurrentFixtureAnnotation(state.id, state, meta);
  const fixtureIds = roomFixtureIds(meta);
  const projections = new Map<PlayerId, RoomBroadcastPayload>();
  for (const player of activePlayers(state)) {
    projections.set(player.id, { ...projectFor(state, player.id, { modules: registry, clock }), currentFixture, fixtureStatus, fixtureIds });
  }
  return {
    projections,
    hostScreen: { ...projectForHostScreen(state, { modules: registry, clock }), currentFixture, fixtureStatus, fixtureIds },
  };
};

/**
 * Tries `reduceRoom` against each candidate in turn (see `EngineDepsResolution`), stopping at the
 * first one the reducer accepts. For everything except a genuine gameday round-generation attempt
 * `candidates` has exactly one entry, so this is a single `reduceRoom` call, same as before this fix.
 *
 * Only keeps retrying past a rejection when that rejection is `ROUND_GENERATION_FAILED` — the one
 * rejection reason that can plausibly depend on *which* fixture's data was fed in (the module's own
 * `generateRound` failing on this specific candidate's content, e.g. no unique fact to ask about, or
 * this session having already used up a thin fixture's only usable content). Every other rejection
 * reason (`WRONG_PHASE`, `NOT_ENOUGH_PLAYERS`, `LOADING_INCOMPLETE`, `UNKNOWN_MODULE`, …) is decided
 * before `deps.data` is ever read and so is identical for every candidate — retrying those would just
 * repeat the same rejection `candidates.length` times for no benefit.
 */
const reduceWithCandidates = (
  state: RoomState,
  action: RoomAction,
  candidates: readonly EngineDepsCandidate[],
): { reduction: Reduction; usedFixtureId: FixtureId | null } => {
  const [first, ...rest] = candidates;
  if (first === undefined) {
    // Invariant: `EngineDepsResolution.candidates` is always non-empty (see `data-context.ts`). If
    // this ever fires it is a bug in that invariant, not a reachable runtime state — fail loudly
    // rather than silently generating a round with no data at all.
    throw new Error('buildEngineDepsResolution returned no candidates');
  }

  let reduction = reduceRoom(state, action, first.deps);
  let usedFixtureId = first.fixtureId;
  for (const candidate of rest) {
    if (reduction.rejection === null || reduction.rejection.code !== 'ROUND_GENERATION_FAILED') break;
    reduction = reduceRoom(state, action, candidate.deps);
    usedFixtureId = candidate.fixtureId;
  }
  return { reduction, usedFixtureId };
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

    const resolution = await buildEngineDepsResolution(ctx, before.state, before.meta, action);
    const { reduction, usedFixtureId } = reduceWithCandidates(before.state, action, resolution.candidates);

    const changed = reduction.state !== before.state;

    const record: RoomRecord = { state: reduction.state, meta: before.meta };
    if (changed) {
      await ctx.roomStore.save(record);

      // Commit-time pinning: only ever write a gameday fixture pin once `reduceRoom` has actually
      // accepted a round built from `usedFixtureId`'s data *and* that acceptance has been durably
      // saved — never speculatively ahead of the reducer's own decision, and never for a round that
      // was accepted in memory but never actually persisted (e.g. a future store whose `save` can
      // fail). A rejected attempt (any reason at all) leaves no pin behind, so the very next attempt
      // for this same `RoundKey` (an immediate client retry, or a later dispatch) is free to rotate to
      // a different candidate rather than being wedged onto one that just failed or is no longer live.
      // See `data-context.ts`'s `RoundDataResolution` doc comment for the full mechanism.
      //
      // This must happen immediately after `save` succeeds and *before* `persistEngineEvents` below:
      // `save` is what makes the round genuinely live in the room's committed state, and the pin
      // needs to reflect that fact regardless of whether the secondary (best-effort) event-persistence
      // step that follows also succeeds. If `persistEngineEvents` throws, the round is still live and
      // must still be pinned to the fixture it actually came from — otherwise `currentFixture`'s
      // annotation would fall back to the wrong fixture while the round's real content is about
      // `usedFixtureId`.
      if (reduction.rejection === null && resolution.gamedayPinKey !== null && usedFixtureId !== null) {
        pinRoundFixture(roomId, resolution.gamedayPinKey, usedFixtureId);
      }

      await persistEngineEvents(ctx.prisma, reduction.state, reduction.events);
    }

    // Keep the live-ingestion watch set in sync with the room (sync, never throws, never awaits a poll).
    ctx.liveIngestion?.roomChanged(record);

    const { projections, hostScreen } = project(
      record.state,
      record.meta,
      { now: () => Date.now() },
      syncFixtureStatus(ctx, record.state.id, record.meta),
    );
    return {
      record,
      events: reduction.events,
      rejection: reduction.rejection,
      changed,
      projections,
      hostScreen,
    };
  });

/** Convenience for a fresh `RoomState` that was never in the store (only used right at creation). */
export const projectRoom = (
  record: RoomRecord,
  fixtureStatus: FixtureStatus | null = null,
): { projections: ReadonlyMap<PlayerId, RoomBroadcastPayload>; hostScreen: RoomBroadcastPayload } =>
  project(record.state, record.meta, { now: () => Date.now() }, fixtureStatus);

export type { RoomState };
