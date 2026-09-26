/**
 * Core of the scheduled dataset sync (`src/scripts/sync-general-dataset.ts`), separated from the
 * process entrypoint so it can be tested without spawning anything or touching `process.exit`.
 *
 * Exit-code policy (returned, not applied here):
 *   0  the refresh built and stored a dataset, OR it was rejected as worse than a snapshot that is
 *      already stored (a no-op is fine - the good data stays).
 *   1  anything else: the build failed, the store write failed, or there is nothing stored to fall
 *      back on. A failed build with a snapshot still stored is deliberately exit 1 too, so the
 *      scheduled workflow goes red when the upstream sources break instead of silently going stale.
 */

import type {
  GeneralDataset,
  GeneralDatasetStore,
  RefreshableGeneralDatasetLoader,
} from '@fdg/football-data';

/** Message prefix `createGeneralDatasetLoader().refresh()` uses when it declines a worse build. */
export const REFRESH_REJECTED_PREFIX = 'General dataset refresh rejected';

export interface DatasetSyncDeps {
  readonly loader: Pick<RefreshableGeneralDatasetLoader, 'refresh'>;
  readonly store: Pick<GeneralDatasetStore, 'read'>;
  /** The array the loader's `onWarning` pushes into, so write failures (which the loader swallows) are visible here. */
  readonly warnings: readonly string[];
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface DatasetSyncOutcome {
  readonly exitCode: 0 | 1;
  readonly wrote: boolean;
  readonly summary: string;
}

const competitionsCovered = (dataset: GeneralDataset): number =>
  new Set(dataset.seasonStats.map((row) => row.competitionId)).size;

export const runDatasetSync = async (deps: DatasetSyncDeps): Promise<DatasetSyncOutcome> => {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const started = now();
  const seconds = (): string => `${((now() - started) / 1000).toFixed(1)}s`;
  const finish = (outcome: DatasetSyncOutcome): DatasetSyncOutcome => {
    log(outcome.summary);
    return outcome;
  };

  let result;
  try {
    result = await deps.loader.refresh();
  } catch (thrown) {
    return finish({
      exitCode: 1,
      wrote: false,
      summary: `[sync] FAILED after ${seconds()}: refresh threw: ${String(thrown)}`,
    });
  }

  if (result.ok) {
    const writeFailure = deps.warnings.find((warning) => warning.startsWith('Could not write'));
    if (writeFailure !== undefined) {
      return finish({
        exitCode: 1,
        wrote: false,
        summary: `[sync] FAILED after ${seconds()}: built ${result.value.players.length} players but ${writeFailure}`,
      });
    }
    const dataset = result.value;
    return finish({
      exitCode: 0,
      wrote: true,
      summary: `[sync] OK: wrote ${dataset.players.length} players, ${competitionsCovered(dataset)}/${dataset.competitions.length} competitions with stats, in ${seconds()}`,
    });
  }

  const message = result.error.message;
  if (message.startsWith(REFRESH_REJECTED_PREFIX)) {
    let stored = false;
    try {
      stored = (await deps.store.read()) !== null;
    } catch {
      stored = false;
    }
    if (stored) {
      return finish({
        exitCode: 0,
        wrote: false,
        summary: `[sync] no-op after ${seconds()}: ${message}; the stored snapshot was kept`,
      });
    }
    return finish({
      exitCode: 1,
      wrote: false,
      summary: `[sync] FAILED after ${seconds()}: ${message} and nothing is stored`,
    });
  }
  return finish({ exitCode: 1, wrote: false, summary: `[sync] FAILED after ${seconds()}: ${message}` });
};
