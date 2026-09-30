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
    <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-2">
      {players
        .filter((player) => !player.hasLeft)
        .map((player) => (
          <li
            key={player.id}
            className="flex min-h-12 flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-md bg-hover px-4 py-3 text-base"
          >
            <span className="flex max-w-full flex-1 basis-32 items-center gap-2 font-semibold">
              <span
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${player.connected ? 'bg-up' : 'bg-fg-subtle'}`}
                aria-hidden
              />
              {/* min-w-0 lets a long unbreakable nickname wrap inside the row instead of pushing the crown out. */}
              <span className="min-w-0 flex-1">
                {player.nickname}
                {player.id === viewerId ? ' (you)' : ''}
              </span>
              {player.isHost ? <span className="shrink-0">👑</span> : null}
            </span>
            <span className="shrink-0 text-sm text-fg-muted">{!player.connected ? 'offline' : ''}</span>
          </li>
        ))}
    </ul>
  </Card>
);
