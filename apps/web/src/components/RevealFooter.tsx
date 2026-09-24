import type { ProjectedRoom, ProjectedRoundRevealed } from '@fdg/game-core';
import { drinkAnnouncement } from '@/lib/drinkCopy';
import { nicknameOf } from '@/lib/roomHelpers';
import { Card } from './ui';

/** Shared reveal footer: who drinks, and why, rendered exclusively through `drinkCopy`. */
export const RevealFooter = ({
  round,
  room,
}: {
  readonly round: ProjectedRoundRevealed;
  readonly room: ProjectedRoom;
}): React.JSX.Element => {
  if (round.penalties.length === 0) {
    return (
      <Card>
        <p className="text-center text-sm text-white/60">Nobody drinks this round. Lucky table.</p>
      </Card>
    );
  }
  return (
    <Card>
      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-white/50">Who&apos;s drinking</h2>
      <ul className="flex flex-col gap-2">
        {round.penalties.map((penalty, index) => (
          <li
            key={`${penalty.reason}-${penalty.playerId}-${index}`}
            className="rounded-xl bg-amber-500/10 px-4 py-2 text-sm text-amber-200"
          >
            {drinkAnnouncement(penalty, nicknameOf(room, penalty.playerId))}
          </li>
        ))}
      </ul>
    </Card>
  );
};
