'use client';

import type { LoadingState } from '@fdg/game-core';
import { loadingElapsedMessage } from '@/lib/loadingCopy';
import { loadingElapsedPhase } from '@/lib/loadingElapsed';
import { useNow } from '@/lib/useNow';
import { Banner, BigButton, Card, Spinner } from './ui';

const STEP_LABEL: Record<string, string> = {
  fixture: 'Fixture',
  lineups: 'Lineups',
  squads: 'Squads',
  stats: 'Stats',
  dataset: 'Season data',
};

export const LoadingScreen = ({
  loading,
  isHost,
  onRetry,
}: {
  readonly loading: LoadingState;
  readonly isHost: boolean;
  readonly onRetry: () => void;
}): React.JSX.Element => {
  const now = useNow(1000);
  const failed = loading.steps.some((step) => step.status === 'failed');
  const allDone = loading.steps.every((step) => step.status === 'done');
  const elapsedPhase = loadingElapsedPhase({ startedAt: loading.startedAt, steps: loading.steps, now });
  const elapsedMessage = loadingElapsedMessage(elapsedPhase);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <h1 className="t-d1 mb-4 text-center">{allDone ? 'Ready!' : 'Getting the match ready…'}</h1>
        <ul className="flex flex-col gap-3">
          {loading.steps.map((step) => (
            <li key={step.key} className="flex items-center justify-between rounded-md bg-hover px-4 py-3">
              <span className="text-base font-bold">{STEP_LABEL[step.key] ?? step.key}</span>
              <span
                className={`text-sm font-bold ${
                  step.status === 'done'
                    ? 'text-up'
                    : step.status === 'failed'
                      ? 'text-down'
                      : step.status === 'active'
                        ? 'text-accent'
                        : 'text-fg-subtle'
                }`}
              >
                {step.status === 'done' ? '✓ done' : step.status === 'failed' ? '✗ failed' : step.status === 'active' ? 'loading…' : 'queued'}
              </span>
            </li>
          ))}
        </ul>
        {!failed && !allDone ? <Spinner label="Hang tight, almost there." /> : null}
      </Card>

      {!failed && elapsedMessage !== null ? (
        <div role="status" aria-live="polite">
          <Banner tone={elapsedPhase === 'longer' ? 'warn' : 'info'}>{elapsedMessage}</Banner>
        </div>
      ) : null}

      {loading.failedReason !== null ? <Banner tone="error">{loading.failedReason}</Banner> : null}
      {failed && !isHost ? <Banner tone="warn">Loading failed. Waiting for the host to retry.</Banner> : null}
      {failed && isHost ? (
        <BigButton variant="danger" onClick={onRetry}>
          Retry loading
        </BigButton>
      ) : null}
    </div>
  );
};
