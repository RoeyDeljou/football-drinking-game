import { choiceLabel } from '@/lib/gameMode';
import type { ClientRoom } from '@/lib/currentFixture';
import { Banner, BigButton } from './ui';
import { DrinkTally } from './DrinkTally';
import { GamePicker } from './GamePicker';
import { Leaderboard } from './Leaderboard';
import { NowPlayingBanner } from './NowPlayingBanner';

export const IntermissionScreen = ({
  room,
  category,
  isHost,
  onNextRound,
  onSelectGame,
  onPlayAgain,
  onFinishRoom,
}: {
  readonly room: ClientRoom;
  readonly category: 'matchday' | 'general' | null;
  readonly isHost: boolean;
  readonly onNextRound: () => void;
  readonly onSelectGame: (moduleId: string) => boolean;
  /** Starts a brand-new session from `intermission` (`SELECT_GAME` already dispatched, then
   * `START_SESSION` — never `START_LOADING`, which the engine only accepts from `'lobby'`). */
  readonly onPlayAgain: () => void;
  readonly onFinishRoom: () => void;
}): React.JSX.Element => {
  const sessionFinished = room.session?.finished ?? true;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 lg:max-w-5xl lg:gap-6">
      <h1 className="t-d1 text-center lg:text-[clamp(2.5rem,4vw,3.5rem)]">{sessionFinished ? 'Game over' : 'Leaderboard'}</h1>
      <NowPlayingBanner currentFixture={room.currentFixture} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start lg:gap-6 land:grid-cols-2">
        <Leaderboard rows={room.leaderboard} viewerId={room.viewerId} />
        <DrinkTally rows={room.drinkTally} viewerId={room.viewerId} />
      </div>

      <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      {!isHost ? (
        <Banner>{sessionFinished ? 'Waiting for the host to choose what’s next…' : 'Waiting for the host to continue…'}</Banner>
      ) : sessionFinished ? (
        <div className="flex flex-col gap-4">
          <GamePicker
            room={room}
            category={category}
            onSelectGame={onSelectGame}
            onStart={onPlayAgain}
            startLabel={room.selection === null ? 'Play again' : `Play ${choiceLabel(room.selection.moduleId)}`}
          />
          <BigButton variant="danger" onClick={onFinishRoom}>
            End room
          </BigButton>
        </div>
      ) : (
        <BigButton onClick={onNextRound}>Next round</BigButton>
      )}
      </div>
    </div>
  );
};
