/**
 * Regression coverage for the sixth QA gate's finding: `pinRoundFixture` used to run *after*
 * `persistEngineEvents`, not immediately once the round was durably saved to `roomStore`. If
 * `persistEngineEvents` throws (e.g. a transient Postgres error on a `SESSION_STARTED` upsert), the
 * round has already been saved to `roomStore` and is genuinely live/playing, but the pin write never
 * happened — so `currentFixture`'s annotation fell back to the WRONG fixture while the round's actual
 * generated content was genuinely about a different one.
 *
 * Repro shape (mirrors `gameday-pinning-root-cause.test.ts`'s scaffolding): a gameday room with two
 * live fixtures, one (`FIXTURE_A`) that `M2`'s `generateRound` cannot use at all (every on-pitch player
 * shares one nationality) and one (`FIXTURE_B`) that it can. `START_SESSION` retries across candidates
 * (`reduceWithCandidates` in `dispatch.ts`) and lands on `FIXTURE_B`. A single throw is injected into
 * `prisma.gameSession.upsert` (the write `persistEngineEvents` performs for the `SESSION_STARTED`
 * event this action emits) to simulate a transient persistence-layer blip *after* `roomStore.save` has
 * already succeeded.
 *
 * Fix (`apps/api/src/engine/dispatch.ts`): `pinRoundFixture` now runs immediately after
 * `ctx.roomStore.save(record)` succeeds, before `persistEngineEvents` is even called — so the pin is
 * written regardless of whether the secondary event-persistence step also succeeds.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { COMPETITIONS, FixtureProvider, asTeamId, createInMemoryDataSource, ok } from '@fdg/football-data';
import type { Fixture, FootballDataProvider } from '@fdg/football-data';
import type { ProjectedRoom } from '@fdg/game-core';
import { asRoomId } from '@fdg/game-core';
import type { Socket as ClientSocket } from 'socket.io-client';
import type { StateTracker, TestServer } from './helpers.js';
import { connectAndTrack, jsonFetch, startTestServer, waitForEvent } from './helpers.js';
import { getPinnedRoundFixture } from '../src/engine/gameday-cache.js';
import { resolveCurrentFixtureAnnotation } from '../src/engine/fixture-annotation.js';

const PL = COMPETITIONS.PREMIER_LEAGUE;

interface RoomStateWithFixture extends ProjectedRoom {
  readonly currentFixture: {
    readonly fixtureId: string;
    readonly mode: string;
    readonly homeTeam: { readonly name: string };
    readonly awayTeam: { readonly name: string };
  } | null;
}

interface RoomError {
  readonly code: string;
  readonly detail: string | null;
}

const team = (id: string) => ({ id: asTeamId(id), name: `${id} FC`, shortName: id.toUpperCase(), crestUrl: null, country: null });

const startingXIFor = (teamId: string) =>
  Array.from({ length: 11 }, (_, index) => ({
    playerId: `${teamId}-p${String(index + 1)}`,
    name: `${teamId} Player ${String(index + 1)}`,
    shirtNumber: index + 1,
    position: 'MF' as const,
    gridPosition: null,
    isStarter: true,
  }));

const playerFor = (teamId: string, index: number, nationality: string) => ({
  id: `${teamId}-p${String(index + 1)}`,
  name: `${teamId} Player ${String(index + 1)}`,
  fullName: null,
  nationality,
  dateOfBirth: null,
  age: 25,
  heightCm: 180,
  position: 'MF' as const,
  shirtNumber: index + 1,
  teamId,
  photoUrl: null,
  marketValueEur: null,
});

const seasonStatsFor = (teamId: string, index: number) => ({
  playerId: `${teamId}-p${String(index + 1)}`,
  teamId,
  competitionId: PL.id,
  season: PL.currentSeason,
  appearances: 5,
  minutesPlayed: 450,
  goals: 0,
  assists: 0,
  yellowCards: 0,
  redCards: 0,
  shots: null,
  shotsOnTarget: null,
  passAccuracy: null,
  tackles: null,
  rating: null,
});

const goalEvent = (fixtureId: string, teamId: string) => ({
  id: `${fixtureId}-goal`,
  fixtureId,
  type: 'GOAL' as const,
  minute: 10,
  extraMinute: null,
  teamId,
  playerId: null,
  playerName: null,
  relatedPlayerId: null,
  detail: null,
});

interface FixtureSpec {
  readonly id: string;
  readonly kickoff: string;
  readonly homeId: string;
  readonly awayId: string;
  readonly nationalityFor: (index: number) => string;
}

const recordedFixture = (spec: FixtureSpec) => ({
  id: spec.id,
  competitionId: PL.id,
  season: PL.currentSeason,
  kickoff: spec.kickoff,
  status: 'LIVE' as const,
  minute: 42,
  homeTeam: team(spec.homeId),
  awayTeam: team(spec.awayId),
  score: { home: 1, away: 0 },
  halfTimeScore: null,
  venue: null,
  round: null,
});

const lineupsForSpec = (spec: FixtureSpec) => ({
  fixtureId: spec.id,
  home: { teamId: spec.homeId, formation: null, coachName: null, startingXI: startingXIFor(spec.homeId), substitutes: [] },
  away: { teamId: spec.awayId, formation: null, coachName: null, startingXI: startingXIFor(spec.awayId), substitutes: [] },
  confirmed: true,
});

const playersForSpec = (spec: FixtureSpec) => [
  ...Array.from({ length: 11 }, (_, index) => playerFor(spec.homeId, index, spec.nationalityFor(index))),
  ...Array.from({ length: 11 }, (_, index) => playerFor(spec.awayId, index, spec.nationalityFor(11 + index))),
];

const seasonStatsForSpec = (spec: FixtureSpec) => [
  ...Array.from({ length: 11 }, (_, index) => seasonStatsFor(spec.homeId, index)),
  ...Array.from({ length: 11 }, (_, index) => seasonStatsFor(spec.awayId, index)),
];

const liveStateForSpec = (spec: FixtureSpec) => ({
  fixtureId: spec.id,
  updatedAt: '2026-09-27T14:42:00.000Z',
  events: [goalEvent(spec.id, spec.homeId)],
  teamStats: [],
  playerStats: [],
});

/** Fixture F: totally unusable for `M2` — every on-pitch player shares one nationality, so
 * `generateRound` can never find a unique fact — while still passing `checkModulePlayable`'s boolean
 * quality gate (it has lineups and season stats). */
const FIXTURE_F: FixtureSpec = {
  id: 'pbp-fails',
  kickoff: '2026-09-27T14:00:00.000Z',
  homeId: 'pbp-f-home',
  awayId: 'pbp-f-away',
  nationalityFor: () => 'GB',
};

/** Fixture E: fully rich — every on-pitch player has a distinct nationality, so `M2` always has
 * plenty of fresh unique facts. Round generation must retry onto this one once F fails. */
const FIXTURE_E: FixtureSpec = {
  id: 'pbp-succeeds',
  kickoff: '2026-09-27T13:00:00.000Z',
  homeId: 'pbp-e-home',
  awayId: 'pbp-e-away',
  nationalityFor: (index) => `NAT-${String(index)}`,
};

const ALL_FIXTURES = [FIXTURE_F, FIXTURE_E];

const PROVENANCE = {
  kind: 'recorded-sample-data' as const,
  description: 'gameday-pin-before-persist.test.ts fixture',
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
    players: [playerFor(placeholderHome.id, 0, 'GB')],
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

function buildScenario() {
  const documents = {
    'index.json': indexDocument(),
    'competitions/premier-league.json': {
      provenance: PROVENANCE,
      competitionCode: 'PREMIER_LEAGUE',
      season: PL.currentSeason,
      teams: ALL_FIXTURES.flatMap((spec) => [team(spec.homeId), team(spec.awayId)]),
      players: ALL_FIXTURES.flatMap((spec) => playersForSpec(spec)),
      seasonStats: ALL_FIXTURES.flatMap((spec) => seasonStatsForSpec(spec)),
      fixtures: ALL_FIXTURES.map((spec) => recordedFixture(spec)),
      lineups: ALL_FIXTURES.map((spec) => lineupsForSpec(spec)),
      liveStates: ALL_FIXTURES.map((spec) => liveStateForSpec(spec)),
    },
    ...otherCompetitionFiles(),
    'careers.json': { provenance: PROVENANCE, careers: [] },
  };
  return createInMemoryDataSource(documents);
}

/** Forces `listLiveFixtures`' answer, same trick used across the other gameday test files. */
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

const asFixture = (spec: FixtureSpec): Fixture => recordedFixture(spec) as unknown as Fixture;

const M2_NATIONALITY_ONLY_CONFIG = {
  optionCount: 6,
  answerWindowMs: 20_000,
  factKinds: ['NATIONALITY'],
  wrongAnswerSips: 2,
  noAnswerSips: 2,
  lastCorrectSips: 1,
};

const selectAndLoad = async (
  hostSocket: ClientSocket,
  hostState: StateTracker<RoomStateWithFixture>,
  playerId: string,
  moduleId: string,
  config: unknown,
): Promise<void> => {
  hostSocket.emit('room:action', { type: 'SELECT_GAME', actorId: playerId, moduleId, config });
  await hostState.waitFor((state) => state.selection?.moduleId === moduleId, 15_000);

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

describe('gameday room — pin is written immediately after save, independent of persistEngineEvents', () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it(
    'a persistence-layer throw between save and event-persistence does not prevent the fixture pin, and currentFixture matches the round the reducer actually accepted',
    async () => {
      const inner = new FixtureProvider({ dataSource: buildScenario() });
      const { provider, setLiveOverride } = withMutableLiveFixtures(inner);
      // F first (unplayable for M2), E second (fully playable) — rotation is assigned F, fails
      // generateRound, and retries onto E within the same dispatch.
      setLiveOverride([asFixture(FIXTURE_F), asFixture(FIXTURE_E)]);
      server = await startTestServer({ footballData: provider, gamedayLivePollMs: 150 });

      const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
        method: 'POST',
        body: JSON.stringify({
          category: 'matchday',
          gameday: true,
          competitionId: PL.id,
          hostNickname: 'Hosty',
          settings: { minPlayersToStart: 1, roundsPerSession: 1 },
        }),
      });
      expect(createRoom.status).toBe(201);
      const { roomToken, roomId } = createRoom.body as { roomToken: string; roomId: string };
      const brandedRoomId = asRoomId(roomId);

      const host = await connectAndTrack<RoomStateWithFixture>(server, { mode: 'reconnect', roomToken });
      const hostSocket = host.socket;
      const hostState = host.state;
      const playerId = host.joined.playerId;

      await selectAndLoad(hostSocket, hostState, playerId, 'M2', M2_NATIONALITY_ONLY_CONFIG);

      // Inject a single throw into the exact write `persistEngineEvents` performs for this action's
      // `SESSION_STARTED` event — simulating a transient Postgres error strictly *after*
      // `roomStore.save` has already committed the round.
      const prisma = server.ctx.prisma;
      const originalUpsert = prisma.gameSession.upsert.bind(prisma.gameSession);
      let armed = true;
      (prisma.gameSession as unknown as { upsert: (arg: unknown) => unknown }).upsert = (args: unknown) => {
        if (armed) {
          armed = false;
          throw new Error('injected persistence-layer blip');
        }
        return originalUpsert(args as never);
      };

      const errorPromise = waitForEvent<RoomError>(hostSocket, 'room:error');
      hostSocket.emit('room:action', { type: 'START_SESSION', actorId: playerId });

      // The client sees the dispatch fail (event-persistence threw, so dispatchAction rejects and the
      // gateway reports it) — but the round itself was already durably saved beforehand.
      const dispatchError = await errorPromise;
      expect(dispatchError.code).toBe('INTERNAL_ERROR');

      (prisma.gameSession as unknown as { upsert: (arg: unknown) => unknown }).upsert =
        originalUpsert as unknown as (arg: unknown) => unknown;

      // The fix: the round that was actually saved is genuinely about FIXTURE_E (F failed
      // generateRound, rotation retried onto E) — the pin must reflect that immediately, with no
      // dependency on persistEngineEvents having succeeded.
      expect(getPinnedRoundFixture(brandedRoomId, { sessionIndex: 0, roundIndex: 0 })).toBe(FIXTURE_E.id);

      const record = await server.ctx.roomStore.load(brandedRoomId);
      expect(record).not.toBeNull();
      expect(record!.state.phase).toBe('playing');

      const annotation = resolveCurrentFixtureAnnotation(brandedRoomId, record!.state, record!.meta);
      expect(annotation).not.toBeNull();
      // Must match the round's actual generated content (FIXTURE_E), never fall back to F (the
      // rotation-assigned-but-failed candidate) or whatever fixture happened to be pinned/default
      // before this dispatch.
      expect(annotation!.fixtureId).toBe(FIXTURE_E.id);

      hostSocket.close();
    },
    60_000,
  );
});
