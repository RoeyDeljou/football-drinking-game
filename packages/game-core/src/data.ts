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
  /**
   * Optional disjunction on top of `dataRequirements`: when present and non-empty, at least one of
   * these sets must *also* be fully met. For modules whose needs depend on which content they end up
   * serving — the Mixed rotations are playable when *some* sub-game is. Absent or `[]` adds nothing;
   * an empty set among the alternatives is always met.
   */
  readonly dataRequirementsAnyOf?: readonly (readonly DataRequirementKey[])[] | undefined;
}

const unique = (keys: readonly DataRequirementKey[]): readonly DataRequirementKey[] => [...new Set(keys)];

/**
 * Pure: given a module's declared requirements and a `DataQuality` report, can it be played?
 *
 * A module with no requirements is always playable, even with no report at all. A module with
 * requirements and no report is *not* playable — we would rather grey a game out than serve a
 * broken round. With `dataRequirementsAnyOf`, `missing` lists the closest alternative's gaps (the
 * one missing the fewest flags; the first on a tie).
 */
export const checkModulePlayable = (
  module: PlayabilityInput,
  quality: DataQuality | null,
): PlayabilityResult => {
  const anyOf = module.dataRequirementsAnyOf ?? [];
  const anyOfTrivial = anyOf.length === 0 || anyOf.some((set) => set.length === 0);
  if (module.dataRequirements.length === 0 && anyOfTrivial) {
    return { playable: true, code: 'OK', missing: [], notes: quality?.notes ?? [] };
  }
  if (quality === null) {
    return {
      playable: false,
      code: 'UNKNOWN_DATA_QUALITY',
      missing: unique([...module.dataRequirements, ...(anyOfTrivial ? [] : (anyOf[0] ?? []))]),
      notes: [],
    };
  }
  const missingOf = (keys: readonly DataRequirementKey[]): readonly DataRequirementKey[] =>
    keys.filter((key) => quality[key] !== true);
  let closest: readonly DataRequirementKey[] = [];
  if (anyOf.length > 0) {
    closest = anyOf.map(missingOf).reduce((best, next) => (next.length < best.length ? next : best));
  }
  const missing = unique([...missingOf(module.dataRequirements), ...closest]);
  return {
    playable: missing.length === 0,
    code: missing.length === 0 ? 'OK' : 'MISSING_DATA',
    missing,
    notes: quality.notes,
  };
};
