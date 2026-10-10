/**
 * Tiny in-memory TTL cache for `getFixturesByCompetition` calls, keyed by competition id.
 *
 * Fixture lists change slowly outside matchday: caching a *success* for a short TTL keeps the
 * "pick a fixture" endpoint fast and off the provider's free-tier rate limit without any of the
 * snapshot/Postgres machinery `GeneralDataset` needed (that was justified by a ~3 minute build; a
 * fixture list call is a single, fast provider request). A failure is never cached — a transient
 * upstream blip should not make every request in the TTL window fail too, it should just retry.
 */

import type { CompetitionId, Fixture } from '@fdg/football-data';
import type { DataResult } from '@fdg/football-data';

export interface FixtureListCache {
  /** Returns the cached result if still fresh, otherwise calls `load` and caches a success. */
  get(
    key: CompetitionId | string,
    load: () => Promise<DataResult<readonly Fixture[]>>,
    /** Per-call TTL override (the live list uses a much shorter one than the 14-day list). */
    ttlMs?: number,
  ): Promise<DataResult<readonly Fixture[]>>;
}

export interface FixtureListCacheOptions {
  /** Default 90s: comfortably inside the 60-120s range a slow-moving fixture list tolerates. */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export const DEFAULT_FIXTURE_LIST_TTL_MS = 90_000;

export const createFixtureListCache = (options: FixtureListCacheOptions = {}): FixtureListCache => {
  const ttlMs = options.ttlMs ?? DEFAULT_FIXTURE_LIST_TTL_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { readonly expiresAt: number; readonly result: DataResult<readonly Fixture[]> }>();

  return {
    get: async (key, load, ttlOverrideMs) => {
      const cached = entries.get(key);
      if (cached !== undefined && cached.expiresAt > now()) return cached.result;
      const result = await load();
      if (result.ok) entries.set(key, { expiresAt: now() + (ttlOverrideMs ?? ttlMs), result });
      return result;
    },
  };
};
