/**
 * "Gameday mode": one room, rounds rotating across every fixture currently live in one competition.
 * Everything here runs against the offline `FixtureProvider` fed a small hand-built in-memory dataset
 * (same construction as `packages/football-data/src/gameday.test.ts`), so the scenario — which
 * fixtures are "live" right now — is fully under this file's control.
 *
 * Covers: room creation succeeds when live fixtures exist and is rejected with none; round generation
 * actually rotates round-robin across the live fixtures (asserted on the `currentFixture` annotation
 * `apps/api` adds to the broadcast payload, across more rounds than there are fixtures, so a bug that
 * always picks the same one would fail); a fixture dropping out of the live set mid-session excludes
 * it from new rounds; the single-fixture flow (`matchday-room.test.ts`) is unaffected.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { COMPETITIONS, FixtureProvider, asTeamId, createInMemoryDataSource, ok } from '@fdg/football-data';
import type { Fixture, FootballDataProvider } from '@fdg/football-data';
import type { ProjectedRoom } from '@fdg/game-core';
import type { TestServer } from './helpers.js';
import { connectAndTrack, jsonFetch, startTestServer } from './helpers.js';

const PL = COMPETITIONS.PREMIER_LEAGUE;
const SERIE_A = COMPETITIONS.SERIE_A;

interface RoomStateWithFixture extends ProjectedRoom {
  readonly currentFixture: { readonly fixtureId: string; readonly mode: string } | null;
}

const team = (id: string) => ({ id: asTeamId(id), name: `${id} FC`, shortName: id.toUpperCase(), crestUrl: null, country: null });

/** 11 distinct, uniquely shirt-numbered starters for one team — enough for M3 (`hasLineups` +
 * `hasShirtNumbers`) across several rounds without ever running out of un-used candidates. */
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

const PROVENANCE = {
  kind: 'recorded-sample-data' as const,
  description: 'gameday-room.test.ts fixture',
  recordedAt: '2026-09-27T00:00:00.000Z',
  disclaimer: 'test data',
};

/** Three simultaneously-live Premier League fixtures, kickoff-ordered arsenal < chelsea < spurs — the
 * order `listLiveFixtures`/the rotation pool is expected to follow. */
function buildScenario() {
  const arsenal = recordedFixture('gd-arsenal', '2026-09-27T14:00:00.000Z', 'arsenal', 'leeds');
  const chelsea = recordedFixture('gd-chelsea', '2026-09-27T14:30:00.000Z', 'chelsea', 'bournemouth');
  const spurs = recordedFixture('gd-spurs', '2026-09-27T15:00:00.000Z', 'spurs', 'everton');
  const finished = recordedFixture('gd-finished', '2026-09-27T12:00:00.000Z', 'villa', 'fulham');
  const finishedFixture = { ...finished, status: 'FINISHED' as const, minute: null };

  const teams = ['arsenal', 'leeds', 'chelsea', 'bournemouth', 'spurs', 'everton', 'villa', 'fulham'];
  const players = teams.flatMap((teamId) => Array.from({ length: 11 }, (_, index) => player(teamId, index)));
  const lineups = [
    lineupsFor('gd-arsenal', 'arsenal', 'leeds'),
    lineupsFor('gd-chelsea', 'chelsea', 'bournemouth'),
    lineupsFor('gd-spurs', 'spurs', 'everton'),
  ];
  // A trivial (empty-feed) live state per live fixture is enough for `MatchdayPrefetcher`'s `stats`
  // step to succeed (`live !== null`) without needing season-stat rows M3 doesn't use anyway.
  const liveStates = ['gd-arsenal', 'gd-chelsea', 'gd-spurs'].map((fixtureId) => ({
    fixtureId,
    updatedAt: '2026-09-27T14:42:00.000Z',
    events: [],
    teamStats: [],
    playerStats: [],
  }));

  const documents = {
    'index.json': {
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
    },
    'competitions/premier-league.json': {
      provenance: PROVENANCE,
      competitionCode: 'PREMIER_LEAGUE',
      season: PL.currentSeason,
      teams: teams.map((id) => team(id)),
      players,
      seasonStats: [],
      fixtures: [arsenal, chelsea, spurs, finishedFixture],
      lineups,
      liveStates,
    },
    'competitions/la-liga.json': emptyCompetitionFile('LA_LIGA'),
    'competitions/serie-a.json': emptyCompetitionFile('SERIE_A'),
    'competitions/bundesliga.json': emptyCompetitionFile('BUNDESLIGA'),
    'competitions/ligue-1.json': emptyCompetitionFile('LIGUE_1'),
    'competitions/champions-league.json': emptyCompetitionFile('CHAMPIONS_LEAGUE'),
    'careers.json': { provenance: PROVENANCE, careers: [] },
  };

  return createInMemoryDataSource(documents);
}

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

/**
 * Wraps a real `FixtureProvider` so a test can force `listLiveFixtures`' answer at will (simulating a
 * match finishing mid-session) while every other call still goes through the real recorded dataset.
 * `Reflect.get(target, prop, target)` (not `receiver`) so a wrapped method's internal `this.*` calls
 * still resolve against the real instance, never the proxy.
 */
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

const SERVER_BOOT_TIMEOUT_MS = 30_000;

describe('gameday room (fixture provider, rotation across live fixtures)', () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it(
    'rejects creating a gameday room for a competition with zero live fixtures',
    async () => {
      const provider = new FixtureProvider({ dataSource: buildScenario() });
      server = await startTestServer({ footballData: provider });

      const response = await jsonFetch(`${server.baseUrl}/rooms`, {
        method: 'POST',
        body: JSON.stringify({
          category: 'matchday',
          gameday: true,
          competitionId: SERIE_A.id,
          hostNickname: 'Hosty',
          settings: { minPlayersToStart: 1 },
        }),
      });
      expect(response.status).toBe(400);
      expect((response.body as { error: { code: string } }).error.code).toBe('NO_LIVE_FIXTURES');
    },
    SERVER_BOOT_TIMEOUT_MS,
  );

  it(
    'creates a gameday room when live fixtures exist, and rounds rotate round-robin across them',
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
          settings: { minPlayersToStart: 1, roundsPerSession: 6 },
        }),
      });
      expect(createRoom.status).toBe(201);
      const created = createRoom.body as {
        roomToken: string;
        room: { fixtureId: string | null; gamedayCompetitionId: string | null };
      };
      expect(created.room.fixtureId).toBeNull();
      expect(created.room.gamedayCompetitionId).toBe(PL.id);

      const host = await connectAndTrack<RoomStateWithFixture>(server, {
        mode: 'reconnect',
        roomToken: created.roomToken,
      });
      const hostSocket = host.socket;
      const hostState = host.state;

      hostSocket.emit('room:action', {
        type: 'SELECT_GAME',
        actorId: host.joined.playerId,
        moduleId: 'M3',
        config: null,
      });
      await hostState.waitFor((state) => state.selection?.moduleId === 'M3', 15_000);

      hostSocket.emit('room:action', {
        type: 'START_LOADING',
        actorId: host.joined.playerId,
        stepKeys: ['fixture', 'lineups', 'squads', 'stats'],
      });
      const loaded = await hostState.waitFor(
        (state) => state.loading?.steps.every((step) => step.status === 'done' || step.status === 'failed') === true,
        30_000,
      );
      for (const step of loaded.loading?.steps ?? []) {
        expect(step.status).toBe('done');
      }

      hostSocket.emit('room:action', { type: 'START_SESSION', actorId: host.joined.playerId });
      const seenFixtureIds: string[] = [];

      for (let round = 0; round < 6; round += 1) {
        const playing = await hostState.waitFor(
          (state) => state.round?.status === 'open' && state.round.index === round,
          15_000,
        );
        expect(playing.currentFixture).not.toBeNull();
        expect(playing.currentFixture?.mode).toBe('gameday');
        seenFixtureIds.push(playing.currentFixture!.fixtureId);

        const roundId = playing.round!.id;
        hostSocket.emit('room:action', {
          type: 'SUBMIT_ANSWER',
          playerId: host.joined.playerId,
          roundId,
          payload: { guess: 1 },
        });
        await hostState.waitFor((state) => state.round?.status === 'resolved', 15_000);

        if (round < 5) {
          // Kahoot-style progression: the first `ADVANCE` only leaves `roundReveal` for
          // `intermission` (the "results, waiting for host" screen); a second `ADVANCE` is what
          // actually generates and starts the next round (`reducer.ts`'s `ADVANCE` case).
          hostSocket.emit('room:action', { type: 'ADVANCE', actorId: host.joined.playerId });
          await hostState.waitFor((state) => state.phase === 'intermission', 15_000);
          hostSocket.emit('room:action', { type: 'ADVANCE', actorId: host.joined.playerId });
        }
      }

      // Real rotation, not "always the same fixture": all three live fixtures were used…
      expect(new Set(seenFixtureIds)).toEqual(new Set(['gd-arsenal', 'gd-chelsea', 'gd-spurs']));
      // …in round-robin order, wrapping back to the start once the pool is exhausted.
      expect(seenFixtureIds).toEqual([
        'gd-arsenal',
        'gd-chelsea',
        'gd-spurs',
        'gd-arsenal',
        'gd-chelsea',
        'gd-spurs',
      ]);

      hostSocket.close();
    },
    60_000,
  );

  it(
    'a fixture dropping out of the live set mid-session excludes it from subsequent NEW rounds',
    async () => {
      const inner = new FixtureProvider({ dataSource: buildScenario() });
      const { provider, setLiveOverride } = withMutableLiveFixtures(inner);
      // A short poll interval so the test does not have to wait out the real 90s default.
      server = await startTestServer({ footballData: provider, gamedayLivePollMs: 150 });

      const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
        method: 'POST',
        body: JSON.stringify({
          category: 'matchday',
          gameday: true,
          competitionId: PL.id,
          hostNickname: 'Hosty',
          settings: { minPlayersToStart: 1, roundsPerSession: 4 },
        }),
      });
      expect(createRoom.status).toBe(201);
      const { roomToken } = createRoom.body as { roomToken: string };

      const host = await connectAndTrack<RoomStateWithFixture>(server, { mode: 'reconnect', roomToken });
      const hostSocket = host.socket;
      const hostState = host.state;

      hostSocket.emit('room:action', {
        type: 'SELECT_GAME',
        actorId: host.joined.playerId,
        moduleId: 'M3',
        config: null,
      });
      await hostState.waitFor((state) => state.selection?.moduleId === 'M3', 15_000);

      hostSocket.emit('room:action', {
        type: 'START_LOADING',
        actorId: host.joined.playerId,
        stepKeys: ['fixture', 'lineups', 'squads', 'stats'],
      });
      await hostState.waitFor(
        (state) => state.loading?.steps.every((step) => step.status === 'done' || step.status === 'failed') === true,
        30_000,
      );

      hostSocket.emit('room:action', { type: 'START_SESSION', actorId: host.joined.playerId });

      const seenFixtureIds: string[] = [];
      for (let round = 0; round < 3; round += 1) {
        const playing = await hostState.waitFor(
          (state) => state.round?.status === 'open' && state.round.index === round,
          15_000,
        );
        seenFixtureIds.push(playing.currentFixture!.fixtureId);

        if (round === 0) {
          // Chelsea "finishes" right after round 0 (arsenal) generates. A fixture is only ever pinned
          // by the dispatch that genuinely generates its round (`ADVANCE`/`START_SESSION`) — never by
          // the `TICK`s that fire every second while round 0 is still open — so round 1's fixture is
          // resolved fresh, from whatever the live pool actually is by the time `ADVANCE` runs.
          const live = await inner.listLiveFixtures(PL.id);
          if (live.ok) setLiveOverride(live.value.filter((fixture) => fixture.id !== 'gd-chelsea'));
        }

        const roundId = playing.round!.id;
        hostSocket.emit('room:action', {
          type: 'SUBMIT_ANSWER',
          playerId: host.joined.playerId,
          roundId,
          payload: { guess: 1 },
        });
        await hostState.waitFor((state) => state.round?.status === 'resolved', 15_000);

        if (round < 2) {
          // Give the poll interval time to elapse before the next round is generated.
          await new Promise((resolve) => setTimeout(resolve, 400));
          hostSocket.emit('room:action', { type: 'ADVANCE', actorId: host.joined.playerId });
          await hostState.waitFor((state) => state.phase === 'intermission', 15_000);
          hostSocket.emit('room:action', { type: 'ADVANCE', actorId: host.joined.playerId });
        }
      }

      // Round 0 is arsenal (the pool's first entry). By the time round 1 is genuinely generated
      // (after the 400ms poll wait below), chelsea has already been polled out of the live set, so it
      // must never be picked for any later round either — pinning only ever happens at genuine
      // generation time, never speculatively ahead of it.
      expect(seenFixtureIds[0]).toBe('gd-arsenal');
      expect(seenFixtureIds.slice(1)).not.toContain('gd-chelsea');
      for (const fixtureId of seenFixtureIds.slice(1)) {
        expect(['gd-arsenal', 'gd-spurs']).toContain(fixtureId);
      }

      hostSocket.close();
    },
    60_000,
  );
});
