/**
 * Builds the engine's `RoundDataContext` from `@fdg/football-data`, for whichever category
 * (`matchday` | `general`) the room's active/selected game belongs to.
 *
 * Matchday rooms are prefetched once (see `runMatchdayPrefetch`, driven from the loading screen)
 * and the resulting bundle is cached per room (`matchday-cache.ts`) — every later dispatch reads
 * the cache instead of hitting the network again. General rooms share one process-wide dataset
 * built at server start (`AppContext.generalDataset`).
 */

import type { GameCategory, RoundDataContext } from '@fdg/game-core';
import { EMPTY_DATA_CONTEXT } from '@fdg/game-core';
import type { FixtureId, MatchdayBundle } from '@fdg/football-data';
import { MatchdayPrefetcher } from '@fdg/football-data';
import type { RoomId } from '@fdg/game-core';
import type { AppContext } from '../context.js';
import { getCachedBundle, setCachedBundle } from './matchday-cache.js';
import type { RoomMeta } from '../rooms/store.js';

const bundleToContext = (bundle: MatchdayBundle): RoundDataContext => ({
  fixture: bundle.fixture,
  lineups: bundle.lineups,
  live: bundle.live,
  teams: [bundle.fixture.homeTeam, bundle.fixture.awayTeam],
  players: bundle.squads.flatMap((squad) => squad.players),
  profiles: bundle.profiles,
  seasonStats: bundle.seasonStats,
  quality: bundle.quality,
});

/** Runs the four-step prefetch, caches the bundle, and (optionally) reports live progress. */
export const runMatchdayPrefetch = async (
  ctx: AppContext,
  roomId: RoomId,
  fixtureId: FixtureId,
  onProgress?: (prefetcher: MatchdayPrefetcher) => void,
): Promise<MatchdayBundle | null> => {
  const prefetcher = new MatchdayPrefetcher(ctx.footballData, {
    onProgress: onProgress === undefined ? undefined : () => onProgress(prefetcher),
  });
  const result = await prefetcher.run(fixtureId);
  if (!result.ok) return null;
  setCachedBundle(roomId, result.value);
  return result.value;
};

export const buildRoundDataContext = async (
  ctx: AppContext,
  roomId: RoomId,
  meta: RoomMeta,
  category: GameCategory | null,
): Promise<RoundDataContext> => {
  if (category === null) return EMPTY_DATA_CONTEXT;

  if (category === 'matchday') {
    if (meta.fixtureId === null) return EMPTY_DATA_CONTEXT;
    const cached = getCachedBundle(roomId);
    if (cached !== null) return bundleToContext(cached);
    const bundle = await runMatchdayPrefetch(ctx, roomId, meta.fixtureId);
    return bundle === null ? EMPTY_DATA_CONTEXT : bundleToContext(bundle);
  }

  const dataset = await ctx.generalDataset();
  return {
    fixture: null,
    lineups: null,
    live: null,
    teams: dataset.teams,
    players: dataset.players,
    profiles: dataset.profiles,
    seasonStats: dataset.seasonStats,
    quality: dataset.quality,
  };
};
