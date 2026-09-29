import type { ProjectedRound } from '@fdg/game-core';
import type { ClientRoom } from '@/lib/currentFixture';
import { NowPlayingBanner } from './NowPlayingBanner';
import { CountdownBar } from './ui';

export const RoundShell = ({
  title,
  round,
  room,
  now,
  children,
}: {
  readonly title: string;
  readonly round: ProjectedRound;
  readonly room: ClientRoom;
  readonly now: number;
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const answeredCount = round.submissionStatus.filter((entry) => entry.submitted).length;
  const total = round.submissionStatus.length;
  const totalMs = round.answerWindowMs ?? 20_000;

  return (
    <div className="flex flex-col gap-4">
      <NowPlayingBanner currentFixture={room.currentFixture} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="t-d1 min-w-0">{title}</h1>
        <span className="rounded-full border border-border px-3 py-1 text-xs font-bold text-fg-muted">
          Round {round.index + 1} · {room.session?.roundsPlanned ?? '?'} planned
        </span>
      </div>
      {round.visibility === 'pre-reveal' ? <CountdownBar deadlineAt={round.deadlineAt} now={now} totalMs={totalMs} /> : null}
      {children}
      {round.visibility === 'pre-reveal' ? (
        <p className="tnum text-center text-sm text-fg-muted" aria-live="polite">
          {answeredCount}/{total} answered
        </p>
      ) : null}
    </div>
  );
};
