/**
 * Renders a `G-MIX`/`M-MIX` round by delegating to whichever sub-game produced it. The inner screen
 * component (G1, G3, G6, M2, M3, …) is looked up from `GAME_SCREENS` by moduleId and rendered with the
 * round unwrapped to that sub-game's own real shape — it has zero knowledge that it might be running
 * inside a rotation. `onSubmit` is forwarded untouched: Mixed submissions are never wrapped.
 */
import { GAME_SCREENS, gameName } from './registry';
import type { GameScreenProps } from './types';
import { unwrapMixedRound } from './mixedAdapter';

export const MixedGameScreen = (props: GameScreenProps): React.JSX.Element => {
  const { moduleId, round } = unwrapMixedRound(props.round);
  const InnerScreen = GAME_SCREENS[moduleId];

  if (InnerScreen === undefined) {
    return (
      <p className="t-sm text-center text-fg-muted">
        This round picked an unsupported game ({moduleId}). It should resolve on its own shortly.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="t-eyebrow text-center text-accent">
        Now playing: {gameName(moduleId)}
      </p>
      <InnerScreen {...props} round={round} />
    </div>
  );
};
