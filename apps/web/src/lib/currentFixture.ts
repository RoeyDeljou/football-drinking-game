/**
 * Client-side mirror of the "now playing" annotation the server attaches to every `room:state`
 * broadcast (see `apps/api/src/engine/fixture-annotation.ts`'s `CurrentFixtureSummary` and
 * `dispatch.ts`'s `RoomBroadcastPayload`) — a sibling field next to the engine's own `ProjectedRoom`
 * projection, never part of it. Kept as a plain data type here rather than imported from the server:
 * apps/web only ever consumes the socket payload's shape, never the server's derivation of it.
 */

import type { ProjectedRoom } from '@fdg/game-core';

export interface CurrentFixtureTeamSummary {
  readonly name: string;
  readonly crestUrl: string | null;
}

export interface CurrentFixtureSummary {
  readonly fixtureId: string;
  readonly competitionId: string;
  /** `'single'` for the original one-fixture-per-room flow, `'gameday'` when the round rotated in
   * from a competition's live fixtures. */
  readonly mode: 'single' | 'gameday';
  readonly homeTeam: CurrentFixtureTeamSummary;
  readonly awayTeam: CurrentFixtureTeamSummary;
}

/** The room shape every client screen actually receives over the socket: the engine's pure
 * `ProjectedRoom` plus the API layer's `currentFixture` annotation. */
export type ClientRoom = ProjectedRoom & { readonly currentFixture: CurrentFixtureSummary | null };

export interface NowPlayingLabel {
  readonly primary: string;
  /** Extra context shown only for a gameday round — `null` for a single-fixture room, where every
   * round is about the same match and there's nothing to add. */
  readonly secondary: string | null;
}

/**
 * Pure derivation of the "Now playing" banner's copy. `null` means render nothing: a general room,
 * or a matchday room whose data hasn't been prefetched yet (still on the loading screen).
 */
export const nowPlayingLabel = (currentFixture: CurrentFixtureSummary | null): NowPlayingLabel | null => {
  if (currentFixture === null) return null;
  return {
    primary: `${currentFixture.homeTeam.name} vs ${currentFixture.awayTeam.name}`,
    secondary: currentFixture.mode === 'gameday' ? 'Gameday · rotating across live matches' : null,
  };
};
