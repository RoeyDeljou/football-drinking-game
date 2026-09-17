/**
 * `DataQuality` assessment and the game-availability map.
 *
 * Missing upstream data is a normal case. Instead of throwing, the data layer reports exactly which capabilities
 * it could fill, and `evaluateGameAvailability` turns that into "these game ids are playable, these are disabled
 * and here is why". The engine reads that instead of discovering a hole mid-round.
 *
 * Game requirements are a config map keyed by catalog id, so adding a game means adding one row.
 */

import type {
  DataQuality,
  FixtureLineups,
  LiveMatchState,
  Player,
  PlayerProfile,
  PlayerSeasonStats,
} from './domain.js';

/** The boolean capability flags of `DataQuality`. */
export type DataCapability =
  | 'hasLineups'
  | 'hasShirtNumbers'
  | 'hasLiveEvents'
  | 'hasPlayerMatchStats'
  | 'hasPlayerSeasonStats'
  | 'hasMarketValues'
  | 'hasCareerHistory';

export const DATA_CAPABILITIES: readonly DataCapability[] = [
  'hasLineups',
  'hasShirtNumbers',
  'hasLiveEvents',
  'hasPlayerMatchStats',
  'hasPlayerSeasonStats',
  'hasMarketValues',
  'hasCareerHistory',
];

export const EMPTY_DATA_QUALITY: DataQuality = {
  hasLineups: false,
  hasShirtNumbers: false,
  hasLiveEvents: false,
  hasPlayerMatchStats: false,
  hasPlayerSeasonStats: false,
  hasMarketValues: false,
  hasCareerHistory: false,
  notes: [],
};

/**
 * What each catalog game needs from the data layer. Ids match `docs/GAME_CATALOG.md`.
 * `G10` (Most Likely To) and `G11` (Spin the Ball) need no data and are therefore always available.
 */
export const GAME_DATA_REQUIREMENTS: Readonly<Record<string, readonly DataCapability[]>> = {
  M1: ['hasLineups', 'hasLiveEvents'],
  M2: ['hasLineups', 'hasPlayerSeasonStats'],
  M3: ['hasLineups', 'hasShirtNumbers'],
  M4: ['hasLineups', 'hasLiveEvents'],
  M5: ['hasLiveEvents'],
  M6: ['hasLiveEvents'],
  M7: ['hasLiveEvents'],
  M8: ['hasLineups', 'hasPlayerMatchStats'],
  M9: ['hasLiveEvents'],
  M10: ['hasLineups'],
  G1: ['hasPlayerSeasonStats', 'hasCareerHistory'],
  G2: ['hasPlayerSeasonStats'],
  G3: ['hasCareerHistory'],
  G4: ['hasPlayerSeasonStats'],
  G5: ['hasPlayerSeasonStats'],
  G6: ['hasPlayerSeasonStats'],
  // G7 "Guess the Number" shows a player and one of their season numbers (goals, appearances, assists, minutes,
  // age, height, shirt number) and asks for a closest-guess; it needs season stats, not market values.
  G7: ['hasPlayerSeasonStats'],
  G8: ['hasCareerHistory'],
  G9: ['hasPlayerSeasonStats'],
  G10: [],
  G11: [],
};

export interface GameAvailability {
  readonly gameId: string;
  readonly available: boolean;
  /** Capabilities the game needs that the data layer could not provide. */
  readonly missing: readonly DataCapability[];
}

/** Decide, per game, whether the available data can support it. */
export function evaluateGameAvailability(
  quality: DataQuality,
  requirements: Readonly<Record<string, readonly DataCapability[]>> = GAME_DATA_REQUIREMENTS,
): readonly GameAvailability[] {
  return Object.keys(requirements)
    .sort()
    .map((gameId) => {
      const needed = requirements[gameId] ?? [];
      const missing = needed.filter((capability) => !quality[capability]);
      return { gameId, available: missing.length === 0, missing };
    });
}

/** Just the playable ids, for the host's game picker. */
export function availableGameIds(
  quality: DataQuality,
  requirements?: Readonly<Record<string, readonly DataCapability[]>>,
): readonly string[] {
  return evaluateGameAvailability(quality, requirements)
    .filter((entry) => entry.available)
    .map((entry) => entry.gameId);
}

/** Combine several quality reports; a capability is present only if it is present in every one of them. */
export function mergeDataQuality(reports: readonly DataQuality[]): DataQuality {
  if (reports.length === 0) return EMPTY_DATA_QUALITY;
  const notes: string[] = [];
  const flags: Record<DataCapability, boolean> = {
    hasLineups: true,
    hasShirtNumbers: true,
    hasLiveEvents: true,
    hasPlayerMatchStats: true,
    hasPlayerSeasonStats: true,
    hasMarketValues: true,
    hasCareerHistory: true,
  };
  for (const report of reports) {
    for (const capability of DATA_CAPABILITIES) {
      if (!report[capability]) flags[capability] = false;
    }
    notes.push(...report.notes);
  }
  return { ...flags, notes: dedupe(notes) };
}

export interface FixtureQualityInput {
  readonly lineups: FixtureLineups | null;
  readonly live: LiveMatchState | null;
  readonly squadPlayers: readonly Player[];
  readonly seasonStats: readonly PlayerSeasonStats[];
  readonly profiles?: readonly PlayerProfile[] | undefined;
  /** Notes accumulated while fetching, e.g. "lineups step failed". */
  readonly notes?: readonly string[] | undefined;
}

/** Assess what a matchday bundle can actually support. */
export function assessFixtureDataQuality(input: FixtureQualityInput): DataQuality {
  const notes: string[] = [...(input.notes ?? [])];

  const lineupPlayers =
    input.lineups === null
      ? []
      : [
          ...input.lineups.home.startingXI,
          ...input.lineups.home.substitutes,
          ...input.lineups.away.startingXI,
          ...input.lineups.away.substitutes,
        ];

  const hasLineups =
    input.lineups !== null &&
    input.lineups.home.startingXI.length >= 11 &&
    input.lineups.away.startingXI.length >= 11;
  if (input.lineups === null) {
    notes.push('No lineups available for this fixture yet.');
  } else {
    if (!input.lineups.confirmed) notes.push('Lineups are projected, not confirmed.');
    if (!hasLineups) notes.push('Lineups are incomplete (fewer than 11 starters on one side).');
  }

  const numbered = lineupPlayers.filter((player) => player.shirtNumber !== null).length;
  const hasShirtNumbers = lineupPlayers.length > 0 && numbered === lineupPlayers.length;
  if (lineupPlayers.length > 0 && !hasShirtNumbers) {
    notes.push(`Shirt numbers missing for ${String(lineupPlayers.length - numbered)} lineup players.`);
  }

  const hasLiveEvents = input.live !== null && input.live.events.length > 0;
  if (input.live === null) {
    notes.push('No live match state available for this fixture.');
  } else if (!hasLiveEvents) {
    notes.push('Live event feed is empty (the match may not have kicked off).');
  }

  const hasPlayerMatchStats = input.live !== null && input.live.playerStats.length > 0;
  if (input.live !== null && !hasPlayerMatchStats) {
    notes.push('No per-player match statistics in the live feed.');
  }

  const hasPlayerSeasonStats = input.seasonStats.length > 0;
  if (!hasPlayerSeasonStats) notes.push('No player season statistics available.');

  const pool = input.squadPlayers.length > 0 ? input.squadPlayers : [];
  const valued = pool.filter((player) => player.marketValueEur !== null).length;
  const hasMarketValues = pool.length > 0 && valued > 0;
  if (pool.length > 0 && !hasMarketValues) notes.push('No market values available for this squad.');

  const profiles = input.profiles ?? [];
  const hasCareerHistory = profiles.some((profile) => profile.career.length > 0);
  if (profiles.length > 0 && !hasCareerHistory) notes.push('No career history available for these players.');

  return {
    hasLineups,
    hasShirtNumbers,
    hasLiveEvents,
    hasPlayerMatchStats,
    hasPlayerSeasonStats,
    hasMarketValues,
    hasCareerHistory,
    notes: dedupe(notes),
  };
}

export interface GeneralQualityInput {
  readonly players: readonly Player[];
  readonly seasonStats: readonly PlayerSeasonStats[];
  readonly profiles: readonly PlayerProfile[];
  readonly notes?: readonly string[] | undefined;
  /** Minimum players with career history before `G3`/`G8` are considered playable. */
  readonly minCareerPlayers?: number | undefined;
}

/** Assess the season-wide dataset the general games draw from. Matchday-only capabilities stay false. */
export function assessGeneralDataQuality(input: GeneralQualityInput): DataQuality {
  const notes: string[] = [...(input.notes ?? [])];
  const minCareer = input.minCareerPlayers ?? 10;

  const hasPlayerSeasonStats = input.seasonStats.length > 0;
  if (!hasPlayerSeasonStats) notes.push('General dataset has no season statistics.');

  const valued = input.players.filter((player) => player.marketValueEur !== null).length;
  const hasMarketValues = valued > 0;
  if (!hasMarketValues) notes.push('General dataset has no market values (no free source publishes them).');

  const withCareer = input.profiles.filter((profile) => profile.career.length > 0).length;
  const hasCareerHistory = withCareer >= minCareer;
  if (!hasCareerHistory) {
    notes.push(
      `Only ${String(withCareer)} players have career history (need ${String(minCareer)}); G3/G8 unavailable.`,
    );
  }

  const numbered = input.players.filter((player) => player.shirtNumber !== null).length;

  return {
    hasLineups: false,
    hasShirtNumbers: input.players.length > 0 && numbered > 0,
    hasLiveEvents: false,
    hasPlayerMatchStats: false,
    hasPlayerSeasonStats,
    hasMarketValues,
    hasCareerHistory,
    notes: dedupe(notes),
  };
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
