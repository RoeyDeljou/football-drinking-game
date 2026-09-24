import type { LoadingState } from '@fdg/game-core';
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
  const failed = loading.steps.some((step) => step.status === 'failed');
  const allDone = loading.steps.every((step) => step.status === 'done');

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <h1 className="mb-4 text-center text-2xl font-black">{allDone ? 'Ready!' : 'Getting the match ready…'}</h1>
        <ul className="flex flex-col gap-3">
          {loading.steps.map((step) => (
            <li key={step.key} className="flex items-center justify-between rounded-xl bg-white/5 px-4 py-3">
              <span className="font-semibold">{STEP_LABEL[step.key] ?? step.key}</span>
              <span
                className={`text-sm font-bold ${
                  step.status === 'done'
                    ? 'text-pitch-400'
                    : step.status === 'failed'
                      ? 'text-red-400'
                      : step.status === 'active'
                        ? 'text-amber-300'
                        : 'text-white/40'
                }`}
              >
                {step.status === 'done' ? '✓ done' : step.status === 'failed' ? '✗ failed' : step.status === 'active' ? 'loading…' : 'queued'}
              </span>
            </li>
          ))}
        </ul>
        {!failed && !allDone ? <Spinner label="Hang tight, almost there." /> : null}
      </Card>

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
