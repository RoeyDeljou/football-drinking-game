/**
 * The `GeneralDataset` shape plus the one place its derived fields are computed, shared by the live builder and
 * by snapshot hydration so the two can never drift.
 */

import { evaluateGameAvailability } from './data-quality.js';
import type { GameAvailability } from './data-quality.js';
import type {
  Competition,
  DataQuality,
  Player,
  PlayerProfile,
  PlayerSeasonStats,
  SeasonLeaderboard,
  Team,
} from './domain.js';
import type { GuessableStatFact } from './guessable-stats.js';
import { groupGuessableStatsByPlayer } from './guessable-stats.js';

export interface GeneralDataset {
  /** ISO timestamp the dataset was built at. */
  readonly builtAt: string;
  readonly competitions: readonly Competition[];
  readonly teams: readonly Team[];
  readonly players: readonly Player[];
  readonly seasonStats: readonly PlayerSeasonStats[];
  /** Players with career history, which is what `G1` Guess the Player and `G3` Career Path consume. */
  readonly profiles: readonly PlayerProfile[];
  readonly leaderboards: readonly SeasonLeaderboard[];
  /**
   * One player, one number, ready for a "closest guess wins" round — `G7` Guess the Number's raw material.
   * Bio facts (age, height, shirt number) plus one set of season facts (goals, assists, appearances, minutes,
   * yellow cards) per `PlayerSeasonStats` row, each carrying its own `value`, `unit` and source `season`.
   */
  readonly guessableStats: readonly GuessableStatFact[];
  readonly quality: DataQuality;
  readonly gameAvailability: readonly GameAvailability[];
  /** Fast lookups for the question generators. */
  readonly playersById: ReadonlyMap<string, Player>;
  readonly statsByPlayer: ReadonlyMap<string, readonly PlayerSeasonStats[]>;
  readonly profilesByPlayer: ReadonlyMap<string, PlayerProfile>;
  readonly guessableStatsByPlayer: ReadonlyMap<string, readonly GuessableStatFact[]>;
}

/** The persisted (non-derived) part of a dataset. */
export type GeneralDatasetSource = Omit<
  GeneralDataset,
  'gameAvailability' | 'playersById' | 'statsByPlayer' | 'profilesByPlayer' | 'guessableStatsByPlayer'
>;

export function groupStatsByPlayer(seasonStats: readonly PlayerSeasonStats[]): Map<string, PlayerSeasonStats[]> {
  const byPlayer = new Map<string, PlayerSeasonStats[]>();
  for (const row of seasonStats) {
    const bucket = byPlayer.get(row.playerId);
    if (bucket === undefined) byPlayer.set(row.playerId, [row]);
    else bucket.push(row);
  }
  return byPlayer;
}

/** Recompute every derived field from the persisted ones. */
export function assembleGeneralDataset(source: GeneralDatasetSource): GeneralDataset {
  const playersById = new Map<string, Player>(source.players.map((player) => [player.id, player]));
  const profilesByPlayer = new Map<string, PlayerProfile>(
    source.profiles.map((profile) => [profile.player.id, profile]),
  );
  return {
    ...source,
    gameAvailability: evaluateGameAvailability(source.quality),
    playersById,
    statsByPlayer: groupStatsByPlayer(source.seasonStats),
    profilesByPlayer,
    guessableStatsByPlayer: groupGuessableStatsByPlayer(source.guessableStats),
  };
}
