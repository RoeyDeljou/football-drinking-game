/**
 * Regression coverage for two more gameday-mode defects a QA gate found in the pin-keying code
 * (`apps/api/src/engine/data-context.ts`):
 *
 * - Defect 1: a pin created by a mere `SELECT_GAME` playability probe (or a `TICK`/`SUBMIT_ANSWER`
 *   on the currently-open round) used to be written for whichever `RoundKey` a *future* round would
 *   resolve to, even though none of those actions ever call the module's `generateRound` — only
 *   `START_SESSION` and the `ADVANCE` that actually builds the next round do. A stale pin from one of
 *   those non-generating dispatches could then wrongly reuse a fixture that cannot support a
 *   *different* module the host later picks, even when other live fixtures could. Fixed by only ever
 *   writing a pin from the one dispatch that is genuinely about to generate that round
 *   (`isGenuineRoundGeneration` in `data-context.ts`).
 * - Defect 2: `runGamedayPrefetch` used to replace the whole cached `GamedayBundle` wholesale on every
 *   run, discarding `bundle.fixtures` for any fixture the fresh poll no longer considers live — even
 *   though a round already pinned to that fixture (genuinely, by generation) must be able to resolve
 *   it for as long as that round is referenced. Fixed by merging `bundle.fixtures` (grow-only) across
 *   prefetch re-runs, replacing only `fixtureOrder` (rotation eligibility) with the fresh poll.
 *
 * Also covers the rotation-skew fix (an unplayable fixture's rotation successor no longer gets a
 * disproportionate share of rounds) and the specific multi-game regression QA asked for: 3+
 * back-to-back games in one room, the live set changing between every game, the host picking a
 * different module for at least one game, checking every round's content against its announced
 * fixture (not just round 0 of each game).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { COMPETITIONS, FixtureProvider, asTeamId, createInMemoryDataSource, ok } from '@fdg/football-data';
import type { Fixture, FootballDataProvider } from '@fdg/football-data';
import type { ProjectedRoom } from '@fdg/game-core';
import { asRoomId } from '@fdg/game-core';
import type { Socket as ClientSocket } from 'socket.io-client';
import { runGamedayPrefetch } from '../src/engine/data-context.js';
import { getCachedGameday, getPinnedRoundFixture } from '../src/engine/gameday-cache.js';
import { dispatchAction } from '../src/engine/dispatch.js';
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

const PROVENANCE = {
  kind: 'recorded-sample-data' as const,
  description: 'gameday-pinning-fixes.test.ts fixture',
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

/** Three simultaneously-live Premier League fixtures, kickoff-ordered arsenal < chelsea < spurs.
 * `gd-arsenal` has full lineups but NO live events (`hasLiveEvents` false — M1 can never be generated
 * from it, but M3 can, since M3 only needs `hasLineups`+`hasShirtNumbers`). `gd-chelsea`/`gd-spurs`
 * have both lineups and a live event each, so both M1 and M3 can be generated from either. */
function buildMixedPlayabilityScenario() {
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
  const liveStates = [
    { fixtureId: 'gd-arsenal', updatedAt: '2026-09-27T14:42:00.000Z', events: [], teamStats: [], playerStats: [] },
    {
      fixtureId: 'gd-chelsea',
      updatedAt: '2026-09-27T14:42:00.000Z',
      events: [goalEvent('gd-chelsea', 'chelsea')],
      teamStats: [],
      playerStats: [],
    },
    {
      fixtureId: 'gd-spurs',
      updatedAt: '2026-09-27T14:42:00.000Z',
      events: [goalEvent('gd-spurs', 'spurs')],
      teamStats: [],
      playerStats: [],
    },
  ];

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

/** Same three fixtures, all fully playable by both M1 and M3 (every fixture has lineups + a live
 * event) — used for the multi-game / rotation-skew scenarios where playability itself is not what's
 * under test. */
function buildFullyPlayableScenario() {
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
  const liveStates = [
    { fixtureId: 'gd-arsenal', events: [goalEvent('gd-arsenal', 'arsenal')] },
    { fixtureId: 'gd-chelsea', events: [goalEvent('gd-chelsea', 'chelsea')] },
    { fixtureId: 'gd-spurs', events: [goalEvent('gd-spurs', 'spurs')] },
  ].map((entry) => ({ ...entry, updatedAt: '2026-09-27T14:42:00.000Z', teamStats: [], playerStats: [] }));

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

/** Same three fixtures, but `gd-arsenal` has no lineup data at all, so neither M1 nor M3 can ever be
 * generated from it — used for the rotation-skew regression. */
function buildOneUnplayableScenario() {
  const arsenal = recordedFixture('gd-arsenal', '2026-09-27T14:00:00.000Z', 'arsenal', 'leeds');
  const chelsea = recordedFixture('gd-chelsea', '2026-09-27T14:30:00.000Z', 'chelsea', 'bournemouth');
  const spurs = recordedFixture('gd-spurs', '2026-09-27T15:00:00.000Z', 'spurs', 'everton');

  const teams = ['arsenal', 'leeds', 'chelsea', 'bournemouth', 'spurs', 'everton'];
  const players = teams.flatMap((teamId) => Array.from({ length: 11 }, (_, index) => player(teamId, index)));
  const lineups = [
    { fixtureId: 'gd-arsenal', home: { teamId: 'arsenal', formation: null, coachName: null, startingXI: [], substitutes: [] }, away: { teamId: 'leeds', formation: null, coachName: null, startingXI: [], substitutes: [] }, confirmed: false },
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

const FIXTURE_TEAM_IDS: Record<string, readonly string[]> = {
  'gd-arsenal': ['arsenal', 'leeds'],
  'gd-chelsea': ['chelsea', 'bournemouth'],
  'gd-spurs': ['spurs', 'everton'],
};

/** A single-market M1 config — the default config's 11 markets would each need their own valid pick
 * in every submission below; one market (`MATCH_RESULT`, always exactly HOME/DRAW/AWAY regardless of
 * lineups) keeps the submissions in this file simple without touching M1's actual behaviour. */
const M1_SINGLE_MARKET_CONFIG = {
  markets: ['MATCH_RESULT'],
  goalsLine: 2.5,
  cornersLine: 9.5,
  cardsLine: 3.5,
  scorerOptionCount: 5,
  slipWindowMs: 300_000,
  sipsPerLostMarket: 1,
  worstSlipSips: 3,
  perfectSlipSips: 2,
  noAnswerSips: 4,
};

/** `START_LOADING` is only valid from `lobby` (or a retried, failed `loading`) — never from
 * `intermission` (see `reducer.ts`'s `START_LOADING` case). A second-or-later game in the same room
 * starts fresh straight from `intermission`: `SELECT_GAME` + `START_SESSION`, no loading round-trip,
 * reusing the already-cached gameday bundle — same as `gameday-room-fixes.test.ts`'s "D1" case. */
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

/** Plays exactly one game (one `SELECT_GAME`+`START_SESSION` session) to completion, checking every
 * round's ACTUAL generated content (`publicPayload.target.teamId`, M3's shape) against its announced
 * `currentFixture`, and returns the sequence of fixture ids seen. */
const playM3GameToCompletion = async (
  hostSocket: ClientSocket,
  hostState: StateTracker<RoomStateWithFixture>,
  playerId: string,
  roundsPlanned: number,
  fromLobby = true,
): Promise<string[]> => {
  await selectAndLoad(hostSocket, hostState, playerId, 'M3', { fromLobby });
  hostSocket.emit('room:action', { type: 'START_SESSION', actorId: playerId });

  const fixtures: string[] = [];
  for (let round = 0; round < roundsPlanned; round += 1) {
    // Also require `moduleId === 'M3'`: a room's `round` projection can still show the PREVIOUS
    // game's un-resolved round (e.g. one closed out via `END_SESSION` rather than reveal) during the
    // brief window between this `START_SESSION`/`ADVANCE` dispatch and its own round actually landing
    // — matching on status+index alone risks grabbing that stale round instead of waiting for this
    // game's own.
    const playing = await hostState.waitFor(
      (state) => state.round?.status === 'open' && state.round.index === round && state.round.moduleId === 'M3',
      15_000,
    );
    expect(playing.currentFixture).not.toBeNull();
    const fixtureId = playing.currentFixture!.fixtureId;
    fixtures.push(fixtureId);

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
    if (round < roundsPlanned - 1) {
      hostSocket.emit('room:action', { type: 'ADVANCE', actorId: playerId });
    }
  }
  return fixtures;
};

describe('gameday room — pinning defects 1 & 2 regression coverage', () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it(
    'defect 1: a SELECT_GAME probe for one module does not jam a later, different module',
    async () => {
      const provider = new FixtureProvider({ dataSource: buildMixedPlayabilityScenario() });
      server = await startTestServer({ footballData: provider });

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

      // Host taps M3 first (only needs hasShirtNumbers — gd-arsenal, the rotation-first fixture,
      // supports it). This is a mere playability probe: nothing has been pinned by it.
      hostSocket.emit('room:action', { type: 'SELECT_GAME', actorId: playerId, moduleId: 'M3', config: null });
      await hostState.waitFor((state) => state.selection?.moduleId === 'M3', 15_000);
      expect(getPinnedRoundFixture(brandedRoomId, { sessionIndex: 0, roundIndex: 0 })).toBeNull();

      // Host changes their mind and picks M1 (needs hasLiveEvents — gd-arsenal cannot support it, but
      // gd-chelsea/gd-spurs can). Must succeed: the M3 probe must never have locked round (0,0) to
      // gd-arsenal.
      hostSocket.emit('room:action', { type: 'SELECT_GAME', actorId: playerId, moduleId: 'M1', config: null });
      const selected = await hostState.waitFor((state) => state.selection?.moduleId === 'M1', 15_000);
      expect(selected.selection?.moduleId).toBe('M1');
      // Still no pin — SELECT_GAME never writes one, genuine or not.
      expect(getPinnedRoundFixture(brandedRoomId, { sessionIndex: 0, roundIndex: 0 })).toBeNull();

      hostSocket.emit('room:action', {
        type: 'START_LOADING',
        actorId: playerId,
        stepKeys: ['fixture', 'lineups', 'squads', 'stats'],
      });
      await hostState.waitFor(
        (state) => state.loading?.steps.every((step) => step.status === 'done' || step.status === 'failed') === true,
        30_000,
      );

      hostSocket.emit('room:action', { type: 'START_SESSION', actorId: playerId });
      const playing = await hostState.waitFor(
        (state) => state.round?.status === 'open' && state.round?.index === 0,
        15_000,
      );
      // Round 0 must have gone to a fixture that actually supports M1 — never gd-arsenal.
      expect(playing.currentFixture).not.toBeNull();
      expect(['gd-chelsea', 'gd-spurs']).toContain(playing.currentFixture!.fixtureId);

      hostSocket.close();
    },
    60_000,
  );

  it(
    'regression: a TICK on the currently-open round never pins the next round ahead of schedule',
    async () => {
      const provider = new FixtureProvider({ dataSource: buildFullyPlayableScenario() });
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
      const { roomToken, roomId } = createRoom.body as { roomToken: string; roomId: string };
      const brandedRoomId = asRoomId(roomId);

      const host = await connectAndTrack<RoomStateWithFixture>(server, { mode: 'reconnect', roomToken });
      const hostSocket = host.socket;
      const hostState = host.state;
      const playerId = host.joined.playerId;

      await selectAndLoad(hostSocket, hostState, playerId, 'M3');
      hostSocket.emit('room:action', { type: 'START_SESSION', actorId: playerId });
      await hostState.waitFor((state) => state.round?.status === 'open' && state.round?.index === 0, 15_000);

      // Round 0 is open (genuinely generated and pinned). Fire several TICKs directly — these must
      // never write a pin for round 1, which has not been generated yet.
      for (let i = 0; i < 5; i += 1) {
        const outcome = await dispatchAction(server.ctx, brandedRoomId, { type: 'TICK' });
        expect(outcome).not.toBeNull();
      }
      expect(getPinnedRoundFixture(brandedRoomId, { sessionIndex: 0, roundIndex: 1 })).toBeNull();

      hostSocket.close();
    },
    60_000,
  );

  it(
    'defect 2: a genuinely-pinned round keeps resolving its fixture after a gameday prefetch re-run drops it from the live set',
    async () => {
      const inner = new FixtureProvider({ dataSource: buildFullyPlayableScenario() });
      const { provider, setLiveOverride } = withMutableLiveFixtures(inner);
      server = await startTestServer({ footballData: provider });

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

      await selectAndLoad(hostSocket, hostState, playerId, 'M3');
      hostSocket.emit('room:action', { type: 'START_SESSION', actorId: playerId });
      const playing = await hostState.waitFor(
        (state) => state.round?.status === 'open' && state.round?.index === 0,
        15_000,
      );
      const pinnedFixtureId = playing.currentFixture!.fixtureId;
      expect(pinnedFixtureId).toBe('gd-arsenal');

      // gd-arsenal leaves the live set, then a fresh gameday prefetch runs (as `START_LOADING` would
      // trigger for a later game) — simulated directly, bypassing the loading screen's own timing.
      const live = await inner.listLiveFixtures(PL.id);
      expect(live.ok).toBe(true);
      if (live.ok) setLiveOverride(live.value.filter((fixture) => fixture.id !== 'gd-arsenal'));

      const fresh = await runGamedayPrefetch(server.ctx, brandedRoomId, PL.id);
      expect(fresh).not.toBeNull();
      expect(fresh?.fixtures.map((bundle) => bundle.fixture.id)).not.toContain('gd-arsenal');

      // The cache's `bundle.fixtures` must still carry gd-arsenal (grow-only merge) even though the
      // fresh prefetch no longer includes it — only `fixtureOrder` should reflect the fresh live set.
      const entry = getCachedGameday(brandedRoomId);
      expect(entry).not.toBeNull();
      expect(entry?.bundle.fixtures.map((bundle) => bundle.fixture.id)).toContain('gd-arsenal');
      expect(entry?.fixtureOrder).not.toContain('gd-arsenal');

      // The already-generated, already-pinned round must still resolve its real fixture — the
      // "now playing" banner must not go blank, and `ADVANCE` (closing this round out) must not hit
      // `ROUND_GENERATION_FAILED`.
      hostSocket.emit('room:action', {
        type: 'SUBMIT_ANSWER',
        playerId,
        roundId: playing.round!.id,
        payload: { guess: 1 },
      });
      const resolved = await hostState.waitFor((state) => state.round?.status === 'resolved', 15_000);
      expect(resolved.currentFixture?.fixtureId).toBe('gd-arsenal');

      hostSocket.emit('room:action', { type: 'ADVANCE', actorId: playerId });
      const intermission = await hostState.waitFor((state) => state.phase === 'intermission', 15_000);
      expect(intermission.currentFixture?.fixtureId).toBe('gd-arsenal');

      hostSocket.close();
    },
    60_000,
  );

  it(
    'rotation is even across playable candidates when one fixture in the pool is unplayable',
    async () => {
      const provider = new FixtureProvider({ dataSource: buildOneUnplayableScenario() });
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
      const { roomToken } = createRoom.body as { roomToken: string };

      const host = await connectAndTrack<RoomStateWithFixture>(server, { mode: 'reconnect', roomToken });
      const hostSocket = host.socket;
      const hostState = host.state;
      const playerId = host.joined.playerId;

      const seenFixtureIds = await playM3GameToCompletion(hostSocket, hostState, playerId, 6);

      expect(seenFixtureIds).not.toContain('gd-arsenal');
      const counts = new Map<string, number>();
      for (const fixtureId of seenFixtureIds) counts.set(fixtureId, (counts.get(fixtureId) ?? 0) + 1);
      // Even split across the two playable fixtures — 3 rounds each, never 2/4 (the rotation-successor
      // skew a plain modulo-over-the-full-pool walk used to produce).
      expect(counts.get('gd-chelsea')).toBe(3);
      expect(counts.get('gd-spurs')).toBe(3);

      hostSocket.close();
    },
    60_000,
  );

  it(
    '3+ back-to-back games, live set changing between every game and a different module for one game, every round matches its announced fixture',
    async () => {
      const inner = new FixtureProvider({ dataSource: buildFullyPlayableScenario() });
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

      // Game 1: M3, all three fixtures live.
      const game1 = await playM3GameToCompletion(hostSocket, hostState, playerId, 2);
      expect(game1).toEqual(['gd-arsenal', 'gd-chelsea']);

      // Live set changes before game 2: gd-arsenal drops out.
      const live1 = await inner.listLiveFixtures(PL.id);
      expect(live1.ok).toBe(true);
      if (live1.ok) setLiveOverride(live1.value.filter((fixture) => fixture.id !== 'gd-arsenal'));
      await new Promise((resolve) => setTimeout(resolve, 400));

      // Game 2: host picks a DIFFERENT module (M1) this time — single round is enough to check "every
      // round" of this game (M1 is a long-running-bet that only resolves on a live event `apps/api`
      // does not yet poll for, so `END_SESSION` — valid straight from `playing`, per `reducer.ts` —
      // closes it out without needing a full submit/lock/reveal cycle).
      await selectAndLoad(hostSocket, hostState, playerId, 'M1', {
        config: M1_SINGLE_MARKET_CONFIG,
        fromLobby: false,
      });
      hostSocket.emit('room:action', { type: 'START_SESSION', actorId: playerId });
      const game2Round = await hostState.waitFor(
        (state) => state.round?.status === 'open' && state.round.index === 0 && state.round.moduleId === 'M1',
        15_000,
      );
      expect(game2Round.currentFixture).not.toBeNull();
      // M1's public payload has its own shape (markets), but the round must still be announced against
      // (and only against) a fixture that is actually live right now.
      expect(['gd-chelsea', 'gd-spurs']).toContain(game2Round.currentFixture!.fixtureId);
      expect((game2Round.round!.publicPayload as { kind: string }).kind).toBe('MATCH_MARKETS');

      hostSocket.emit('room:action', { type: 'END_SESSION', actorId: playerId });
      await hostState.waitFor((state) => state.phase === 'intermission', 15_000);

      // Live set changes again before game 3: gd-chelsea drops out too (only gd-spurs left, plus
      // gd-arsenal, which never came back).
      const live2 = await inner.listLiveFixtures(PL.id);
      expect(live2.ok).toBe(true);
      if (live2.ok) setLiveOverride(live2.value.filter((fixture) => fixture.id === 'gd-spurs'));
      await new Promise((resolve) => setTimeout(resolve, 400));

      // Game 3: back to M3, rotation must restart from the top of the NEW live set, not continue any
      // prior game's round count or fixture choice.
      const game3 = await playM3GameToCompletion(hostSocket, hostState, playerId, 2, false);
      expect(game3).toEqual(['gd-spurs', 'gd-spurs']);

      hostSocket.close();
    },
    90_000,
  );
});
