/**
 * Regression coverage for three gameday-mode defects a QA gate found in the pin-keying/rotation code
 * (`apps/api/src/engine/data-context.ts`, `gameday-cache.ts`, `fixture-annotation.ts`):
 *
 * - D1: pins used to be keyed only by a session-relative round count, ambiguous across the
 *   `START_SESSION` boundary — a brand-new game's round 0 could silently reuse a stale pin (or
 *   compute the wrong rotation index) from the previous game played in the same room. Covered by
 *   "a second game in the same room starts its own rotation from the top", which cross-checks the
 *   round's ACTUAL generated content (`round.publicPayload.target.teamId`) against the `currentFixture`
 *   annotation — not just the annotation against itself.
 * - D2: a live fixture whose cached data can't support the session's module used to be pinned
 *   *before* generation was attempted, so a failure jammed that round index forever and the room
 *   looked exhausted even with other perfectly playable fixtures live. Covered by "a fixture that
 *   can't support the session's module is skipped, not fatal".
 * - D3: the "now playing" banner incorrectly went `null` for an already-revealed round once every
 *   fixture left the live set, even though the underlying bundle is grow-only (never pruned)
 *   specifically so an already-happened round can still be identified. Covered by "an already-revealed
 *   round's banner survives every fixture leaving the live set".
 */

import { afterEach, describe, expect, it } from 'vitest';
import { COMPETITIONS, FixtureProvider, asTeamId, createInMemoryDataSource, ok } from '@fdg/football-data';
import type { Fixture, FootballDataProvider } from '@fdg/football-data';
import type { ProjectedRoom } from '@fdg/game-core';
import type { Socket as ClientSocket } from 'socket.io-client';
import type { StateTracker, TestServer } from './helpers.js';
import { connectAndTrack, jsonFetch, startTestServer } from './helpers.js';

const PL = COMPETITIONS.PREMIER_LEAGUE;

interface RoomStateWithFixture extends ProjectedRoom {
  readonly currentFixture: {
    readonly fixtureId: string;
    readonly mode: string;
    readonly homeTeam: { readonly name: string };
    readonly awayTeam: { readonly name: string };
  } | null;
}

const team = (id: string) => ({ id: asTeamId(id), name: `${id} FC`, shortName: id.toUpperCase(), crestUrl: null, country: null });

const startingXI = (teamId: string) =>
  Array.from({ length: 11 }, (_, index) => ({
    playerId: `${teamId}-p${String(index + 1)}`,
    name: `${teamId} Player ${String(index + 1)}`,
    shirtNumber: index + 1,
    position: 'MF' as const,
    gridPosition: null,
    isStarter: true,
  }));

const player = (teamId: string, index: number) => ({
  id: `${teamId}-p${String(index + 1)}`,
  name: `${teamId} Player ${String(index + 1)}`,
  fullName: null,
  nationality: null,
  dateOfBirth: null,
  age: null,
  heightCm: null,
  position: 'MF' as const,
  shirtNumber: index + 1,
  teamId,
  photoUrl: null,
  marketValueEur: null,
});

function recordedFixture(id: string, kickoff: string, homeId: string, awayId: string) {
  return {
    id,
    competitionId: PL.id,
    season: PL.currentSeason,
    kickoff,
    status: 'LIVE' as const,
    minute: 42,
    homeTeam: team(homeId),
    awayTeam: team(awayId),
    score: { home: 1, away: 0 },
    halfTimeScore: null,
    venue: null,
    round: null,
  };
}

function lineupsFor(fixtureId: string, homeId: string, awayId: string) {
  return {
    fixtureId,
    home: { teamId: homeId, formation: null, coachName: null, startingXI: startingXI(homeId), substitutes: [] },
    away: { teamId: awayId, formation: null, coachName: null, startingXI: startingXI(awayId), substitutes: [] },
    confirmed: true,
  };
}

/** No lineup at all for this fixture — `hasLineups`/`hasShirtNumbers` both come back `false`, so M3
 * can never be played from it (used for D2's "unplayable fixture" scenario). */
function emptyLineupsFor(fixtureId: string, homeId: string, awayId: string) {
  return {
    fixtureId,
    home: { teamId: homeId, formation: null, coachName: null, startingXI: [], substitutes: [] },
    away: { teamId: awayId, formation: null, coachName: null, startingXI: [], substitutes: [] },
    confirmed: false,
  };
}

const PROVENANCE = {
  kind: 'recorded-sample-data' as const,
  description: 'gameday-room-fixes.test.ts fixture',
  recordedAt: '2026-09-27T00:00:00.000Z',
  disclaimer: 'test data',
};

function emptyCompetitionFile(code: keyof typeof COMPETITIONS) {
  const config = COMPETITIONS[code];
  const placeholderHome = team(`${code.toLowerCase()}-home`);
  const placeholderAway = team(`${code.toLowerCase()}-away`);
  return {
    provenance: PROVENANCE,
    competitionCode: code,
    season: config.currentSeason,
    teams: [placeholderHome, placeholderAway],
    players: [player(placeholderHome.id, 0)],
    seasonStats: [],
    fixtures: [
      {
        id: `${code.toLowerCase()}-placeholder`,
        competitionId: config.id,
        season: config.currentSeason,
        kickoff: '2026-09-20T12:00:00.000Z',
        status: 'FINISHED' as const,
        minute: null,
        homeTeam: placeholderHome,
        awayTeam: placeholderAway,
        score: { home: 0, away: 0 },
        halfTimeScore: null,
        venue: null,
        round: null,
      },
    ],
    lineups: [],
    liveStates: [],
  };
}

const otherCompetitionFiles = () => ({
  'competitions/la-liga.json': emptyCompetitionFile('LA_LIGA'),
  'competitions/serie-a.json': emptyCompetitionFile('SERIE_A'),
  'competitions/bundesliga.json': emptyCompetitionFile('BUNDESLIGA'),
  'competitions/ligue-1.json': emptyCompetitionFile('LIGUE_1'),
  'competitions/champions-league.json': emptyCompetitionFile('CHAMPIONS_LEAGUE'),
});

const indexDocument = () => ({
  provenance: PROVENANCE,
  version: 1,
  competitions: [
    { code: 'PREMIER_LEAGUE', file: 'competitions/premier-league.json' },
    { code: 'LA_LIGA', file: 'competitions/la-liga.json' },
    { code: 'SERIE_A', file: 'competitions/serie-a.json' },
    { code: 'BUNDESLIGA', file: 'competitions/bundesliga.json' },
    { code: 'LIGUE_1', file: 'competitions/ligue-1.json' },
    { code: 'CHAMPIONS_LEAGUE', file: 'competitions/champions-league.json' },
  ],
  careersFile: 'careers.json',
  timelines: [],
});

/** Three simultaneously-live Premier League fixtures, kickoff-ordered arsenal < chelsea < spurs. */
function buildScenario() {
  const arsenal = recordedFixture('gd-arsenal', '2026-09-27T14:00:00.000Z', 'arsenal', 'leeds');
  const chelsea = recordedFixture('gd-chelsea', '2026-09-27T14:30:00.000Z', 'chelsea', 'bournemouth');
  const spurs = recordedFixture('gd-spurs', '2026-09-27T15:00:00.000Z', 'spurs', 'everton');

  const teams = ['arsenal', 'leeds', 'chelsea', 'bournemouth', 'spurs', 'everton'];
  const players = teams.flatMap((teamId) => Array.from({ length: 11 }, (_, index) => player(teamId, index)));
  const lineups = [
    lineupsFor('gd-arsenal', 'arsenal', 'leeds'),
    lineupsFor('gd-chelsea', 'chelsea', 'bournemouth'),
    lineupsFor('gd-spurs', 'spurs', 'everton'),
  ];
  const liveStates = ['gd-arsenal', 'gd-chelsea', 'gd-spurs'].map((fixtureId) => ({
    fixtureId,
    updatedAt: '2026-09-27T14:42:00.000Z',
    events: [],
    teamStats: [],
    playerStats: [],
  }));

  const documents = {
    'index.json': indexDocument(),
    'competitions/premier-league.json': {
      provenance: PROVENANCE,
      competitionCode: 'PREMIER_LEAGUE',
      season: PL.currentSeason,
      teams: teams.map((id) => team(id)),
      players,
      seasonStats: [],
      fixtures: [arsenal, chelsea, spurs],
      lineups,
      liveStates,
    },
    ...otherCompetitionFiles(),
    'careers.json': { provenance: PROVENANCE, careers: [] },
  };

  return createInMemoryDataSource(documents);
}

/** Same three fixtures, but `gd-arsenal` (the rotation-first, kickoff-earliest one) has no lineup
 * data at all, so M3 ("Shirt Number") can never be generated from it. */
function buildUnplayableFirstScenario() {
  const arsenal = recordedFixture('gd-arsenal', '2026-09-27T14:00:00.000Z', 'arsenal', 'leeds');
  const chelsea = recordedFixture('gd-chelsea', '2026-09-27T14:30:00.000Z', 'chelsea', 'bournemouth');
  const spurs = recordedFixture('gd-spurs', '2026-09-27T15:00:00.000Z', 'spurs', 'everton');

  const teams = ['arsenal', 'leeds', 'chelsea', 'bournemouth', 'spurs', 'everton'];
  const players = teams.flatMap((teamId) => Array.from({ length: 11 }, (_, index) => player(teamId, index)));
  const lineups = [
    emptyLineupsFor('gd-arsenal', 'arsenal', 'leeds'),
    lineupsFor('gd-chelsea', 'chelsea', 'bournemouth'),
    lineupsFor('gd-spurs', 'spurs', 'everton'),
  ];
  const liveStates = ['gd-arsenal', 'gd-chelsea', 'gd-spurs'].map((fixtureId) => ({
    fixtureId,
    updatedAt: '2026-09-27T14:42:00.000Z',
    events: [],
    teamStats: [],
    playerStats: [],
  }));

  const documents = {
    'index.json': indexDocument(),
    'competitions/premier-league.json': {
      provenance: PROVENANCE,
      competitionCode: 'PREMIER_LEAGUE',
      season: PL.currentSeason,
      teams: teams.map((id) => team(id)),
      players,
      seasonStats: [],
      fixtures: [arsenal, chelsea, spurs],
      lineups,
      liveStates,
    },
    ...otherCompetitionFiles(),
    'careers.json': { provenance: PROVENANCE, careers: [] },
  };

  return createInMemoryDataSource(documents);
}

/** Same proxy trick `gameday-room.test.ts` uses to force `listLiveFixtures`' answer at will. */
function withMutableLiveFixtures(inner: FixtureProvider): {
  provider: FootballDataProvider;
  setLiveOverride: (fixtures: readonly Fixture[] | null) => void;
} {
  let override: readonly Fixture[] | null = null;
  const provider = new Proxy(inner, {
    get(target, prop) {
      if (prop === 'listLiveFixtures') {
        return (competitionId: Parameters<FootballDataProvider['listLiveFixtures']>[0]) =>
          override !== null ? Promise.resolve(ok(override)) : target.listLiveFixtures(competitionId);
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as FootballDataProvider;
  return { provider, setLiveOverride: (fixtures) => (override = fixtures) };
}

/** Which team ids belong to a known test fixture, so a round's actual generated content
 * (`publicPayload.target.teamId`) can be cross-checked against whichever fixture is announced as
 * `currentFixture` — independently of the annotation logic itself. */
const FIXTURE_TEAM_IDS: Record<string, readonly string[]> = {
  'gd-arsenal': ['arsenal', 'leeds'],
  'gd-chelsea': ['chelsea', 'bournemouth'],
  'gd-spurs': ['spurs', 'everton'],
};

const selectM3AndLoad = async (
  hostSocket: ClientSocket,
  hostState: StateTracker<RoomStateWithFixture>,
  playerId: string,
): Promise<void> => {
  hostSocket.emit('room:action', { type: 'SELECT_GAME', actorId: playerId, moduleId: 'M3', config: null });
  await hostState.waitFor((state) => state.selection?.moduleId === 'M3', 15_000);

  hostSocket.emit('room:action', {
    type: 'START_LOADING',
    actorId: playerId,
    stepKeys: ['fixture', 'lineups', 'squads', 'stats'],
  });
  await hostState.waitFor(
    (state) => state.loading?.steps.every((step) => step.status === 'done' || step.status === 'failed') === true,
    30_000,
  );
};

describe('gameday room — D1/D2/D3 regression coverage', () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it(
    'D1: a second game in the same room starts its own rotation from the top, with matching content',
    async () => {
      const provider = new FixtureProvider({ dataSource: buildScenario() });
      server = await startTestServer({ footballData: provider });

      const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
        method: 'POST',
        body: JSON.stringify({
          category: 'matchday',
          gameday: true,
          competitionId: PL.id,
          hostNickname: 'Hosty',
          settings: { minPlayersToStart: 1, roundsPerSession: 2 },
        }),
      });
      expect(createRoom.status).toBe(201);
      const { roomToken } = createRoom.body as { roomToken: string };

      const host = await connectAndTrack<RoomStateWithFixture>(server, { mode: 'reconnect', roomToken });
      const hostSocket = host.socket;
      const hostState = host.state;
      const playerId = host.joined.playerId;

      // --- Game 1: two rounds, played to completion. ---
      await selectM3AndLoad(hostSocket, hostState, playerId);
      hostSocket.emit('room:action', { type: 'START_SESSION', actorId: playerId });

      const game1Fixtures: string[] = [];
      for (let round = 0; round < 2; round += 1) {
        const playing = await hostState.waitFor(
          (state) => state.round?.status === 'open' && state.round.index === round,
          15_000,
        );
        expect(playing.currentFixture).not.toBeNull();
        const fixtureId = playing.currentFixture!.fixtureId;
        game1Fixtures.push(fixtureId);

        // Cross-check: the round's ACTUAL generated content must be about the announced fixture.
        const target = (playing.round!.publicPayload as { target: { teamId: string } }).target;
        expect(FIXTURE_TEAM_IDS[fixtureId]).toContain(target.teamId);

        hostSocket.emit('room:action', {
          type: 'SUBMIT_ANSWER',
          playerId,
          roundId: playing.round!.id,
          payload: { guess: 1 },
        });
        await hostState.waitFor((state) => state.round?.status === 'resolved', 15_000);

        hostSocket.emit('room:action', { type: 'ADVANCE', actorId: playerId });
        await hostState.waitFor((state) => state.phase === 'intermission', 15_000);
        if (round === 0) {
          hostSocket.emit('room:action', { type: 'ADVANCE', actorId: playerId });
        }
      }
      expect(game1Fixtures).toEqual(['gd-arsenal', 'gd-chelsea']);

      // --- Game 2: started fresh from `intermission`. `START_SESSION` is valid directly from
      // `intermission` (data is already cached from game 1) — no `START_LOADING` round-trip needed,
      // same as a real host picking "play again" without the data ever going stale. ---
      hostSocket.emit('room:action', { type: 'SELECT_GAME', actorId: playerId, moduleId: 'M3', config: null });
      await hostState.waitFor((state) => state.session?.finished === true && state.selection?.moduleId === 'M3', 15_000);
      hostSocket.emit('room:action', { type: 'START_SESSION', actorId: playerId });

      const playingGame2Round0 = await hostState.waitFor(
        (state) => state.selection?.moduleId === 'M3' && state.round?.status === 'open' && state.round.index === 0 && (state.session?.roundsPlayed ?? 0) === 1,
        15_000,
      );
      expect(playingGame2Round0.currentFixture).not.toBeNull();
      // Rotation must restart from the top for the new game, not continue from game 1's round count.
      expect(playingGame2Round0.currentFixture!.fixtureId).toBe('gd-arsenal');

      const target2 = (playingGame2Round0.round!.publicPayload as { target: { teamId: string } }).target;
      expect(FIXTURE_TEAM_IDS[playingGame2Round0.currentFixture!.fixtureId]).toContain(target2.teamId);

      hostSocket.close();
    },
    60_000,
  );

  it(
    'D2: a fixture that cannot support the module is skipped, not fatal',
    async () => {
      const provider = new FixtureProvider({ dataSource: buildUnplayableFirstScenario() });
      server = await startTestServer({ footballData: provider });

      const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
        method: 'POST',
        body: JSON.stringify({
          category: 'matchday',
          gameday: true,
          competitionId: PL.id,
          hostNickname: 'Hosty',
          settings: { minPlayersToStart: 1, roundsPerSession: 3 },
        }),
      });
      expect(createRoom.status).toBe(201);
      const { roomToken } = createRoom.body as { roomToken: string };

      const host = await connectAndTrack<RoomStateWithFixture>(server, { mode: 'reconnect', roomToken });
      const hostSocket = host.socket;
      const hostState = host.state;
      const playerId = host.joined.playerId;

      await selectM3AndLoad(hostSocket, hostState, playerId);
      hostSocket.emit('room:action', { type: 'START_SESSION', actorId: playerId });

      const seenFixtureIds: string[] = [];
      for (let round = 0; round < 3; round += 1) {
        const playing = await hostState.waitFor(
          (state) => state.round?.status === 'open' && state.round.index === round,
          15_000,
        );
        expect(playing.currentFixture).not.toBeNull();
        seenFixtureIds.push(playing.currentFixture!.fixtureId);

        hostSocket.emit('room:action', {
          type: 'SUBMIT_ANSWER',
          playerId,
          roundId: playing.round!.id,
          payload: { guess: 1 },
        });
        await hostState.waitFor((state) => state.round?.status === 'resolved', 15_000);

        if (round < 2) {
          hostSocket.emit('room:action', { type: 'ADVANCE', actorId: playerId });
          await hostState.waitFor((state) => state.phase === 'intermission', 15_000);
          hostSocket.emit('room:action', { type: 'ADVANCE', actorId: playerId });
        }
      }

      // gd-arsenal has no lineup data and can never support M3 — it must never be picked, but the
      // room must still complete all 3 rounds using the two playable fixtures instead of jamming.
      expect(seenFixtureIds).not.toContain('gd-arsenal');
      for (const fixtureId of seenFixtureIds) {
        expect(['gd-chelsea', 'gd-spurs']).toContain(fixtureId);
      }

      hostSocket.close();
    },
    60_000,
  );

  it(
    'D3: an already-revealed round keeps its banner after every fixture leaves the live set',
    async () => {
      const inner = new FixtureProvider({ dataSource: buildScenario() });
      const { provider, setLiveOverride } = withMutableLiveFixtures(inner);
      server = await startTestServer({ footballData: provider, gamedayLivePollMs: 150 });

      const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
        method: 'POST',
        body: JSON.stringify({
          category: 'matchday',
          gameday: true,
          competitionId: PL.id,
          hostNickname: 'Hosty',
          settings: { minPlayersToStart: 1, roundsPerSession: 2 },
        }),
      });
      expect(createRoom.status).toBe(201);
      const { roomToken } = createRoom.body as { roomToken: string };

      const host = await connectAndTrack<RoomStateWithFixture>(server, { mode: 'reconnect', roomToken });
      const hostSocket = host.socket;
      const hostState = host.state;
      const playerId = host.joined.playerId;

      await selectM3AndLoad(hostSocket, hostState, playerId);
      hostSocket.emit('room:action', { type: 'START_SESSION', actorId: playerId });

      const playing = await hostState.waitFor(
        (state) => state.round?.status === 'open' && state.round.index === 0,
        15_000,
      );
      const originalFixtureId = playing.currentFixture!.fixtureId;
      expect(originalFixtureId).toBe('gd-arsenal');

      hostSocket.emit('room:action', {
        type: 'SUBMIT_ANSWER',
        playerId,
        roundId: playing.round!.id,
        payload: { guess: 1 },
      });
      const resolved = await hostState.waitFor((state) => state.round?.status === 'resolved', 15_000);
      expect(resolved.currentFixture?.fixtureId).toBe(originalFixtureId);

      // Every fixture in the competition drops out of the live set entirely.
      setLiveOverride([]);
      // Give the poll interval time to elapse and actually observe the empty live set.
      await new Promise((resolve) => setTimeout(resolve, 400));
      hostSocket.emit('room:action', { type: 'ADVANCE', actorId: playerId });
      const intermission = await hostState.waitFor((state) => state.phase === 'intermission', 15_000);

      // The already-revealed round's banner must still show its real fixture — never go blank just
      // because rotation-eligibility has since shrunk to zero.
      expect(intermission.currentFixture).not.toBeNull();
      expect(intermission.currentFixture!.fixtureId).toBe(originalFixtureId);

      hostSocket.close();
    },
    60_000,
  );
});
