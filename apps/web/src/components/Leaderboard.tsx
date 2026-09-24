import type { LeaderboardRow } from '@fdg/game-core';
import { Card } from './ui';

export const Leaderboard = ({
  rows,
  viewerId,
}: {
  readonly rows: readonly LeaderboardRow[];
  readonly viewerId: string | null;
}): React.JSX.Element => (
  <Card>
    <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-white/50">Leaderboard</h2>
    <ol className="flex flex-col gap-2">
      {rows.map((row) => (
        <li
          key={row.playerId}
          className={`flex items-center justify-between rounded-xl px-4 py-3 text-base ${
            row.playerId === viewerId ? 'bg-pitch-700/40 ring-1 ring-pitch-500' : 'bg-white/5'
          }`}
        >
          <span className="flex items-center gap-3 font-semibold">
            <span className="w-6 text-center text-white/50">{row.rank}</span>
            {row.nickname}
          </span>
          <span className="font-black tabular-nums">{row.score} pts</span>
        </li>
      ))}
      {rows.length === 0 ? <li className="text-sm text-white/50">No scores yet.</li> : null}
    </ol>
  </Card>
);
