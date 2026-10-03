import type { ProjectedRound } from '@fdg/game-core';
import type { ClientRoom } from '@/lib/currentFixture';

/**
 * The contract every game screen is built against. Deliberately narrow: a screen only ever reads
 * the per-recipient `ProjectedRound`/`ProjectedRoom` the server already filtered (plus the API
 * layer's `currentFixture` "now playing" annotation, see `lib/currentFixture.ts`), and only ever
 * calls `onSubmit` with the raw answer payload — it never decides correctness, scoring or who
 * drinks. That stays true for every game added in Phase 5/6 as long as they register here the same
 * way.
 */
export interface GameScreenProps {
  readonly room: ClientRoom;
  readonly round: ProjectedRound;
  readonly now: number;
  readonly onSubmit: (payload: unknown) => void;
  /** Host only: tick a house cell the live feed cannot see (`HOST_MARK`). */
  readonly onHostMark?: (key: string) => void;
}
