/**
 * `GeneralDataset` — the season data the general games draw from.
 *
 * Built once at app start and cached for the process lifetime: the general games (`G1`–`G9`) need a pool of
 * players, their season stats, their career history and a set of leaderboards, and none of that changes during a
 * session. `createGeneralDatasetLoader` coalesces concurrent `load()` calls, so twenty rooms starting at once
 * still build it exactly once.
 *
 * A competition that fails to load is noted and skipped rather than failing the build: five leagues' worth of
 * players is still a playable general dataset.
 */

import { COMPETITION_CONFIGS } from './competitions.js';
import type { DataClock } from './clock.js';
import { systemDataClock } from './clock.js';
import { assessGeneralDataQuality, evaluateGameAvailability } from './data-quality.js';
import type { GameAvailability } from './data-quality.js';
import type {
  Competition,
  CompetitionCode,
  DataQuality,
  FootballPlayerId,
  Player,
  PlayerProfile,
  PlayerSeasonStats,
  SeasonLeaderboard,
  SeasonLeaderboardMetric,
  Team,
} from './domain.js';
import { asFootballPlayerId } from './domain.js';
import type { FootballDataProvider } from './provider.js';
import type { DataResult } from './result.js';
import { fail, ok } from './result.js';
import type { GuessableStatFact } from './guessable-stats.js';
import { buildGuessableStats, groupGuessableStatsByPlayer } from './guessable-stats.js';

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

export interface GeneralDatasetOptions {
  /** Restrict the build to a subset of competitions. Defaults to all six. */
  readonly competitions?: readonly CompetitionCode[] | undefined;
  /** Season-stat rows to request per competition. Default 200. */
  readonly statsPerCompetition?: number | undefined;
  /** How many players to resolve full profiles for. Default 120. */
  readonly profileCount?: number | undefined;
  /** Metrics to build leaderboards for. Defaults to goals, assists and appearances. */
  readonly leaderboardMetrics?: readonly SeasonLeaderboardMetric[] | undefined;
  /** Entries per leaderboard. Default 10, which is exactly what `G4 Name the Top 10` needs. */
  readonly leaderboardSize?: number | undefined;
  readonly clock?: DataClock | undefined;
  readonly onProgress?: ((done: number, total: number, label: string) => void) | undefined;
}

export const DEFAULT_LEADERBOARD_METRICS: readonly SeasonLeaderboardMetric[] = ['GOALS', 'ASSISTS', 'APPEARANCES'];

/** Build the dataset from a provider. Never throws; partial competition coverage is reported in `quality.notes`. */
export async function buildGeneralDataset(
  provider: FootballDataProvider,
  options: GeneralDatasetOptions = {},
): Promise<DataResult<GeneralDataset>> {
  const clock = options.clock ?? systemDataClock;
  const codes = options.competitions ?? COMPETITION_CONFIGS.map((entry) => entry.code);
  const configs = COMPETITION_CONFIGS.filter((entry) => codes.includes(entry.code));
  const statsLimit = options.statsPerCompetition ?? 200;

  const notes: string[] = [];
  const competitions: Competition[] = [];
  const teamsById = new Map<string, Team>();
  const playersById = new Map<string, Player>();
  const seasonStats: PlayerSeasonStats[] = [];

  const competitionsResult = await provider.listCompetitions();
  if (!competitionsResult.ok) return competitionsResult;
  notes.push(...competitionsResult.notes);
  const known = new Map(competitionsResult.value.map((entry) => [entry.id, entry]));

  const totalSteps = configs.length * 2 + 2;
  let step = 0;
  const tick = (label: string): void => {
    step += 1;
    options.onProgress?.(step, totalSteps, label);
  };

  for (const config of configs) {
    const competition = known.get(config.id);
    if (competition === undefined) {
      notes.push(`Provider does not serve ${config.name}; skipped.`);
      tick(config.name);
      tick(config.name);
      continue;
    }
    competitions.push(competition);

    // Fixtures give us the teams (and their crests) without a separate endpoint.
    const fixturesResult = await provider.getFixturesByCompetition(config.id, { season: config.currentSeason });
    if (fixturesResult.ok) {
      for (const fixture of fixturesResult.value) {
        teamsById.set(fixture.homeTeam.id, fixture.homeTeam);
        teamsById.set(fixture.awayTeam.id, fixture.awayTeam);
      }
      notes.push(...fixturesResult.notes);
    } else {
      notes.push(`Could not list ${config.name} fixtures: ${fixturesResult.error.message}`);
    }
    tick(`${config.name} teams`);

    const statsResult = await provider.getPlayerSeasonStats({
      competitionId: config.id,
      season: config.currentSeason,
      limit: statsLimit,
    });
    if (statsResult.ok) {
      seasonStats.push(...statsResult.value);
      notes.push(...statsResult.notes);
    } else {
      notes.push(`Could not load ${config.name} season statistics: ${statsResult.error.message}`);
    }
    tick(`${config.name} statistics`);
  }

  // Squads fill in the bios (nationality, age, shirt number) the stats rows do not carry.
  for (const team of teamsById.values()) {
    const squadResult = await provider.getSquad(team.id);
    if (!squadResult.ok) {
      notes.push(`Could not load the squad for ${team.name}: ${squadResult.error.message}`);
      continue;
    }
    for (const player of squadResult.value) {
      if (!playersById.has(player.id)) playersById.set(player.id, player);
    }
  }
  tick('Squads');

  if (playersById.size === 0 && seasonStats.length === 0) {
    return fail('INVALID_RESPONSE', 'general dataset came back empty for every competition', { retryable: true });
  }

  const statsByPlayer = new Map<string, PlayerSeasonStats[]>();
  for (const row of seasonStats) {
    const bucket = statsByPlayer.get(row.playerId);
    if (bucket === undefined) statsByPlayer.set(row.playerId, [row]);
    else bucket.push(row);
  }

  // Profile the most prolific players first: they are the ones the general games are most likely to pick.
  const profileTargets = rankProfileTargets(statsByPlayer, options.profileCount ?? 120);
  const profiles: PlayerProfile[] = [];
  const profilesByPlayer = new Map<string, PlayerProfile>();
  for (const playerId of profileTargets) {
    const result = await provider.getPlayerProfile(playerId);
    if (!result.ok) {
      notes.push(`Could not load a profile for player ${playerId}: ${result.error.message}`);
      continue;
    }
    if (result.value === null) continue;
    profiles.push(result.value);
    profilesByPlayer.set(result.value.player.id, result.value);
    if (!playersById.has(result.value.player.id)) playersById.set(result.value.player.id, result.value.player);
  }
  tick('Player profiles');

  const players = [...playersById.values()];
  const leaderboards = buildLeaderboards(
    seasonStats,
    playersById,
    teamsById,
    options.leaderboardMetrics ?? DEFAULT_LEADERBOARD_METRICS,
    options.leaderboardSize ?? 10,
  );

  const quality = assessGeneralDataQuality({ players, seasonStats, profiles, notes });
  const teamRows = [...teamsById.values()];
  const guessableStats = buildGuessableStats(players, seasonStats, teamRows);

  const dataset: GeneralDataset = {
    builtAt: new Date(clock.now()).toISOString(),
    competitions,
    teams: teamRows,
    players,
    seasonStats,
    profiles,
    leaderboards,
    guessableStats,
    quality,
    gameAvailability: evaluateGameAvailability(quality),
    playersById,
    statsByPlayer,
    profilesByPlayer,
    guessableStatsByPlayer: groupGuessableStatsByPlayer(guessableStats),
  };
  return ok(dataset, quality.notes);
}

/** Players with the most minutes first — the pool the general games sample from. */
function rankProfileTargets(
  statsByPlayer: ReadonlyMap<string, readonly PlayerSeasonStats[]>,
  count: number,
): readonly FootballPlayerId[] {
  const scored = [...statsByPlayer.entries()].map(([playerId, rows]) => ({
    playerId,
    minutes: rows.reduce((total, row) => total + row.minutesPlayed, 0),
    goals: rows.reduce((total, row) => total + row.goals, 0),
  }));
  scored.sort((left, right) => right.minutes - left.minutes || right.goals - left.goals);
  return scored.slice(0, Math.max(0, count)).map((entry) => asFootballPlayerId(entry.playerId));
}

function metricValue(row: PlayerSeasonStats, metric: SeasonLeaderboardMetric): number | null {
  switch (metric) {
    case 'GOALS':
      return row.goals;
    case 'ASSISTS':
      return row.assists;
    case 'APPEARANCES':
      return row.appearances;
    case 'MINUTES_PLAYED':
      return row.minutesPlayed;
    case 'YELLOW_CARDS':
      return row.yellowCards;
    case 'RATING':
      return row.rating;
    default:
      return null;
  }
}

/** One leaderboard per competition × season × metric, ranked descending with ties sharing a rank. */
export function buildLeaderboards(
  seasonStats: readonly PlayerSeasonStats[],
  playersById: ReadonlyMap<string, Player>,
  teamsById: ReadonlyMap<string, Team>,
  metrics: readonly SeasonLeaderboardMetric[],
  size: number,
): readonly SeasonLeaderboard[] {
  const groups = new Map<string, PlayerSeasonStats[]>();
  for (const row of seasonStats) {
    const key = `${row.competitionId}|${row.season}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [row]);
    else bucket.push(row);
  }

  const boards: SeasonLeaderboard[] = [];
  for (const rows of groups.values()) {
    const first = rows[0];
    if (first === undefined) continue;
    for (const metric of metrics) {
      const ranked = rows
        .map((row) => ({ row, value: metricValue(row, metric) }))
        .filter((entry): entry is { row: PlayerSeasonStats; value: number } => entry.value !== null)
        .sort((left, right) => right.value - left.value || left.row.playerId.localeCompare(right.row.playerId))
        .slice(0, Math.max(0, size));

      let rank = 0;
      let previousValue: number | null = null;
      const entries = ranked.map((entry, index) => {
        if (previousValue === null || entry.value !== previousValue) rank = index + 1;
        previousValue = entry.value;
        const player = playersById.get(entry.row.playerId);
        const team = teamsById.get(entry.row.teamId);
        return {
          rank,
          playerId: entry.row.playerId,
          playerName: player?.name ?? `Player ${entry.row.playerId}`,
          teamId: entry.row.teamId,
          teamName: team?.name ?? `Team ${entry.row.teamId}`,
          value: entry.value,
        };
      });
      if (entries.length === 0) continue;
      boards.push({ competitionId: first.competitionId, season: first.season, metric, entries });
    }
  }
  return boards;
}

export interface GeneralDatasetLoader {
  /** Build on first call, then serve the cached dataset. Concurrent callers share one build. */
  load(): Promise<DataResult<GeneralDataset>>;
  /** The cached dataset without triggering a build. */
  peek(): GeneralDataset | null;
  /** Drop the cache so the next `load()` rebuilds — e.g. on a new matchweek. */
  invalidate(): void;
}

/** The app-start cache: one dataset per process, built lazily and coalesced. */
export function createGeneralDatasetLoader(
  provider: FootballDataProvider,
  options: GeneralDatasetOptions = {},
): GeneralDatasetLoader {
  let cached: GeneralDataset | null = null;
  let building: Promise<DataResult<GeneralDataset>> | null = null;

  return {
    load: async (): Promise<DataResult<GeneralDataset>> => {
      if (cached !== null) return ok(cached, cached.quality.notes, true);
      if (building !== null) return building;
      building = (async (): Promise<DataResult<GeneralDataset>> => {
        const result = await buildGeneralDataset(provider, options);
        if (result.ok) cached = result.value;
        return result;
      })();
      try {
        return await building;
      } finally {
        building = null;
      }
    },
    peek: (): GeneralDataset | null => cached,
    invalidate: (): void => {
      cached = null;
    },
  };
}
