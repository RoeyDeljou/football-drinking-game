/**
 * Runs the loading-screen side effects once `START_LOADING` is accepted: drives the real
 * `MatchdayPrefetcher` for a matchday room (dispatching `LOADING_PROGRESS`/`LOADING_FAILED` as
 * system actions per step), or simply awaits the (usually already-cached) general dataset.
 *
 * Never called from inside `dispatchAction` itself — loading is I/O, the reducer is not. Ordering
 * across the several `LOADING_PROGRESS` dispatches this module fires in quick succession is
 * guaranteed by `dispatchAction`'s own per-room queue (see `engine/dispatch.ts`), not by anything
 * in this file — dispatches are issued in call order and `dispatchAction` serializes them.
 */

import type { PrefetchStepStatus } from '@fdg/football-data';
import type { LoadingStepStatus, RoomId } from '@fdg/game-core';
import { activeSession } from '@fdg/game-core';
import type { AppContext } from '../context.js';
import { runGamedayPrefetch, runMatchdayPrefetch, runPoolPrefetch } from '../engine/data-context.js';
import { registry } from '../engine/deps.js';
import { dispatchAction } from '../engine/dispatch.js';
import { getScopedGeneralDataset } from '../engine/general-scope.js';
import type { RoomRecord } from '../rooms/store.js';
import { poolFixtureIds } from '../rooms/store.js';

const toLoadingStatus = (status: PrefetchStepStatus): LoadingStepStatus => {
  switch (status) {
    case 'running':
      return 'active';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'failed';
    case 'pending':
    default:
      return 'pending';
  }
};

/**
 * Per-room run token. Every `runLoadingPipeline` call takes a fresh token; `invalidateLoadingRun` (called when
 * `CANCEL_LOADING` is accepted) drops it. A run whose token is no longer current applies nothing more: no progress,
 * no failure. The engine already rejects progress for a room that is no longer `loading`, but a host can cancel and
 * immediately start loading again (same step keys), and then a stale run's progress would be accepted into the NEW
 * run's loading state. The token makes that impossible. In-flight provider calls cannot be aborted; their results
 * are simply ignored.
 */
const loadingRuns = new Map<RoomId, number>();
let nextRunToken = 1;

export const invalidateLoadingRun = (roomId: RoomId): void => {
  loadingRuns.delete(roomId);
};

export const runLoadingPipeline = async (
  ctx: AppContext,
  roomId: RoomId,
  onBroadcast: (record: RoomRecord) => void,
): Promise<void> => {
  const token = nextRunToken;
  nextRunToken += 1;
  loadingRuns.set(roomId, token);
  try {
    await runPipeline(ctx, roomId, onBroadcast, () => loadingRuns.get(roomId) === token);
  } finally {
    if (loadingRuns.get(roomId) === token) loadingRuns.delete(roomId);
  }
};

const runPipeline = async (
  ctx: AppContext,
  roomId: RoomId,
  onBroadcast: (record: RoomRecord) => void,
  isCurrent: () => boolean,
): Promise<void> => {
  const record = await ctx.roomStore.load(roomId);
  if (record === null || record.state.phase !== 'loading' || record.state.loading === null) return;

  const requestedKeys = new Set(record.state.loading.steps.map((step) => step.key));
  const selection = record.state.selection;
  const category =
    selection === null ? null : (registry.get(selection.moduleId)?.category ?? null);

  /** Tracks the most recently issued dispatch so callers can await the whole in-flight batch. */
  let lastDispatch: Promise<unknown> = Promise.resolve();

  // `onProgress` (passed to `runMatchdayPrefetch` below) calls this synchronously and does not
  // await it — only the *last* issued dispatch is awaited, via `lastDispatch`, once the prefetch
  // finishes. An earlier step's dispatch can therefore still be in flight (or already rejected)
  // when a later one overwrites `lastDispatch`, and nothing ever awaits it directly — so a
  // rejection here must be caught inside the task itself, or it becomes an unhandled rejection no
  // caller can ever catch. It's logged and swallowed, not re-thrown: a progress-broadcast failure
  // for one step must not abort the whole pipeline (the pipeline's real success/failure is decided
  // by the prefetch's own result, not by whether every progress tick was broadcast).
  const dispatchProgress = (stepKey: string, status: LoadingStepStatus, detail: string | null): Promise<void> => {
    if (!requestedKeys.has(stepKey) || !isCurrent()) return Promise.resolve();
    const task = (async (): Promise<void> => {
      try {
        const outcome = await dispatchAction(ctx, roomId, { type: 'LOADING_PROGRESS', stepKey, status, detail });
        if (outcome !== null && outcome.changed) onBroadcast(outcome.record);
      } catch (error) {
        console.error(`[loading] LOADING_PROGRESS dispatch failed for room=${roomId} step=${stepKey}:`, error);
      }
    })();
    lastDispatch = task;
    return task;
  };

  if (category === 'matchday') {
    const gamedayCompetitionId = record.meta.gamedayCompetitionId ?? null;

    // Explicit multi-fixture pool: same aggregated four-step progress as gameday, over the host's chosen fixtures.
    const pool = poolFixtureIds(record.meta);
    if (pool !== null) {
      const bundle = await runPoolPrefetch(ctx, roomId, pool, (steps) => {
        for (const step of steps) {
          void dispatchProgress(step.id, toLoadingStatus(step.status), step.notes[0] ?? null);
        }
      });
      await lastDispatch;
      if (bundle === null || bundle.fixtures.length === 0) {
        if (isCurrent()) await dispatchFailure(ctx, roomId, 'Could not load any of the selected fixtures.', onBroadcast);
      }
      return;
    }

    if (gamedayCompetitionId !== null) {
      // Same four step keys (`fixture`/`lineups`/`squads`/`stats`, `MATCHDAY_STEP_KEYS` in
      // apps/web) as the single-fixture flow — `runGamedayPrefetch` aggregates progress across
      // every live fixture's own pipeline into that same shape, so the loading screen renders
      // identically regardless of which flow is actually running underneath.
      const bundle = await runGamedayPrefetch(ctx, roomId, gamedayCompetitionId, (steps) => {
        for (const step of steps) {
          void dispatchProgress(step.id, toLoadingStatus(step.status), step.notes[0] ?? null);
        }
      });
      await lastDispatch;
      if (bundle === null || bundle.fixtures.length === 0) {
        if (isCurrent()) await dispatchFailure(ctx, roomId, 'Could not load any live fixture for this competition.', onBroadcast);
      }
      return;
    }

    if (record.meta.fixtureId === null) {
      if (isCurrent()) await dispatchFailure(ctx, roomId, 'No fixture selected for this matchday room.', onBroadcast);
      return;
    }
    const bundle = await runMatchdayPrefetch(ctx, roomId, record.meta.fixtureId, (prefetcher) => {
      const progress = prefetcher.progress();
      for (const step of progress.steps) {
        void dispatchProgress(step.id, toLoadingStatus(step.status), step.notes[0] ?? null);
      }
    });
    await lastDispatch;
    if (bundle === null) {
      if (isCurrent()) await dispatchFailure(ctx, roomId, 'Could not load the fixture for this room.', onBroadcast);
    }
    return;
  }

  if (category === 'general') {
    for (const stepKey of requestedKeys) {
      await dispatchProgress(stepKey, 'active', null);
    }
    const fullDataset = await ctx.generalDataset();
    const generalCompetitionId = record.meta.generalCompetitionId ?? null;
    const dataset = generalCompetitionId === null ? fullDataset : getScopedGeneralDataset(fullDataset, generalCompetitionId);
    const status: LoadingStepStatus = dataset.players.length === 0 ? 'failed' : 'done';
    for (const stepKey of requestedKeys) {
      await dispatchProgress(stepKey, status, null);
    }
    return;
  }

  // No selection/category resolvable — nothing to load; mark every requested step done so a
  // no-data game (if one is ever added) is not stuck forever.
  for (const stepKey of requestedKeys) {
    await dispatchProgress(stepKey, 'done', null);
  }
};

const dispatchFailure = async (
  ctx: AppContext,
  roomId: RoomId,
  reason: string,
  onBroadcast: (record: RoomRecord) => void,
): Promise<void> => {
  const outcome = await dispatchAction(ctx, roomId, { type: 'LOADING_FAILED', reason });
  if (outcome !== null && outcome.changed) onBroadcast(outcome.record);
};

export const isSessionCategory = (record: RoomRecord): string | null => {
  const session = activeSession(record.state);
  return session?.category ?? null;
};
