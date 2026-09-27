/**
 * Process-local cache for gameday-mode rooms (one room, rounds rotating across every fixture
 * currently live in one competition). Parallels `matchday-cache.ts`'s single-fixture cache — same
 * re-derivability argument: everything here is rebuildable from `FootballDataProvider`, so losing it
 * on restart only costs one re-prefetch, never correctness.
 *
 * Also holds the "pinned fixture per round" log, keyed by `RoundKey` — `(sessionIndex, roundIndex)`,
 * the exact identity `reduceRoom` itself uses for a round (see `data-context.ts`'s
 * `resolveNextRoundKey`, which mirrors the reducer's own session/round indexing so the two can never
 * disagree). A flat, room-wide round counter is deliberately *not* used: a brand-new session started
 * while the room is still in `intermission` from the previous one is indexed by
 * `sessions.length` (the index the session WILL have once committed), not by any count carried over
 * from the just-finished session — see the `START_SESSION` boundary note in `data-context.ts`.
 *
 * `fixtureOrder` can change between dispatches (a match finishes, a new one kicks off; see
 * `refreshGamedayLiveSet`). Without pinning, two dispatches inside the *same* round could recompute a
 * different fixture for the same `RoundKey` purely because the pool drifted mid-round, which would
 * desync the round's actual generated content (fixed at the moment it was generated) from the "now
 * playing" annotation (`fixture-annotation.ts`) shown for it later. `pinRoundFixture` fixes the first
 * answer computed for a given room+key and every later read of that same key returns the same
 * fixture, regardless of how the pool has since drifted.
 */

import type { CompetitionId, FixtureId, GamedayBundle } from '@fdg/football-data';
import type { RoomId } from '@fdg/game-core';

export interface GamedayCacheEntry {
  readonly competitionId: CompetitionId;
  readonly bundle: GamedayBundle;
  /** Fixture ids currently eligible for rotation, in rotation order. Mutated only by
   * `refreshGamedayLiveSet`'s periodic poll — never recomputed from inside round generation. */
  readonly fixtureOrder: readonly FixtureId[];
  readonly lastPolledAt: number;
}

/** A round's identity for pinning purposes — the same `(sessionIndex, roundIndex)` pair
 * `RoomState.sessions[sessionIndex].rounds[roundIndex]` would resolve to once committed. */
export interface RoundKey {
  readonly sessionIndex: number;
  readonly roundIndex: number;
}

const roundKeyToString = (key: RoundKey): string => `${key.sessionIndex}:${key.roundIndex}`;

const entries = new Map<RoomId, GamedayCacheEntry>();
const roundFixtureLog = new Map<RoomId, Map<string, FixtureId>>();

export const getCachedGameday = (roomId: RoomId): GamedayCacheEntry | null => entries.get(roomId) ?? null;

export const setCachedGameday = (roomId: RoomId, entry: GamedayCacheEntry): void => {
  entries.set(roomId, entry);
};

export const clearCachedGameday = (roomId: RoomId): void => {
  entries.delete(roomId);
  roundFixtureLog.delete(roomId);
};

/** Pins (first-write-wins) which fixture the round identified by `key` in `roomId` rotates to, and
 * returns the pinned value — which may differ from `fixtureId` if this room+key was already pinned
 * earlier. Callers must only call this once round generation for `key` has actually succeeded with
 * `fixtureId` (never speculatively ahead of a successful build) — see `data-context.ts`. */
export const pinRoundFixture = (roomId: RoomId, key: RoundKey, fixtureId: FixtureId): FixtureId => {
  let log = roundFixtureLog.get(roomId);
  if (log === undefined) {
    log = new Map();
    roundFixtureLog.set(roomId, log);
  }
  const mapKey = roundKeyToString(key);
  const existing = log.get(mapKey);
  if (existing !== undefined) return existing;
  log.set(mapKey, fixtureId);
  return fixtureId;
};

export const getPinnedRoundFixture = (roomId: RoomId, key: RoundKey): FixtureId | null =>
  roundFixtureLog.get(roomId)?.get(roundKeyToString(key)) ?? null;
