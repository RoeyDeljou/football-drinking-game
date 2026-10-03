/**
 * Which matchday games need the match to be live, and what to do with them once it is not.
 * M1 (markets), M4 to M9 wait on live events or stats; M2, M3 and M10 only need lineups.
 */

export const LIVE_ONLY_GAME_IDS: ReadonlySet<string> = new Set(['M1', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9']);

export type LiveGameAvailability = 'available' | 'hidden' | 'greyed';

/** FINISHED / CANCELLED hide live-only games; POSTPONED greys them out; anything else leaves them be. */
export const liveGameAvailability = (fixtureStatus: string | null | undefined): LiveGameAvailability => {
  if (fixtureStatus === 'FINISHED' || fixtureStatus === 'CANCELLED') return 'hidden';
  if (fixtureStatus === 'POSTPONED') return 'greyed';
  return 'available';
};

export const liveGamesNote = (fixtureStatus: string | null | undefined): string | null => {
  switch (liveGameAvailability(fixtureStatus)) {
    case 'hidden':
      return fixtureStatus === 'CANCELLED'
        ? 'This match was cancelled, so the live games are hidden.'
        : 'This match has finished, so the live games are hidden.';
    case 'greyed':
      return 'This match is postponed. Live games are greyed out until it kicks off.';
    default:
      return null;
  }
};
