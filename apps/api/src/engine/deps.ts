import type { EngineDeps, EngineGameModule, RoomAction, RoomState } from '@fdg/game-core';
import { activeSession, createDefaultRegistry, MULBERRY32 } from '@fdg/game-core';
import type { FixtureId } from '@fdg/football-data';
import type { AppContext } from '../context.js';
import type { RoomMeta } from '../rooms/store.js';
import { buildRoundDataContext } from './data-context.js';
import type { RoundKey } from './gameday-cache.js';

/** One shared registry instance for the whole process — modules are stateless. */
export const registry = createDefaultRegistry();

/**
 * Which module a dispatch's data context should be built for.
 *
 * This must always agree with which module `reduceRoom` is actually about to build a round for (or,
 * for actions that never build a round at all, with whichever module is the best-effort "currently
 * relevant" one for side effects like data prefetch/warming — e.g. `START_LOADING` wants the module
 * the host just selected, not some unrelated earlier session):
 *
 * - `SELECT_GAME` is about to *change* `room.selection` to `action.moduleId` — resolve against that,
 *   not whatever `room.selection` currently holds.
 * - `START_SESSION` (`reducer.ts`'s `START_SESSION` case) *always* builds its new session from
 *   `state.selection`, unconditionally — regardless of whether the room's current active session is
 *   still resumable. (A still-resumable session is simply superseded; the reducer never special-cases
 *   that.) So this resolver must do the same: never prefer an active-but-resumable session's module
 *   over `room.selection` for `START_SESSION`.
 * - Every other action either operates on an already-built round *within* a still-ongoing session
 *   (`TICK`, `SUBMIT_ANSWER`, `LOCK_ROUND`, `REVEAL_ROUND`, `MATCH_EVENTS`, an `ADVANCE` that builds
 *   the session's next round) — for these, `activeSession(room)`'s own `moduleId` is the only correct
 *   source, never `room.selection` (which may already point at a different module the host has since
 *   picked for the *next* session, not this one) — or happens before/between sessions, with no
 *   still-ongoing session to speak of (`START_LOADING`, `LOADING_PROGRESS`, `LOADING_FAILED`, a
 *   `PLAYER_JOIN` in the lobby, …), for which `room.selection` (the module about to be, or last,
 *   selected) is the only sensible source. The dividing line `reduceRoom` itself draws is
 *   `session.finishedAt === null`: a session only reads its own `moduleId` for building/continuing a
 *   round while it has not finished; once finished (or if none exists yet), only `room.selection`
 *   is ever relevant again, exactly like `START_SESSION`.
 */
const resolveModule = (room: RoomState, action: RoomAction): EngineGameModule | null => {
  if (action.type === 'SELECT_GAME') {
    return registry.get(action.moduleId) ?? null;
  }
  if (action.type === 'START_SESSION') {
    return room.selection === null ? null : (registry.get(room.selection.moduleId) ?? null);
  }

  const session = activeSession(room);
  if (session !== undefined && session.finishedAt === null) {
    return registry.get(session.moduleId) ?? null;
  }
  if (room.selection !== null) {
    return registry.get(room.selection.moduleId) ?? null;
  }
  return session === undefined ? null : (registry.get(session.moduleId) ?? null);
};

/** One candidate `EngineDeps` a dispatch may try against `reduceRoom`, paired with which gameday
 * fixture (if any) it came from — see `RoundDataCandidate` in `data-context.ts`. */
export interface EngineDepsCandidate {
  readonly deps: EngineDeps;
  readonly fixtureId: FixtureId | null;
}

/** Mirrors `RoundDataResolution`: an ordered, non-empty list of `EngineDeps` candidates to try in
 * turn, plus the `RoundKey` a fixture pin must be written for once (and only once) one of them is
 * actually accepted by `reduceRoom` — see `dispatch.ts`'s `dispatchAction`. */
export interface EngineDepsResolution {
  readonly candidates: readonly EngineDepsCandidate[];
  readonly gamedayPinKey: RoundKey | null;
}

/** Builds every `EngineDeps` candidate a single dispatch may need to try: the server-owned clock, RNG,
 * module registry and football data context, the last resolved fresh for every dispatch (cheap:
 * matchday reads a per-room cache, general reads a process-wide cache). */
export const buildEngineDepsResolution = async (
  ctx: AppContext,
  room: RoomState,
  meta: RoomMeta,
  action: RoomAction,
): Promise<EngineDepsResolution> => {
  const module = resolveModule(room, action);
  const resolution = await buildRoundDataContext(ctx, room, meta, action, module?.category ?? null, module?.dataRequirements ?? []);
  const candidates: EngineDepsCandidate[] = resolution.candidates.map((candidate) => ({
    deps: {
      clock: { now: () => Date.now() },
      rng: MULBERRY32,
      modules: registry,
      data: candidate.context,
    },
    fixtureId: candidate.fixtureId,
  }));
  return { candidates, gamedayPinKey: resolution.gamedayPinKey };
};
