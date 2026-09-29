import type { ProjectedPlayer } from '@fdg/game-core';
import { Card, Eyebrow } from './ui';

export const PlayerList = ({
  players,
  viewerId,
}: {
  readonly players: readonly ProjectedPlayer[];
  readonly viewerId: string | null;
}): React.JSX.Element => (
  <Card>
    <Eyebrow className="mb-3">Players ({players.filter((p) => !p.hasLeft).length})</Eyebrow>
    <ul className="flex flex-col gap-2">
      {players
        .filter((player) => !player.hasLeft)
        .map((player) => (
          <li
            key={player.id}
            className="flex items-center justify-between rounded-md bg-hover px-4 py-3 text-base"
          >
            <span className="flex min-w-0 items-center gap-2 font-semibold">
              <span
                className={`h-2.5 w-2.5 rounded-full ${player.connected ? 'bg-up' : 'bg-fg-subtle'}`}
                aria-hidden
              />
              {player.nickname}
              {player.id === viewerId ? ' (you)' : ''}
              {player.isHost ? ' 👑' : ''}
            </span>
            <span className="text-sm text-fg-muted">{!player.connected ? 'offline' : ''}</span>
          </li>
        ))}
    </ul>
  </Card>
);
