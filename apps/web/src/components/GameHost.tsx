import { GAME_SCREENS } from '@/games/registry';
import type { ClientRoom } from '@/lib/currentFixture';
import { useNow } from '@/lib/useNow';
import { Banner, BigButton } from './ui';

export const GameHost = ({
  room,
  isHost,
  onSubmit,
  onAdvance,
  onRevealNow,
}: {
  readonly room: ClientRoom;
  readonly isHost: boolean;
  readonly onSubmit: (payload: unknown) => void;
  readonly onAdvance: () => void;
  readonly onRevealNow: () => void;
}): React.JSX.Element => {
  const now = useNow();
  const round = room.round;
  if (round === null) return <Banner>Waiting for the next round…</Banner>;

  const Screen = GAME_SCREENS[round.moduleId];
  if (Screen === undefined) {
    return <Banner tone="error">No screen registered for game {round.moduleId} yet.</Banner>;
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 lg:max-w-5xl lg:gap-6">
      {/* Keyed by round id: without this, a game screen's local state (M1's picks, M3's slider
          position, …) can survive React's reconciliation across rounds whenever consecutive rounds
          use the same module, silently leaking a stale pick/guess into the next round. */}
      <Screen key={round.id} room={room} round={round} now={now} onSubmit={onSubmit} />
      {/* Host / wait controls keep a thumb-sized measure however wide the game screen gets. */}
      <div className="mx-auto flex w-full max-w-md flex-col gap-4 empty:hidden">
        {isHost && round.visibility === 'pre-reveal' ? (
          <BigButton variant="ghost" onClick={onRevealNow}>
            Reveal now
          </BigButton>
        ) : null}
        {isHost && round.visibility === 'revealed' ? <BigButton onClick={onAdvance}>Continue</BigButton> : null}
        {!isHost && round.visibility === 'revealed' ? <Banner>Waiting for the host to continue…</Banner> : null}
      </div>
    </div>
  );
};
