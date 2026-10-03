/**
 * The fixture's status (`SCHEDULED` .. `FINISHED`, `POSTPONED`, `CANCELLED`) for a matchday room, so a client can hide
 * live-only games once the match is over.
 *
 * Two entry points, both for single-fixture matchday rooms only (`meta.fixtureId`):
 *
 * - `syncFixtureStatus` is cache-only and synchronous (used for the per-recipient socket payload, which is built
 *   without awaiting anything): the live-ingestion loop's latest observed status, else the status of the fixture in the
 *   room's prefetched matchday bundle (static since prefetch, so best-effort), else `null`.
 * - `resolveFixtureStatus` is for REST: a fresh (<60s) ingestion observation, else one provider `getFixture` lookup
 *   (the provider's own cache applies; plus a 15s coalescing memo here), bounded by a timeout. Never blocks on a slow
 *   upstream: timeout, error, unknown fixture -> `null`.
 *
 * Gameday rooms return `null`: they rotate across several fixtures, so there is no single room-level status. The
 * per-round fixture is in the existing `currentFixture` annotation.
 */

import type { FixtureId, FixtureStatus } from '@fdg/football-data';
import type { RoomId } from '@fdg/game-core';
import type { AppContext } from '../context.js';
import type { RoomMeta } from '../rooms/store.js';
import { getCachedBundle } from './matchday-cache.js';

export const FIXTURE_STATUS_TIMEOUT_MS = 1500;
const FRESH_OBSERVATION_MS = 60_000;
const MEMO_TTL_MS = 15_000;

interface MemoEntry {
  readonly at: number;
  readonly promise: Promise<FixtureStatus | null>;
}
const memos = new WeakMap<object, Map<FixtureId, MemoEntry>>();

export const syncFixtureStatus = (ctx: AppContext, roomId: RoomId, meta: RoomMeta): FixtureStatus | null => {
  if ((meta.gamedayCompetitionId ?? null) !== null || meta.fixtureId === null) return null;
  const observed = ctx.liveIngestion?.latestStatus(meta.fixtureId) ?? null;
  if (observed !== null) return observed.status;
  return getCachedBundle(roomId)?.fixture.status ?? null;
};

const lookup = (ctx: AppContext, fixtureId: FixtureId): Promise<FixtureStatus | null> => {
  let byFixture = memos.get(ctx.footballData);
  if (byFixture === undefined) {
    byFixture = new Map();
    memos.set(ctx.footballData, byFixture);
  }
  const existing = byFixture.get(fixtureId);
  if (existing !== undefined && Date.now() - existing.at < MEMO_TTL_MS) return existing.promise;
  const promise = (async (): Promise<FixtureStatus | null> => {
    try {
      const result = await ctx.footballData.getFixture(fixtureId);
      return result.ok && result.value !== null ? result.value.status : null;
    } catch {
      return null;
    }
  })();
  byFixture.set(fixtureId, { at: Date.now(), promise });
  return promise;
};

export const resolveFixtureStatus = async (
  ctx: AppContext,
  meta: RoomMeta,
  timeoutMs: number = FIXTURE_STATUS_TIMEOUT_MS,
): Promise<FixtureStatus | null> => {
  if ((meta.gamedayCompetitionId ?? null) !== null || meta.fixtureId === null) return null;
  const observed = ctx.liveIngestion?.latestStatus(meta.fixtureId) ?? null;
  if (observed !== null && Date.now() - observed.observedAt < FRESH_OBSERVATION_MS) return observed.status;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([lookup(ctx, meta.fixtureId), timeout]);
  } finally {
    clearTimeout(timer);
  }
};
