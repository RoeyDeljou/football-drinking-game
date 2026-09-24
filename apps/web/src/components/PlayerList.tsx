import type { ProjectedPlayer } from '@fdg/game-core';
import { Card } from './ui';

export const PlayerList = ({
  players,
  viewerId,
}: {
  readonly players: readonly ProjectedPlayer[];
  readonly viewerId: string | null;
}): React.JSX.Element => (
  <Card>
    <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-white/50">
      Players ({players.filter((p) => !p.hasLeft).length})
    </h2>
    <ul className="flex flex-col gap-2">
      {players
        .filter((player) => !player.hasLeft)
        .map((player) => (
          <li
            key={player.id}
            className="flex items-center justify-between rounded-xl bg-white/5 px-4 py-3 text-base"
          >
            <span className="flex items-center gap-2 font-semibold">
              <span
                className={`h-2.5 w-2.5 rounded-full ${player.connected ? 'bg-pitch-500' : 'bg-white/30'}`}
                aria-hidden
              />
              {player.nickname}
              {player.id === viewerId ? ' (you)' : ''}
              {player.isHost ? ' 👑' : ''}
            </span>
            <span className="text-sm text-white/60">{!player.connected ? 'offline' : ''}</span>
          </li>
        ))}
    </ul>
  </Card>
);
