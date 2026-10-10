/**
 * The fixture's status (`SCHEDULED` .. `FINISHED`, `POSTPONED`, `CANCELLED`) for a matchday room, so a client can hide
 * live-only games once the match is over.
 *
 * Two entry points, for single-fixture matchday rooms (`meta.fixtureId`) and multi-fixture pools (`meta.fixtureIds`):
 *
 * - `syncFixtureStatus` is cache-only and synchronous (used for the per-recipient socket payload, which is built
 *   without awaiting anything): the live-ingestion loop's latest observed status, else the status of the fixture in the
 *   room's prefetched matchday bundle (static since prefetch, so best-effort), else `null`.
 * - `resolveFixtureStatus` is for REST: a fresh (<60s) ingestion observation, else one provider `getFixture` lookup
 *   (the provider's own cache applies; plus a 15s coalescing memo here), bounded by a timeout. Never blocks on a slow
 *   upstream: timeout, error, unknown fixture -> `null`.
 *
 * Pools combine their members (`combineFixtureStatuses`): `LIVE` if any member is live (in play); `FINISHED` only when
 * every member is finished (or cancelled); otherwise the status of the earliest-kickoff member that is not yet
 * finished. If any member's status is unknown and none is live, `null` (never claim FINISHED on partial knowledge).
 *
 * Gameday rooms return `null`: they rotate across several fixtures, so there is no single room-level status. The
 * per-round fixture is in the existing `currentFixture` annotation.
 */

import type { FixtureId, FixtureStatus } from '@fdg/football-data';
import { isLiveFixtureStatus } from '@fdg/football-data';
import type { RoomId } from '@fdg/game-core';
import type { AppContext } from '../context.js';
import type { RoomMeta } from '../rooms/store.js';
import { poolFixtureIds } from '../rooms/store.js';
import { getCachedGameday } from './gameday-cache.js';
import { getCachedBundle } from './matchday-cache.js';

export const FIXTURE_STATUS_TIMEOUT_MS = 1500;
const FRESH_OBSERVATION_MS = 60_000;
const MEMO_TTL_MS = 15_000;

interface MemoEntry {
  readonly at: number;
  readonly promise: Promise<StatusPart>;
}
const memos = new WeakMap<object, Map<FixtureId, MemoEntry>>();

export interface StatusPart {
  readonly status: FixtureStatus | null;
  /** ISO kickoff when known, to order members. */
  readonly kickoff: string | null;
}

/** See the file doc: LIVE if any live; FINISHED only if all done; else the earliest not-finished member's status. */
export const combineFixtureStatuses = (parts: readonly StatusPart[]): FixtureStatus | null => {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]?.status ?? null; // a single fixture reports its own exact status
  if (parts.some((part) => part.status !== null && isLiveFixtureStatus(part.status))) return 'LIVE';
  if (parts.some((part) => part.status === null)) return null;
  const done = (status: FixtureStatus | null): boolean => status === 'FINISHED' || status === 'CANCELLED';
  if (parts.every((part) => done(part.status))) {
    return parts.some((part) => part.status === 'FINISHED') ? 'FINISHED' : 'CANCELLED';
  }
  const open = parts
    .filter((part) => !done(part.status))
    .sort((a, b) => (a.kickoff ?? '9999').localeCompare(b.kickoff ?? '9999'));
  return open[0]?.status ?? null;
};

export const syncFixtureStatus = (ctx: AppContext, roomId: RoomId, meta: RoomMeta): FixtureStatus | null => {
  const pool = poolFixtureIds(meta);
  if (pool !== null) {
    const bundles = getCachedGameday(roomId)?.bundle.fixtures ?? [];
    return combineFixtureStatuses(
      pool.map((id) => {
        const bundle = bundles.find((candidate) => candidate.fixture.id === id)?.fixture ?? null;
        const observed = ctx.liveIngestion?.latestStatus(id) ?? null;
        return { status: observed?.status ?? bundle?.status ?? null, kickoff: bundle?.kickoff ?? null };
      }),
    );
  }
  if ((meta.gamedayCompetitionId ?? null) !== null || meta.fixtureId === null) return null;
  const observed = ctx.liveIngestion?.latestStatus(meta.fixtureId) ?? null;
  if (observed !== null) return observed.status;
  return getCachedBundle(roomId)?.fixture.status ?? null;
};

const lookup = (ctx: AppContext, fixtureId: FixtureId): Promise<StatusPart> => {
  let byFixture = memos.get(ctx.footballData);
  if (byFixture === undefined) {
    byFixture = new Map();
    memos.set(ctx.footballData, byFixture);
  }
  const existing = byFixture.get(fixtureId);
  if (existing !== undefined && Date.now() - existing.at < MEMO_TTL_MS) return existing.promise;
  const promise = (async (): Promise<StatusPart> => {
    try {
      const result = await ctx.footballData.getFixture(fixtureId);
      return result.ok && result.value !== null
        ? { status: result.value.status, kickoff: result.value.kickoff }
        : { status: null, kickoff: null };
    } catch {
      return { status: null, kickoff: null };
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
  const pool = poolFixtureIds(meta);
  const ids = pool ?? (meta.fixtureId === null || (meta.gamedayCompetitionId ?? null) !== null ? [] : [meta.fixtureId]);
  if (ids.length === 0) return null;

  const part = async (fixtureId: FixtureId): Promise<StatusPart> => {
    const observed = ctx.liveIngestion?.latestStatus(fixtureId) ?? null;
    if (observed !== null && Date.now() - observed.observedAt < FRESH_OBSERVATION_MS && pool === null) {
      return { status: observed.status, kickoff: null };
    }
    return lookup(ctx, fixtureId);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  try {
    const parts = await Promise.race([Promise.all(ids.map(part)), timeout]);
    return parts === null ? null : combineFixtureStatuses(parts);
  } finally {
    clearTimeout(timer);
  }
};
