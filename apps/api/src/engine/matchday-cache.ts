/**
 * Process-local cache of the most recent `MatchdayBundle` per room. Not part of `RoomStore`: a
 * bundle is fully re-derivable from `FootballDataProvider` (itself cached), so losing it on
 * restart or in a multi-instance deployment only costs one re-fetch, never correctness.
 */

import type { MatchdayBundle } from '@fdg/football-data';
import type { RoomId } from '@fdg/game-core';

const bundles = new Map<RoomId, MatchdayBundle>();

export const getCachedBundle = (roomId: RoomId): MatchdayBundle | null => bundles.get(roomId) ?? null;

export const setCachedBundle = (roomId: RoomId, bundle: MatchdayBundle): void => {
  bundles.set(roomId, bundle);
};

export const clearCachedBundle = (roomId: RoomId): void => {
  bundles.delete(roomId);
};
