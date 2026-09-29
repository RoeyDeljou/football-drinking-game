/**
 * "Now playing" indicator for a matchday round — which real fixture the current round's content
 * came from. Renders nothing for a general room, or before the room's matchday data has been
 * prefetched (`currentFixture === null`, see `lib/currentFixture.ts`). Shared by every screen a
 * matchday round can be on (`RoundShell`, used by every game screen; `IntermissionScreen`) so it's
 * added once rather than per-game-screen.
 */

import type { CurrentFixtureSummary } from '@/lib/currentFixture';
import { nowPlayingLabel } from '@/lib/currentFixture';

export const NowPlayingBanner = ({
  currentFixture,
}: {
  readonly currentFixture: CurrentFixtureSummary | null;
}): React.JSX.Element | null => {
  const label = nowPlayingLabel(currentFixture);
  if (label === null || currentFixture === null) return null;

  return (
    <div className="flex items-center justify-center gap-2 rounded-md bg-card px-3 py-2 shadow-[var(--edge-hairline)] text-center">
      {currentFixture.homeTeam.crestUrl !== null ? (
        <img src={currentFixture.homeTeam.crestUrl} alt="" className="h-5 w-5 object-contain" />
      ) : null}
      <div className="flex flex-col leading-tight">
        <span className="t-eyebrow">
          Now playing: <span className="text-fg">{label.primary}</span>
        </span>
        {label.secondary !== null ? <span className="text-[11px] text-fg-subtle">{label.secondary}</span> : null}
      </div>
      {currentFixture.awayTeam.crestUrl !== null ? (
        <img src={currentFixture.awayTeam.crestUrl} alt="" className="h-5 w-5 object-contain" />
      ) : null}
    </div>
  );
};
