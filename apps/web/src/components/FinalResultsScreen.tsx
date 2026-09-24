import type { ProjectedRoom } from '@fdg/game-core';
import { Banner, BigButton } from './ui';
import { DrinkTally } from './DrinkTally';
import { Leaderboard } from './Leaderboard';

const ABORT_COPY: Record<string, string> = {
  HOST_ABORTED: 'The host ended the room.',
  HOST_LEFT: 'The host left, so the room closed.',
  ALL_PLAYERS_LEFT: 'Everyone left.',
  DATA_UNAVAILABLE: 'The match data became unavailable.',
  TIMED_OUT: 'The room timed out.',
};

export const FinalResultsScreen = ({
  room,
  onLeave,
  onHostNew,
}: {
  readonly room: ProjectedRoom;
  readonly onLeave: () => void;
  /** Clears this room's stored session before navigating to `/host` — otherwise the next room's
   * join/resume logic would find this finished room's token still in `localStorage`. */
  readonly onHostNew: () => void;
}): React.JSX.Element => (
  <div className="flex flex-col gap-6">
    <h1 className="text-center text-3xl font-black">{room.phase === 'aborted' ? 'Room closed' : 'Final results'}</h1>
    {room.phase === 'aborted' && room.abortReason !== null ? (
      <Banner tone="warn">{ABORT_COPY[room.abortReason] ?? 'The room was closed.'}</Banner>
    ) : null}
    <Leaderboard rows={room.leaderboard} viewerId={room.viewerId} />
    <DrinkTally rows={room.drinkTally} viewerId={room.viewerId} />
    <div className="flex flex-col gap-3">
      <BigButton onClick={onHostNew}>Host a new room</BigButton>
      <BigButton variant="ghost" onClick={onLeave}>
        Back to start
      </BigButton>
    </div>
  </div>
);
