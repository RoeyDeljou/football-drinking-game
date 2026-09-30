import type { LeaderboardRow } from '@fdg/game-core';
import { Card, Eyebrow } from './ui';

export const Leaderboard = ({
  rows,
  viewerId,
}: {
  readonly rows: readonly LeaderboardRow[];
  readonly viewerId: string | null;
}): React.JSX.Element => (
  <Card>
    <Eyebrow className="mb-3">Leaderboard</Eyebrow>
    <ol className="flex flex-col gap-2">
      {rows.map((row) => (
        <li
          key={row.playerId}
          className={`flex min-h-12 flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-md px-4 py-3 text-base ${
            row.playerId === viewerId ? 'border-2 border-accent bg-selected' : 'border-2 border-transparent bg-hover'
          }`}
        >
          <span className="flex max-w-full flex-1 basis-32 flex-wrap items-baseline gap-x-3 font-semibold">
            <span className="w-6 shrink-0 text-center text-fg-muted">{row.rank}</span>
            <span className="max-w-full">{row.nickname}</span>
          </span>
          <span className="tnum ml-auto shrink-0 whitespace-nowrap font-black">{row.score} pts</span>
        </li>
      ))}
      {rows.length === 0 ? <li className="text-sm text-fg-muted">No scores yet.</li> : null}
    </ol>
  </Card>
);
