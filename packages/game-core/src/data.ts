/**
 * The engine's read-only view of football data, plus the playability check.
 *
 * The engine never fetches anything. The server assembles a `RoundDataContext` from
 * `@fdg/football-data` (matchday prefetch or the general dataset) and hands it in with the
 * dispatch. All imports here are type-only, which keeps the package pure.
 */

import type {
  DataQuality,
  Fixture,
  FixtureLineups,
  LiveMatchState,
  Player,
  PlayerProfile,
  PlayerSeasonStats,
  Team,
} from '@fdg/football-data';

/** Everything a round generator is allowed to look at. Any field may legitimately be empty. */
export interface RoundDataContext {
  readonly fixture: Fixture | null;
  readonly lineups: FixtureLineups | null;
  readonly live: LiveMatchState | null;
  readonly teams: readonly Team[];
  readonly players: readonly Player[];
  readonly profiles: readonly PlayerProfile[];
  readonly seasonStats: readonly PlayerSeasonStats[];
  readonly quality: DataQuality | null;
}

/** An empty context — useful for tests and for games that need no data (G10, G11). */
export const EMPTY_DATA_CONTEXT: RoundDataContext = {
  fixture: null,
  lineups: null,
  live: null,
  teams: [],
  players: [],
  profiles: [],
  seasonStats: [],
  quality: null,
};

/** The boolean capability flags of `DataQuality`, minus the human-readable notes. */
export type DataRequirementKey = keyof Omit<DataQuality, 'notes'>;

export const DATA_REQUIREMENT_KEYS = [
  'hasLineups',
  'hasShirtNumbers',
  'hasLiveEvents',
  'hasPlayerMatchStats',
  'hasPlayerSeasonStats',
  'hasMarketValues',
  'hasCareerHistory',
] as const satisfies readonly DataRequirementKey[];

export type PlayabilityCode = 'OK' | 'MISSING_DATA' | 'UNKNOWN_DATA_QUALITY';

export interface PlayabilityResult {
  readonly playable: boolean;
  readonly code: PlayabilityCode;
  readonly missing: readonly DataRequirementKey[];
  /** The provider's own notes, passed straight through for the host's "why is this greyed out?" panel. */
  readonly notes: readonly string[];
}

export interface PlayabilityInput {
  readonly dataRequirements: readonly DataRequirementKey[];
}

/**
 * Pure: given a module's declared requirements and a `DataQuality` report, can it be played?
 *
 * A module with no requirements is always playable, even with no report at all. A module with
 * requirements and no report is *not* playable — we would rather grey a game out than serve a
 * broken round.
 */
export const checkModulePlayable = (
  module: PlayabilityInput,
  quality: DataQuality | null,
): PlayabilityResult => {
  if (module.dataRequirements.length === 0) {
    return { playable: true, code: 'OK', missing: [], notes: quality?.notes ?? [] };
  }
  if (quality === null) {
    return {
      playable: false,
      code: 'UNKNOWN_DATA_QUALITY',
      missing: module.dataRequirements.slice(),
      notes: [],
    };
  }
  const missing = module.dataRequirements.filter((key) => quality[key] !== true);
  return {
    playable: missing.length === 0,
    code: missing.length === 0 ? 'OK' : 'MISSING_DATA',
    missing,
    notes: quality.notes,
  };
};
