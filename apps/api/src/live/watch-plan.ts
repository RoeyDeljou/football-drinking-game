/**
 * Which fixtures does one room need live events for *right now*? Pure function of the room record
 * plus two lookups, so it can be recomputed cheaply after every dispatch.
 *
 * A room needs events only while it is `playing`, its active session is unfinished, that session's
 * module declares `supportsLiveEvents`, and the current round is still `open` (the reducer refuses
 * a `MATCH_EVENTS` batch for any other round status). Which fixture(s):
 *
 * - single-fixture matchday room: `meta.fixtureId`;
 * - gameday room: the fixture the current round was pinned to (a round is generated from exactly one
 *   fixture, so events of the other live fixtures are irrelevant to it). Before a pin exists
 *   (never for an open round in practice) it falls back to the rotation pool.
 * - general rooms: none.
 */

import type { CompetitionId, FixtureId } from '@fdg/football-data';
import type { EngineGameModule, RoomId, RoomState } from '@fdg/game-core';
import { activeSession } from '@fdg/game-core';
import type { RoomMeta } from '../rooms/store.js';

export interface WatchNeed {
  readonly fixtureId: FixtureId;
  /** Identity of the round the events are for; a change means the round has not seen the events yet. */
  readonly roundKey: string;
}

export interface WatchPlanLookups {
  readonly moduleFor: (roomState: RoomState) => EngineGameModule | null;
  readonly gamedayPinnedFixture: (roomId: RoomId, sessionIndex: number, roundIndex: number) => FixtureId | null;
  readonly gamedayPool: (roomId: RoomId) => readonly FixtureId[];
}

export const planWatch = (
  state: RoomState,
  meta: RoomMeta,
  lookups: WatchPlanLookups,
): readonly WatchNeed[] => {
  if (state.phase !== 'playing') return [];
  const session = activeSession(state);
  if (session === undefined || session.finishedAt !== null) return [];
  const round = session.rounds[session.rounds.length - 1];
  if (round === undefined || round.status !== 'open') return [];
  const module = lookups.moduleFor(state);
  if (module === null || !module.supportsLiveEvents) return [];

  const roundKey = `${session.id}:${round.id}`;
  const gamedayCompetition: CompetitionId | null = meta.gamedayCompetitionId ?? null;
  if (gamedayCompetition !== null) {
    const sessionIndex = state.activeSessionIndex;
    const pinned =
      sessionIndex === null
        ? null
        : lookups.gamedayPinnedFixture(state.id, sessionIndex, session.rounds.length - 1);
    const fixtures = pinned !== null ? [pinned] : lookups.gamedayPool(state.id);
    return fixtures.map((fixtureId) => ({ fixtureId, roundKey }));
  }
  if (meta.fixtureId === null) return [];
  return [{ fixtureId: meta.fixtureId, roundKey }];
};
