/**
 * Core of the scheduled dataset sync (`src/scripts/sync-general-dataset.ts`), separated from the
 * process entrypoint so it can be tested without spawning anything or touching `process.exit`.
 *
 * Exit-code policy (returned, not applied here), driven by the loader's typed `refreshDetailed()`:
 *   0  written, OR rejected as 'smaller' than a snapshot that is already stored (a no-op is fine).
 *   1  everything else, so the scheduled workflow goes red instead of silently going stale:
 *        - the store is unreachable / the table is missing (checked BEFORE the ~3 minute live build),
 *        - rejected 'partial' / 'empty' / 'build-failed' / 'baseline-unreadable',
 *        - rejected 'smaller' with nothing stored to fall back on,
 *        - the store write failed.
 */

import type {
  FlushableGeneralDatasetLoader,
  GeneralDataset,
  GeneralDatasetStore,
  RefreshableGeneralDatasetLoader,
} from '@fdg/football-data';

export interface DatasetSyncDeps {
  readonly loader: Pick<RefreshableGeneralDatasetLoader, 'refreshDetailed'> &
    Partial<Pick<FlushableGeneralDatasetLoader, 'flushWrites'>>;
  readonly store: Pick<GeneralDatasetStore, 'read'>;
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

/** Error text safe to print: connection strings (which embed the password) are masked. */
const describe = (thrown: unknown): string =>
  (thrown instanceof Error ? thrown.message : String(thrown)).replace(
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi,
    '<url redacted>',
  );

export const runDatasetSync = async (deps: DatasetSyncDeps): Promise<DatasetSyncOutcome> => {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const started = now();
  const seconds = (): string => `${((now() - started) / 1000).toFixed(1)}s`;
  const finish = (outcome: DatasetSyncOutcome): DatasetSyncOutcome => {
    log(outcome.summary);
    return outcome;
  };
  const failed = (message: string): DatasetSyncOutcome =>
    finish({ exitCode: 1, wrote: false, summary: `[sync] FAILED after ${seconds()}: ${message}` });

  // Fail fast: a bad DATABASE_URL or a missing table must not be discovered after a ~3 minute build.
  let stored: boolean;
  try {
    stored = (await deps.store.read()) !== null;
  } catch (thrown) {
    return failed(
      `cannot read the snapshot store before building (bad DATABASE_URL, database down, or the snapshot table is missing - run \`prisma migrate deploy\`): ${describe(thrown)}`,
    );
  }

  let result;
  try {
    result = await deps.loader.refreshDetailed();
  } catch (thrown) {
    return failed(`refresh threw: ${describe(thrown)}`);
  }
  try {
    await deps.loader.flushWrites?.();
  } catch {
    // flushWrites never rejects by contract; a broken fake must not change the outcome
  }

  switch (result.outcome) {
    case 'written':
      return finish({
        exitCode: 0,
        wrote: true,
        summary: `[sync] OK: wrote ${result.playerCount} players, ${competitionsCovered(result.dataset)}/${result.dataset.competitions.length} competitions with stats, in ${seconds()}`,
      });
    case 'write-failed':
      return failed(
        `built ${result.dataset.players.length} players but could not write them to the store: ${result.detail}`,
      );
    case 'rejected':
      if (result.reason === 'smaller') {
        if (stored) {
          return finish({
            exitCode: 0,
            wrote: false,
            summary: `[sync] no-op after ${seconds()}: rejected (smaller): ${result.detail}; the stored snapshot was kept`,
          });
        }
        return failed(`rejected (smaller): ${result.detail}, and nothing is stored`);
      }
      return failed(`rejected (${result.reason}): ${result.detail}`);
  }
};
