import type { ProjectedRoom } from '@fdg/game-core';
import { gameName } from '@/games/registry';
import { Banner, BigButton } from './ui';
import { DrinkTally } from './DrinkTally';
import { GamePicker } from './GamePicker';
import { Leaderboard } from './Leaderboard';

export const IntermissionScreen = ({
  room,
  category,
  isHost,
  onNextRound,
  onSelectGame,
  onPlayAgain,
  onFinishRoom,
}: {
  readonly room: ProjectedRoom;
  readonly category: 'matchday' | 'general' | null;
  readonly isHost: boolean;
  readonly onNextRound: () => void;
  readonly onSelectGame: (moduleId: string) => void;
  /** Starts a brand-new session from `intermission` (`SELECT_GAME` already dispatched, then
   * `START_SESSION` — never `START_LOADING`, which the engine only accepts from `'lobby'`). */
  readonly onPlayAgain: () => void;
  readonly onFinishRoom: () => void;
}): React.JSX.Element => {
  const sessionFinished = room.session?.finished ?? true;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-center text-3xl font-black">{sessionFinished ? 'Game over' : 'Leaderboard'}</h1>
      <Leaderboard rows={room.leaderboard} viewerId={room.viewerId} />
      <DrinkTally rows={room.drinkTally} viewerId={room.viewerId} />

      {!isHost ? (
        <Banner>{sessionFinished ? 'Waiting for the host to choose what’s next…' : 'Waiting for the host to continue…'}</Banner>
      ) : sessionFinished ? (
        <div className="flex flex-col gap-4">
          <GamePicker
            room={room}
            category={category}
            onSelectGame={onSelectGame}
            onStart={onPlayAgain}
            startLabel={room.selection === null ? 'Play again' : `Play ${gameName(room.selection.moduleId)}`}
          />
          <BigButton variant="danger" onClick={onFinishRoom}>
            End room
          </BigButton>
        </div>
      ) : (
        <BigButton onClick={onNextRound}>Next round</BigButton>
      )}
    </div>
  );
};
