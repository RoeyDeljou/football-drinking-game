import type { ProjectedRoom } from '@fdg/game-core';
import { GAME_CATALOG } from '@/games/registry';
import { BigButton, Card } from './ui';

export const GamePicker = ({
  room,
  category,
  onSelectGame,
  onStart,
  startLabel,
  startDisabled = false,
}: {
  readonly room: ProjectedRoom;
  readonly category: 'matchday' | 'general' | null;
  readonly onSelectGame: (moduleId: string) => void;
  readonly onStart: () => void;
  readonly startLabel: string;
  readonly startDisabled?: boolean;
}): React.JSX.Element => {
  const games = category === null ? GAME_CATALOG : GAME_CATALOG.filter((game) => game.category === category);
  return (
    <Card>
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-white/50">Pick a game</h2>
      <div className="flex flex-col gap-3">
        {games.map((game) => (
          <button
            key={game.id}
            type="button"
            onClick={() => onSelectGame(game.id)}
            className={`tap-target rounded-2xl border-2 px-4 py-3 text-left transition-colors ${
              room.selection?.moduleId === game.id ? 'border-pitch-500 bg-pitch-500/20' : 'border-white/15 bg-white/5'
            }`}
          >
            <p className="font-bold">{game.name}</p>
            <p className="text-xs text-white/50">{game.blurb}</p>
          </button>
        ))}
      </div>
      <BigButton className="mt-4" disabled={room.selection === null || startDisabled} onClick={onStart}>
        {room.selection === null ? 'Select a game first' : startLabel}
      </BigButton>
    </Card>
  );
};
