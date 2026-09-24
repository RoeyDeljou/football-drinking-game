import type { ProjectedRoom, ProjectedRound } from '@fdg/game-core';
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
  readonly room: ProjectedRoom;
  readonly now: number;
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const answeredCount = round.submissionStatus.filter((entry) => entry.submitted).length;
  const total = round.submissionStatus.length;
  const totalMs = round.answerWindowMs ?? 20_000;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-black">{title}</h1>
        <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-bold text-white/60">
          Round {round.index + 1} · {room.session?.roundsPlanned ?? '?'} planned
        </span>
      </div>
      {round.visibility === 'pre-reveal' ? <CountdownBar deadlineAt={round.deadlineAt} now={now} totalMs={totalMs} /> : null}
      {children}
      {round.visibility === 'pre-reveal' ? (
        <p className="text-center text-sm text-white/50" aria-live="polite">
          {answeredCount}/{total} answered
        </p>
      ) : null}
    </div>
  );
};
