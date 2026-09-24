import type { ProjectedRoom, ProjectedRound } from '@fdg/game-core';

/**
 * The contract every game screen is built against. Deliberately narrow: a screen only ever reads
 * the per-recipient `ProjectedRound`/`ProjectedRoom` the server already filtered, and only ever
 * calls `onSubmit` with the raw answer payload — it never decides correctness, scoring or who
 * drinks. That stays true for every game added in Phase 5/6 as long as they register here the same
 * way.
 */
export interface GameScreenProps {
  readonly room: ProjectedRoom;
  readonly round: ProjectedRound;
  readonly now: number;
  readonly onSubmit: (payload: unknown) => void;
}
