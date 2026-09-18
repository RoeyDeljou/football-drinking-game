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
import { runMatchdayPrefetch } from '../engine/data-context.js';
import { registry } from '../engine/deps.js';
import { dispatchAction } from '../engine/dispatch.js';
import type { RoomRecord } from '../rooms/store.js';

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

export const runLoadingPipeline = async (
  ctx: AppContext,
  roomId: RoomId,
  onBroadcast: (record: RoomRecord) => void,
): Promise<void> => {
  const record = await ctx.roomStore.load(roomId);
  if (record === null || record.state.phase !== 'loading' || record.state.loading === null) return;

  const requestedKeys = new Set(record.state.loading.steps.map((step) => step.key));
  const selection = record.state.selection;
  const category =
    selection === null ? null : (registry.get(selection.moduleId)?.category ?? null);

  /** Tracks the most recently issued dispatch so callers can await the whole in-flight batch. */
  let lastDispatch: Promise<unknown> = Promise.resolve();

  const dispatchProgress = (stepKey: string, status: LoadingStepStatus, detail: string | null): Promise<void> => {
    if (!requestedKeys.has(stepKey)) return Promise.resolve();
    const task = (async (): Promise<void> => {
      const outcome = await dispatchAction(ctx, roomId, { type: 'LOADING_PROGRESS', stepKey, status, detail });
      if (outcome !== null && outcome.changed) onBroadcast(outcome.record);
    })();
    lastDispatch = task;
    return task;
  };

  if (category === 'matchday') {
    if (record.meta.fixtureId === null) {
      await dispatchFailure(ctx, roomId, 'No fixture selected for this matchday room.', onBroadcast);
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
      await dispatchFailure(ctx, roomId, 'Could not load the fixture for this room.', onBroadcast);
    }
    return;
  }

  if (category === 'general') {
    for (const stepKey of requestedKeys) {
      await dispatchProgress(stepKey, 'active', null);
    }
    const dataset = await ctx.generalDataset();
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
