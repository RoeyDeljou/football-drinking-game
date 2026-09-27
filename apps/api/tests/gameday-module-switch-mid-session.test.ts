/**
 * Fifth QA round, "Q5": `resolveModule` (apps/api/src/engine/deps.ts) used to build a new game's
 * round from the OLD game's module whenever the room's active session was still "resumable" (not
 * yet ended) — even for `START_SESSION`, which the reducer (`reducer.ts`'s `START_SESSION` case)
 * *always* builds from `state.selection`, unconditionally, regardless of whether the previous session
 * is still resumable.
 *
 * Repro shape: play a session of M3 (needs shirt numbers) for one round on fixture F (the only live
 * fixture with shirt numbers), `ADVANCE` to `intermission` while the session is still resumable (its
 * `roundsPlanned` is not yet reached), then `SELECT_GAME` M2 (needs distinct nationalities, not shirt
 * numbers) and `START_SESSION`. Fixture E (no shirt numbers, but distinct nationalities) is live and is
 * the only fixture actually compatible with M2 — but with the bug, `resolveModule` still resolves
 * candidates against M3's data requirements (shirt numbers), which filters E out entirely, leaving only
 * F — and F fails M2's own `generateRound` (every on-pitch player shares one nationality), so the whole
 * dispatch is rejected with `ROUND_GENERATION_FAILED` even though E was a perfectly good candidate for
 * M2. The fix makes `resolveModule` resolve `START_SESSION` from `room.selection` exactly like
 * `SELECT_GAME` does, never from a still-resumable active session's module.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { COMPETITIONS, FixtureProvider, asTeamId, createInMemoryDataSource, ok } from '@fdg/football-data';
import type { Fixture, FootballDataProvider } from '@fdg/football-data';
import type { ProjectedRoom } from '@fdg/game-core';
import type { Socket as ClientSocket } from 'socket.io-client';
import type { StateTracker, TestServer } from './helpers.js';
import { connectAndTrack, jsonFetch, startTestServer, waitForEvent } from './helpers.js';

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

const startingXIFor = (teamId: string, shirtNumbers: boolean) =>
  Array.from({ length: 11 }, (_, index) => ({
    playerId: `${teamId}-p${String(index + 1)}`,
    name: `${teamId} Player ${String(index + 1)}`,
    shirtNumber: shirtNumbers ? index + 1 : null,
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
  readonly shirtNumbers: boolean;
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
  home: {
    teamId: spec.homeId,
    formation: null,
    coachName: null,
    startingXI: startingXIFor(spec.homeId, spec.shirtNumbers),
    substitutes: [],
  },
  away: {
    teamId: spec.awayId,
    formation: null,
    coachName: null,
    startingXI: startingXIFor(spec.awayId, spec.shirtNumbers),
    substitutes: [],
  },
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

/** Fixture `F`: has valid shirt numbers (so it's `M3`-compatible) but every on-pitch player shares one
 * nationality — zero unique facts for `M2`, ever. The only fixture live that `M3` can build a round
 * from; genuinely unusable by `M2`. */
const FIXTURE_F: FixtureSpec = {
  id: 'q5-shirts',
  kickoff: '2026-09-27T14:00:00.000Z',
  homeId: 'q5f-home',
  awayId: 'q5f-away',
  nationalityFor: () => 'GB',
  shirtNumbers: true,
};

/** Fixture `E`: no shirt numbers at all (so it's not `M3`-compatible), but every on-pitch player has a
 * distinct nationality — genuinely usable by `M2`. */
const FIXTURE_E: FixtureSpec = {
  id: 'q5-noshirts',
  kickoff: '2026-09-27T13:00:00.000Z',
  homeId: 'q5e-home',
  awayId: 'q5e-away',
  nationalityFor: (index) => `NAT-${String(index)}`,
  shirtNumbers: false,
};

const ALL_FIXTURES = [FIXTURE_F, FIXTURE_E];

const PROVENANCE = {
  kind: 'recorded-sample-data' as const,
  description: 'gameday-module-switch-mid-session.test.ts fixture',
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

/** Same proxy trick the other gameday test files use to force `listLiveFixtures`'s answer at will. */
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

const M3_CONFIG = {
  answerWindowMs: 15_000,
  toleranceRange: 10,
  maxDistanceSips: 5,
  noAnswerSips: 5,
  includeSubstitutes: false,
};

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
  options: { config?: unknown; fromLobby?: boolean } = {},
): Promise<void> => {
  const { config = null, fromLobby = true } = options;
  hostSocket.emit('room:action', { type: 'SELECT_GAME', actorId: playerId, moduleId, config });
  await hostState.waitFor((state) => state.selection?.moduleId === moduleId, 15_000);

  if (!fromLobby) return;

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

describe('gameday room — Q5: switching module mid-session (still resumable) via SELECT_GAME + START_SESSION', () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it(
    'START_SESSION after SELECT_GAME during a resumable intermission resolves data for the NEWLY selected module, not the old one',
    async () => {
      const inner = new FixtureProvider({ dataSource: buildScenario() });
      const { provider, setLiveOverride } = withMutableLiveFixtures(inner);
      // Both fixtures live throughout: F (shirt numbers, one shared nationality) and E (no shirt
      // numbers, distinct nationalities).
      setLiveOverride([asFixture(FIXTURE_F), asFixture(FIXTURE_E)]);
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
      const { roomToken } = createRoom.body as { roomToken: string; roomId: string };

      const host = await connectAndTrack<RoomStateWithFixture>(server, { mode: 'reconnect', roomToken });
      const hostSocket = host.socket;
      const hostState = host.state;
      const playerId = host.joined.playerId;

      // Round 0 of session 1: M3 (shirt numbers). Only F is M3-compatible (E has none) — must land on F.
      await selectAndLoad(hostSocket, hostState, playerId, 'M3', { config: M3_CONFIG });
      hostSocket.emit('room:action', { type: 'START_SESSION', actorId: playerId });
      const round0 = await hostState.waitFor(
        (state) => state.round?.status === 'open' && state.round.moduleId === 'M3',
        15_000,
      );
      expect(round0.currentFixture?.fixtureId).toBe(FIXTURE_F.id);

      // Answer and advance to intermission. `roundsPlanned` is 2, so the session is still resumable
      // (rounds.length === 1 < 2) — this is the exact state QA's Q5 repro requires.
      hostSocket.emit('room:action', {
        type: 'SUBMIT_ANSWER',
        playerId,
        roundId: round0.round!.id,
        payload: { guess: 1 },
      });
      await hostState.waitFor((state) => state.round?.status === 'resolved', 15_000);
      hostSocket.emit('room:action', { type: 'ADVANCE', actorId: playerId });
      await hostState.waitFor((state) => state.phase === 'intermission', 15_000);

      // Host switches to M2 while the M3 session is still resumable, then starts a brand-new session.
      await selectAndLoad(hostSocket, hostState, playerId, 'M2', {
        config: M2_NATIONALITY_ONLY_CONFIG,
        fromLobby: false,
      });

      const errorPromise = waitForEvent<RoomError>(hostSocket, 'room:error');
      const playingPromise = hostState.waitFor(
        (state) => state.round?.status === 'open' && state.round.moduleId === 'M2',
        15_000,
      );
      hostSocket.emit('room:action', { type: 'START_SESSION', actorId: playerId });

      // The fix: this must succeed outright on E (the only M2-compatible fixture) — never reject with
      // ROUND_GENERATION_FAILED (QA's exact observed symptom when `resolveModule` still thought the
      // module was M3, filtered E out of the candidate pool, and left only F — which fails M2's own
      // `generateRound` since every one of F's on-pitch players shares one nationality).
      const outcome = await Promise.race([
        playingPromise.then((state) => ({ kind: 'playing' as const, state })),
        errorPromise.then((error) => ({ kind: 'error' as const, error })),
      ]);
      if (outcome.kind === 'error') {
        throw new Error(`expected START_SESSION to succeed on fixture E, got room:error ${JSON.stringify(outcome.error)}`);
      }
      expect(outcome.state.currentFixture?.fixtureId).toBe(FIXTURE_E.id);

      hostSocket.close();
    },
    60_000,
  );
});
