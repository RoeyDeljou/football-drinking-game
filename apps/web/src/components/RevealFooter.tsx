import type { ProjectedRoom, ProjectedRoundRevealed } from '@fdg/game-core';
import { drinkAnnouncement } from '@/lib/drinkCopy';
import { nicknameOf } from '@/lib/roomHelpers';
import { Card, Eyebrow } from './ui';

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
        <p className="t-body text-center text-fg-muted">Nobody drinks this round. Lucky table.</p>
      </Card>
    );
  }
  return (
    <Card>
      <Eyebrow className="mb-2">Who&apos;s drinking</Eyebrow>
      <ul className="flex flex-col gap-2">
        {round.penalties.map((penalty, index) => (
          <li
            key={`${penalty.reason}-${penalty.playerId}-${index}`}
            className="rounded-md border-2 border-accent/50 bg-selected px-4 py-3 text-base font-semibold text-fg"
          >
            {drinkAnnouncement(penalty, nicknameOf(room, penalty.playerId))}
          </li>
        ))}
      </ul>
    </Card>
  );
};
