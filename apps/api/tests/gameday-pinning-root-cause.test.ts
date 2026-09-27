/**
 * Root-cause regression coverage for the recurring "gameday pinning" bug class (fourth QA round).
 *
 * Every previous fix (`gameday-pinning-fixes.test.ts`, `gameday-room-fixes.test.ts`) narrowed WHEN a
 * fixture pin gets written (only from the one dispatch genuinely about to call `generateRound`), but
 * never addressed WHETHER a failed attempt gets cleaned up: `pinRoundFixture` used to be called from
 * `data-context.ts` *before* `reduceRoom` ran at all, so a rejected generation attempt (any reason —
 * `ROUND_GENERATION_FAILED`, `NOT_ENOUGH_PLAYERS`, `LOADING_INCOMPLETE`, …) still left a pin behind,
 * wedging every later retry for that same round key onto the same (possibly now-dead, possibly
 * never-actually-playable) fixture forever.
 *
 * The fix (`apps/api/src/engine/data-context.ts`'s `RoundDataResolution`, `apps/api/src/engine/deps.ts`'s
 * `EngineDepsResolution`, `apps/api/src/engine/dispatch.ts`'s `reduceWithCandidates`) moves the actual
 * `pinRoundFixture` write to *after* `reduceRoom` has accepted a round, and lets one dispatch try
 * several rotation candidates against the reducer in turn before giving up — see each function's own
 * doc comment for the full mechanism.
 *
 * This file covers the three concrete repros QA gave:
 * - T1: a rejected `START_SESSION` for one module, with only one (unplayable-for-it) fixture live,
 *   must not wedge a *different* module's later `START_SESSION` onto that same fixture once a second,
 *   genuinely-suitable fixture is live.
 * - T2: same shape, but the fixture the failed attempt would have pinned actually leaves the live set
 *   before the retry — the retry must land on whatever is live now, never the dead one.
 * - T6: mid-session `ADVANCE`, rotation's assigned candidate fails `generateRound` for a genuinely
 *   fixture-specific, quality-flag-invisible reason (its one usable piece of content was already used
 *   earlier in this same session) while another live fixture could still serve the round — a single
 *   `ADVANCE` must succeed by falling back to that other fixture, not reject.
 *
 * Every failure below is engineered to pass `checkModulePlayable`'s boolean quality gate (so the old,
 * buggy `pickAndPinFixture` really would have selected and pinned that fixture) while still genuinely
 * failing the module's own `generateRound` — `assessFixtureDataQuality`'s flags are booleans
 * ("has any lineup, has any shirt number") that cannot see "every on-pitch fact happens to be
 * identical" or "this session already asked about the only distinguishing fact this fixture has".
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

/** 11 starters for one side of a fixture. `shirtNumbers` toggles whether every starter gets a valid
 * number — the (quality-flag-invisible) lever `M3`'s `generateRound` genuinely fails on when false
 * across every lineup player. Nationality (the equivalent lever for `M2`) lives on `Player`, not
 * `LineupPlayer`, so it is assigned separately in `playerFor`. */
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
  /** Per-side, per-index nationality assignment — controls how many *unique* on-pitch facts `M2`
   * can find (0 for a fixture whose `generateRound` must fail; exactly 1 for a fixture whose single
   * usable fact runs out after one round; all-distinct for a fixture that never runs out). */
  readonly nationalityFor: (index: number) => string;
  readonly shirtNumbers: boolean;
  readonly withLiveEvent: boolean;
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
  events: spec.withLiveEvent ? [goalEvent(spec.id, spec.homeId)] : [],
  teamStats: [],
  playerStats: [],
});

/** Fixture `A`: totally unusable for `M2` (every on-pitch player shares one nationality — zero unique
 * facts, ever) and for `M3` (no shirt numbers at all) — while still passing both modules'
 * `checkModulePlayable` quality gate (`hasLineups`, `hasPlayerSeasonStats` are both true; only
 * `hasShirtNumbers` is false, which only excludes it from `M3`, never `M2`). */
const FIXTURE_A: FixtureSpec = {
  id: 'rc-thin',
  kickoff: '2026-09-27T14:00:00.000Z',
  homeId: 'thin-home',
  awayId: 'thin-away',
  nationalityFor: () => 'GB',
  shirtNumbers: false,
  withLiveEvent: true,
};

/** Fixture `B`: fully rich — every on-pitch player has a distinct nationality (so `M2` always has
 * plenty of fresh unique facts) and a valid shirt number (so `M3` always has plenty of fresh
 * candidates). Used as "whatever fixture should legitimately win the retry". */
const FIXTURE_B: FixtureSpec = {
  id: 'rc-rich-1',
  kickoff: '2026-09-27T13:00:00.000Z',
  homeId: 'rich1-home',
  awayId: 'rich1-away',
  nationalityFor: (index) => `NAT-${String(index)}`,
  shirtNumbers: true,
  withLiveEvent: true,
};

/** Fixture `C`: a second, independent "fully rich" fixture — used as the one that becomes newly live
 * in T2, distinct from `B` so a test can tell "landed on the fixture that just joined" apart from
 * "landed on some other already-known rich fixture". */
const FIXTURE_C: FixtureSpec = {
  id: 'rc-rich-2',
  kickoff: '2026-09-27T15:00:00.000Z',
  homeId: 'rich2-home',
  awayId: 'rich2-away',
  nationalityFor: (index) => `LAND-${String(index)}`,
  shirtNumbers: true,
  withLiveEvent: true,
};

/** Fixture `D`: exactly one usable `M2` fact (one player of 22 has a distinct nationality, everyone
 * else shares one) — genuinely playable per quality flags, genuinely exhausted after exactly one round
 * of `M2` within a session (T6's lever). */
const FIXTURE_D: FixtureSpec = {
  id: 'rc-onefact',
  kickoff: '2026-09-27T12:00:00.000Z',
  homeId: 'onefact-home',
  awayId: 'onefact-away',
  nationalityFor: (index) => (index === 0 ? 'FR' : 'GB'),
  shirtNumbers: true,
  withLiveEvent: true,
};

const ALL_FIXTURES = [FIXTURE_A, FIXTURE_B, FIXTURE_C, FIXTURE_D];

const PROVENANCE = {
  kind: 'recorded-sample-data' as const,
  description: 'gameday-pinning-root-cause.test.ts fixture',
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

/** Every fixture used by any test in this file lives in one dataset — which ones are actually "live"
 * at any given moment is controlled entirely by `withMutableLiveFixtures`' override, never by what is
 * present here. */
function buildRootCauseScenario() {
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

/** Same proxy trick `gameday-room.test.ts`/`gameday-pinning-fixes.test.ts` use to force
 * `listLiveFixtures`' answer at will, in whatever order the test wants (rotation order follows this
 * array verbatim while an override is active). */
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

/** A single-market M1 config — long-running-bet, closed with `END_SESSION` rather than a submit/lock/
 * reveal cycle, purely to get a throwaway "game 1" out of the way so the room reaches `intermission`
 * (where `SELECT_GAME` is legal again) without caring about its own content. */
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

/** An `M2` config restricted to one fact kind so this file's nationality-uniqueness lever is the only
 * thing that decides whether a round can be generated. */
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('gameday room — root-cause pinning fix (commit-time pin, retry-across-candidates)', () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it(
    'T1: a rejected START_SESSION for one module does not wedge a later, different module onto the same dead-end fixture',
    async () => {
      const inner = new FixtureProvider({ dataSource: buildRootCauseScenario() });
      const { provider, setLiveOverride } = withMutableLiveFixtures(inner);
      setLiveOverride([asFixture(FIXTURE_B), asFixture(FIXTURE_A)]);
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

      // Game 1: a throwaway M1 session on whichever fixture — its own content is irrelevant, it only
      // exists to get the room into `intermission` (where `SELECT_GAME` is legal again) with a
      // finished session behind it, exactly like QA's repro narrative.
      await selectAndLoad(hostSocket, hostState, playerId, 'M1', { config: M1_SINGLE_MARKET_CONFIG });
      hostSocket.emit('room:action', { type: 'START_SESSION', actorId: playerId });
      await hostState.waitFor((state) => state.round?.status === 'open' && state.round.moduleId === 'M1', 15_000);
      hostSocket.emit('room:action', { type: 'END_SESSION', actorId: playerId });
      await hostState.waitFor((state) => state.phase === 'intermission', 15_000);

      // Drop fixture B: only the totally-unusable-for-M2-or-M3 fixture A is live now.
      setLiveOverride([asFixture(FIXTURE_A)]);
      await sleep(400);

      // Game 2, attempt 1: M2 — genuinely rejected (A's 22 on-pitch players share one nationality, so
      // `generateRound` can never find a unique fact), with no other live fixture to fall back to.
      await selectAndLoad(hostSocket, hostState, playerId, 'M2', {
        config: M2_NATIONALITY_ONLY_CONFIG,
        fromLobby: false,
      });
      const errorPromise = waitForEvent<RoomError>(hostSocket, 'room:error');
      hostSocket.emit('room:action', { type: 'START_SESSION', actorId: playerId });
      const roundGenerationError = await errorPromise;
      expect(roundGenerationError.code).toBe('ROUND_GENERATION_FAILED');

      // The fix: this rejected attempt must not have pinned round (session 1, round 0) to A at all.
      expect(getPinnedRoundFixture(brandedRoomId, { sessionIndex: 1, roundIndex: 0 })).toBeNull();

      // Fixture B (which A can never substitute for — M3 needs shirt numbers, A has none) rejoins.
      setLiveOverride([asFixture(FIXTURE_B), asFixture(FIXTURE_A)]);
      await sleep(400);

      // Game 2, attempt 2: same round key, a DIFFERENT module (M3). Must land on B, never retry A —
      // which the old speculative pre-reduce pin would have forced regardless of M3's own requirements.
      await selectAndLoad(hostSocket, hostState, playerId, 'M3', { fromLobby: false });
      hostSocket.emit('room:action', { type: 'START_SESSION', actorId: playerId });
      const playing = await hostState.waitFor(
        (state) => state.round?.status === 'open' && state.round.moduleId === 'M3',
        15_000,
      );
      expect(playing.currentFixture?.fixtureId).toBe(FIXTURE_B.id);
      expect(getPinnedRoundFixture(brandedRoomId, { sessionIndex: 1, roundIndex: 0 })).toBe(FIXTURE_B.id);

      hostSocket.close();
    },
    60_000,
  );

  it(
    'T2: a rejected START_SESSION leaving a would-be pin on a fixture that then leaves the live set — retry lands on whatever is live now',
    async () => {
      const inner = new FixtureProvider({ dataSource: buildRootCauseScenario() });
      const { provider, setLiveOverride } = withMutableLiveFixtures(inner);
      // Only the dead-end fixture is live at first — the rejected attempt has nothing else to try.
      setLiveOverride([asFixture(FIXTURE_A)]);
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

      await selectAndLoad(hostSocket, hostState, playerId, 'M2', { config: M2_NATIONALITY_ONLY_CONFIG });

      const errorPromise = waitForEvent<RoomError>(hostSocket, 'room:error');
      hostSocket.emit('room:action', { type: 'START_SESSION', actorId: playerId });
      const roundGenerationError = await errorPromise;
      expect(roundGenerationError.code).toBe('ROUND_GENERATION_FAILED');
      expect(getPinnedRoundFixture(brandedRoomId, { sessionIndex: 0, roundIndex: 0 })).toBeNull();

      // Fixture A leaves the live set entirely; a brand-new fixture C (never seen before) becomes live.
      setLiveOverride([asFixture(FIXTURE_C)]);
      await sleep(400);

      // Retry, same module, same room, same round key. Must land on C — the currently-live fixture —
      // never attempt (or resolve to) A, which is not merely unplayable now but gone from the pool.
      hostSocket.emit('room:action', { type: 'START_SESSION', actorId: playerId });
      const playing = await hostState.waitFor(
        (state) => state.round?.status === 'open' && state.round.moduleId === 'M2',
        15_000,
      );
      expect(playing.currentFixture?.fixtureId).toBe(FIXTURE_C.id);
      expect(getPinnedRoundFixture(brandedRoomId, { sessionIndex: 0, roundIndex: 0 })).toBe(FIXTURE_C.id);

      hostSocket.close();
    },
    60_000,
  );

  it(
    'T6: mid-session ADVANCE whose assigned rotation candidate fails generateRound falls back to another live fixture in the same dispatch',
    async () => {
      const inner = new FixtureProvider({ dataSource: buildRootCauseScenario() });
      const { provider, setLiveOverride } = withMutableLiveFixtures(inner);
      // D (one usable fact) first, B (never runs out) second — round-robin assigns round 0 -> D,
      // round 1 -> B, round 2 -> D again (2 % 2 == 0), by which point D's one usable fact is spent.
      setLiveOverride([asFixture(FIXTURE_D), asFixture(FIXTURE_B)]);
      server = await startTestServer({ footballData: provider });

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
      const { roomToken, roomId } = createRoom.body as { roomToken: string; roomId: string };
      const brandedRoomId = asRoomId(roomId);

      const host = await connectAndTrack<RoomStateWithFixture>(server, { mode: 'reconnect', roomToken });
      const hostSocket = host.socket;
      const hostState = host.state;
      const playerId = host.joined.playerId;

      await selectAndLoad(hostSocket, hostState, playerId, 'M2', { config: M2_NATIONALITY_ONLY_CONFIG });
      hostSocket.emit('room:action', { type: 'START_SESSION', actorId: playerId });

      const fixturesSeen: string[] = [];
      for (let round = 0; round < 4; round += 1) {
        const playing = await hostState.waitFor(
          (state) => state.round?.status === 'open' && state.round.index === round && state.round.moduleId === 'M2',
          15_000,
        );
        expect(playing.currentFixture).not.toBeNull();
        fixturesSeen.push(playing.currentFixture!.fixtureId);

        const options = (playing.round!.publicPayload as { options: readonly { playerId: string }[] }).options;
        const guessPlayerId = options[0]?.playerId;
        expect(guessPlayerId).toBeDefined();

        hostSocket.emit('room:action', {
          type: 'SUBMIT_ANSWER',
          playerId,
          roundId: playing.round!.id,
          payload: { playerId: guessPlayerId },
        });
        await hostState.waitFor((state) => state.round?.status === 'resolved', 15_000);

        hostSocket.emit('room:action', { type: 'ADVANCE', actorId: playerId });
        await hostState.waitFor((state) => state.phase === 'intermission', 15_000);
        if (round < 3) {
          // A single ADVANCE must succeed outright here — no `room:error` in between — even for round
          // 2, whose *assigned* rotation candidate (D) can no longer generate a round at all.
          hostSocket.emit('room:action', { type: 'ADVANCE', actorId: playerId });
        }
      }

      expect(fixturesSeen[0]).toBe(FIXTURE_D.id);
      expect(fixturesSeen[1]).toBe(FIXTURE_B.id);
      // The whole point: round 2 was assigned to D by rotation, but D's only usable fact was already
      // spent in round 0 — the fix must have silently fallen back to B within that one ADVANCE.
      expect(fixturesSeen[2]).toBe(FIXTURE_B.id);
      expect(getPinnedRoundFixture(brandedRoomId, { sessionIndex: 0, roundIndex: 2 })).toBe(FIXTURE_B.id);

      hostSocket.close();
    },
    60_000,
  );
});
