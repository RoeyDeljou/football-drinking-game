/**
 * Test-only fixtures and helpers. Excluded from the package build (see tsconfig `exclude`).
 */

import type {
  Fixture,
  FixtureLineups,
  FootballPlayerId,
  LineupPlayer,
  MatchEvent,
  MatchEventType,
  Player,
  PlayerProfile,
  PlayerSeasonStats,
  Team,
  TeamId,
  DataQuality,
  CompetitionId,
  SeasonId,
  FixtureId,
  PlayerPosition,
} from '@fdg/football-data';
import type { RoundDataContext } from './data.js';
import type { PlayerId } from './ids.js';
import { asPlayerId, asRoundId, asSessionId } from './ids.js';
import type {
  EngineGameModule,
  GeneratedRound,
  GenerateRoundResult,
  ModuleShape,
  RoundPlayerView,
  RoundView,
  TypedSubmission,
} from './module.js';
import type { EngineDeps } from './reducer.js';
import type { GameModuleRegistry } from './modules/registry.js';
import { createDefaultRegistry } from './modules/registry.js';
import type { ControllableClock } from './ports.js';
import { createControllableClock, createSeededRng, MULBERRY32 } from './ports.js';
import type { RoomState } from './state.js';
import { createRoom } from './state.js';
import { asRoomId } from './ids.js';

export const T0 = 1_700_000_000_000;

const brand = <T extends string>(value: string): T => value as T;

export const HOME_TEAM_ID = brand<TeamId>('team-home');
export const AWAY_TEAM_ID = brand<TeamId>('team-away');
export const FIXTURE_ID = brand<FixtureId>('fixture-1');
const COMPETITION_ID = brand<CompetitionId>('comp-pl');
const SEASON_ID = brand<SeasonId>('2024');

const POSITIONS: readonly PlayerPosition[] = [
  'GK',
  'DF',
  'DF',
  'DF',
  'DF',
  'MF',
  'MF',
  'MF',
  'FW',
  'FW',
  'FW',
];
const NATIONS = [
  'England',
  'England',
  'Spain',
  'Brazil',
  'France',
  'France',
  'Italy',
  'Japan',
  'Norway',
  'Ghana',
  'Peru',
];

const team = (id: TeamId, name: string): Team => ({
  id,
  name,
  shortName: name.slice(0, 3).toUpperCase(),
  crestUrl: null,
  country: 'England',
});

export const HOME_TEAM = team(HOME_TEAM_ID, 'Home City');
export const AWAY_TEAM = team(AWAY_TEAM_ID, 'Away United');

interface BuiltPlayer {
  readonly player: Player;
  readonly lineup: LineupPlayer;
  readonly stats: PlayerSeasonStats;
  readonly profile: PlayerProfile;
}

const buildPlayer = (teamId: TeamId, index: number, offset: number, teamLabel: string): BuiltPlayer => {
  const id = brand<FootballPlayerId>(`${teamLabel}-p${index + 1}`);
  const shirtNumber = offset + index + 1;
  const position = POSITIONS[index] ?? 'UNKNOWN';
  const player: Player = {
    id,
    name: `${teamLabel} Player ${index + 1}`,
    fullName: null,
    nationality: NATIONS[index] ?? 'Wales',
    dateOfBirth: null,
    // Unique across all 22 so age is always a uniquely identifying fact.
    age: 19 + offset / 11 + index * 1,
    heightCm: 165 + offset + index,
    position,
    shirtNumber,
    teamId,
    photoUrl: null,
    marketValueEur: 1_000_000 * (index + 1 + offset),
  };
  return {
    player,
    lineup: {
      playerId: id,
      name: player.name,
      shirtNumber,
      position,
      gridPosition: null,
      isStarter: true,
    },
    stats: {
      playerId: id,
      teamId,
      competitionId: COMPETITION_ID,
      season: SEASON_ID,
      appearances: 10 + offset + index,
      minutesPlayed: 900,
      goals: offset + index,
      assists: (offset + index) * 2,
      yellowCards: 1,
      redCards: 0,
      shots: 10,
      shotsOnTarget: 4,
      passAccuracy: 80,
      tackles: 5,
      rating: 7,
    },
    profile: {
      player,
      career: [
        {
          teamId,
          teamName: `${teamLabel} Academy`,
          fromSeason: '2018',
          toSeason: '2020',
          appearances: 40,
          goals: 5,
        },
        {
          teamId,
          teamName: teamLabel,
          fromSeason: '2020',
          toSeason: null,
          appearances: 80,
          goals: 20,
        },
      ],
    },
  };
};

const HOME_PLAYERS = Array.from({ length: 11 }, (_, index) => buildPlayer(HOME_TEAM_ID, index, 0, 'home'));
const AWAY_PLAYERS = Array.from({ length: 11 }, (_, index) => buildPlayer(AWAY_TEAM_ID, index, 11, 'away'));

export const ALL_BUILT = [...HOME_PLAYERS, ...AWAY_PLAYERS];

export const FIXTURE: Fixture = {
  id: FIXTURE_ID,
  competitionId: COMPETITION_ID,
  season: SEASON_ID,
  kickoff: '2024-09-14T14:00:00Z',
  status: 'SCHEDULED',
  minute: null,
  homeTeam: HOME_TEAM,
  awayTeam: AWAY_TEAM,
  score: null,
  halfTimeScore: null,
  venue: null,
  round: null,
};

export const LINEUPS: FixtureLineups = {
  fixtureId: FIXTURE_ID,
  home: {
    teamId: HOME_TEAM_ID,
    formation: '4-3-3',
    coachName: null,
    startingXI: HOME_PLAYERS.map((entry) => entry.lineup),
    substitutes: [],
  },
  away: {
    teamId: AWAY_TEAM_ID,
    formation: '4-3-3',
    coachName: null,
    startingXI: AWAY_PLAYERS.map((entry) => entry.lineup),
    substitutes: [],
  },
  confirmed: true,
};

export const FULL_QUALITY: DataQuality = {
  hasLineups: true,
  hasShirtNumbers: true,
  hasLiveEvents: true,
  hasPlayerMatchStats: true,
  hasPlayerSeasonStats: true,
  hasMarketValues: true,
  hasCareerHistory: true,
  notes: [],
};

export const sampleData = (overrides: Partial<RoundDataContext> = {}): RoundDataContext => ({
  fixture: FIXTURE,
  lineups: LINEUPS,
  live: null,
  teams: [HOME_TEAM, AWAY_TEAM],
  players: ALL_BUILT.map((entry) => entry.player),
  profiles: ALL_BUILT.map((entry) => entry.profile),
  seasonStats: ALL_BUILT.map((entry) => entry.stats),
  quality: FULL_QUALITY,
  ...overrides,
});

let eventCounter = 0;

export const matchEvent = (
  type: MatchEventType,
  options: {
    readonly teamId?: TeamId | null;
    readonly playerId?: FootballPlayerId | null;
    readonly minute?: number;
    readonly id?: string;
  } = {},
): MatchEvent => {
  eventCounter += 1;
  return {
    id: options.id ?? `evt-${eventCounter}`,
    fixtureId: FIXTURE_ID,
    type,
    minute: options.minute ?? 1,
    extraMinute: null,
    teamId: options.teamId ?? null,
    playerId: options.playerId ?? null,
    playerName: null,
    relatedPlayerId: null,
    detail: null,
  };
};

export interface Harness {
  readonly deps: EngineDeps;
  readonly clock: ControllableClock;
  readonly modules: GameModuleRegistry;
}

export const makeHarness = (
  options: {
    readonly now?: number;
    readonly data?: RoundDataContext;
    readonly modules?: GameModuleRegistry;
  } = {},
): Harness => {
  const clock = createControllableClock(options.now ?? T0);
  const modules = options.modules ?? createDefaultRegistry();
  return {
    clock,
    modules,
    deps: {
      clock,
      rng: MULBERRY32,
      modules,
      data: options.data ?? sampleData(),
    },
  };
};

export const HOST: PlayerId = asPlayerId('host');
export const P2: PlayerId = asPlayerId('p2');
export const P3: PlayerId = asPlayerId('p3');

/* --------------------- direct module-under-test helpers --------------------- */

export const playerViews = (ids: readonly PlayerId[]): readonly RoundPlayerView[] =>
  ids.map((id) => ({ id, nickname: id, connected: true, score: 0, streak: 0 }));

export const generateWith = (
  module: EngineGameModule,
  options: {
    readonly config?: unknown;
    readonly data?: RoundDataContext;
    readonly players?: readonly PlayerId[];
    readonly seed?: number;
    readonly usedContentKeys?: readonly string[];
    readonly roundIndex?: number;
    readonly now?: number;
  } = {},
): GenerateRoundResult<ModuleShape> =>
  module.generateRound({
    config: options.config ?? module.defaultConfig,
    sessionId: asSessionId('s1'),
    roundIndex: options.roundIndex ?? 0,
    players: playerViews(options.players ?? [HOST, P2]),
    data: options.data ?? sampleData(),
    rng: createSeededRng(options.seed ?? 1),
    now: options.now ?? T0,
    usedContentKeys: options.usedContentKeys ?? [],
    defaultAnswerWindowMs: 20_000,
  });

/** Unwraps a generation result or fails the test with its reason. */
export const mustGenerate = (
  module: EngineGameModule,
  options: Parameters<typeof generateWith>[1] = {},
): GeneratedRound<ModuleShape> => {
  const result = generateWith(module, options);
  if (!result.ok) throw new Error(`generateRound failed: ${result.reason} ${result.detail ?? ''}`);
  return result.round;
};

export const asRoundView = (generated: GeneratedRound<ModuleShape>, now = T0): RoundView<ModuleShape> => ({
  id: asRoundId('r1'),
  index: 0,
  startedAt: now,
  answerWindowMs: generated.answerWindowMs,
  deadlineAt: generated.answerWindowMs === null ? null : now + generated.answerWindowMs,
  publicPayload: generated.publicPayload,
  privatePayloads: generated.privatePayloads,
  solution: generated.solution,
  turn: generated.turnOrder === null ? null : { order: generated.turnOrder, activeIndex: 0, eliminated: [] },
});

export const sub = (playerId: PlayerId, payload: unknown, elapsedMs = 0): TypedSubmission<ModuleShape> => ({
  playerId,
  payload,
  submittedAt: T0 + elapsedMs,
  elapsedMs,
});

/** A fresh lobby. The seed is the room's: all randomness in the session derives from it. */
export const newRoom = (now = T0, seed = 42): RoomState =>
  createRoom({
    roomId: asRoomId('room-1'),
    pin: 'ABC123',
    hostPlayerId: HOST,
    hostNickname: 'Host',
    hostIsGuest: false,
    now,
    rngState: MULBERRY32.initialState(seed),
  });
