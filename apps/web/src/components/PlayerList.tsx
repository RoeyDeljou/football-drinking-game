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
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2 land:!grid-cols-1">
      {players
        .filter((player) => !player.hasLeft)
        .map((player) => (
          <li
            key={player.id}
            className="flex min-h-12 items-center justify-between gap-2 rounded-md bg-hover px-4 py-3 text-base"
          >
            <span className="flex min-w-0 items-center gap-2 font-semibold">
              <span
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${player.connected ? 'bg-up' : 'bg-fg-subtle'}`}
                aria-hidden
              />
              {player.nickname}
              {player.id === viewerId ? ' (you)' : ''}
              {player.isHost ? ' 👑' : ''}
            </span>
            <span className="shrink-0 text-sm text-fg-muted">{!player.connected ? 'offline' : ''}</span>
          </li>
        ))}
    </ul>
  </Card>
);
