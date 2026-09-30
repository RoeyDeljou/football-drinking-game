/**
 * Which fixtures does one room need live events for *right now*? Pure function of the room record
 * plus two lookups, so it can be recomputed cheaply after every dispatch.
 *
 * A room needs the feed only while it is `playing`, its active session is unfinished, that session's
 * module declares `supportsLiveEvents` and/or `supportsLiveStats`, and the current round is still `open` (the reducer refuses
 * a `MATCH_EVENTS` batch for any other round status). Which fixture(s):
 *
 * - single-fixture matchday room: `meta.fixtureId`;
 * - gameday room: the fixture the current round was pinned to (a round is generated from exactly one
 *   fixture, so events of the other live fixtures are irrelevant to it). With no pin
 *   there is nothing to watch (never the whole rotation pool).
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
  /** Send `MATCH_EVENTS` (module `supportsLiveEvents`). Defaults to true. */
  readonly events?: boolean;
  /** Send `MATCH_STATS` (module `supportsLiveStats`). Defaults to false. */
  readonly stats?: boolean;
}

export interface WatchPlanLookups {
  readonly moduleFor: (roomState: RoomState) => EngineGameModule | null;
  readonly gamedayPinnedFixture: (roomId: RoomId, sessionIndex: number, roundIndex: number) => FixtureId | null;
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
  if (module === null || (!module.supportsLiveEvents && !module.supportsLiveStats)) return [];
  const feed = { events: module.supportsLiveEvents, stats: module.supportsLiveStats };

  const roundKey = `${session.id}:${round.id}`;
  const gamedayCompetition: CompetitionId | null = meta.gamedayCompetitionId ?? null;
  if (gamedayCompetition !== null) {
    const sessionIndex = state.activeSessionIndex;
    const pinned =
      sessionIndex === null
        ? null
        : lookups.gamedayPinnedFixture(state.id, sessionIndex, session.rounds.length - 1);
    // No pin -> nothing: never feed other fixtures' events into a round.
    return pinned === null ? [] : [{ fixtureId: pinned, roundKey, ...feed }];
  }
  if (meta.fixtureId === null) return [];
  return [{ fixtureId: meta.fixtureId, roundKey, ...feed }];
};
