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
  split = false,
  countdown = true,
}: {
  readonly title: string;
  readonly round: ProjectedRound;
  readonly room: ClientRoom;
  readonly now: number;
  readonly children: React.ReactNode;
  /** Reveal screens: lay two blocks side by side from 1024px / on a landscape phone. */
  readonly split?: boolean;
  /** Set false when the game shows its own clock state (M7 after the pick window closes). */
  readonly countdown?: boolean;
}): React.JSX.Element => {
  const answeredCount = round.submissionStatus.filter((entry) => entry.submitted).length;
  const total = round.submissionStatus.length;
  const totalMs = round.answerWindowMs ?? 20_000;

  return (
    <div className="flex flex-col gap-4">
      <NowPlayingBanner currentFixture={room.currentFixture} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="t-d1 max-w-full flex-1 basis-40">{title}</h1>
        <span className="shrink-0 rounded-full border border-border px-3 py-1 text-xs font-bold text-fg-muted">
          Round {round.index + 1} · {room.session?.roundsPlanned ?? '?'} planned
        </span>
      </div>
      {round.visibility === 'pre-reveal' && countdown ? <CountdownBar deadlineAt={round.deadlineAt} now={now} totalMs={totalMs} /> : null}
      <div
        className={
          split
            ? 'split-cols gap-4 lg:items-start lg:gap-6 land:items-start'
            : 'flex flex-col gap-4 lg:gap-6'
        }
      >
        {children}
      </div>
      {round.visibility === 'pre-reveal' ? (
        <p className="tnum text-center text-sm text-fg-muted" aria-live="polite">
          {answeredCount}/{total} answered
        </p>
      ) : null}
    </div>
  );
};
