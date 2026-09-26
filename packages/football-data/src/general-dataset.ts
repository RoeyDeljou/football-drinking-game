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
import { assessGeneralDataQuality } from './data-quality.js';
import type {
  Competition,
  CompetitionCode,
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
import { describeThrown, fail, ok } from './result.js';
import { buildGuessableStats } from './guessable-stats.js';
import type { GeneralDataset } from './general-dataset-core.js';
import { assembleGeneralDataset, groupStatsByPlayer } from './general-dataset-core.js';
import type { GeneralDatasetStore } from './general-dataset-snapshot.js';
import { hydrateGeneralDataset, isSnapshotFresh, serializeGeneralDataset } from './general-dataset-snapshot.js';

export type { GeneralDataset } from './general-dataset-core.js';

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

  const statsByPlayer = groupStatsByPlayer(seasonStats);

  // Profile the most prolific players first: they are the ones the general games are most likely to pick.
  const profileTargets = rankProfileTargets(statsByPlayer, options.profileCount ?? 120);
  const profiles: PlayerProfile[] = [];
  for (const playerId of profileTargets) {
    const result = await provider.getPlayerProfile(playerId);
    if (!result.ok) {
      notes.push(`Could not load a profile for player ${playerId}: ${result.error.message}`);
      continue;
    }
    if (result.value === null) continue;
    profiles.push(result.value);
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

  const dataset = assembleGeneralDataset({
    builtAt: new Date(clock.now()).toISOString(),
    competitions,
    teams: teamRows,
    players,
    seasonStats,
    profiles,
    leaderboards,
    guessableStats,
    quality,
  });
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
  /**
   * Serve the dataset. Order: in-memory cache, then the stored snapshot (if a `store` is configured; a stale one
   * is served immediately and refreshed once in the background), then a live build. Concurrent callers share one
   * read/build.
   */
  load(): Promise<DataResult<GeneralDataset>>;
  /** The cached dataset without triggering a build. */
  peek(): GeneralDataset | null;
  /** Drop the in-memory cache so the next `load()` re-reads the store / rebuilds — e.g. on a new matchweek. */
  invalidate(): void;
}

/** The loader `createGeneralDatasetLoader` returns: the base contract plus a forced refresh (kept separate so existing fakes of `GeneralDatasetLoader` still type-check). */
export interface RefreshableGeneralDatasetLoader extends GeneralDatasetLoader {
  /**
   * Force a live build and, if it is not worse than what we already hold, write it to the store and swap the
   * in-memory cache. This is what a scheduled sync job calls. Never throws; a failed, partial or worse build
   * returns a failure and leaves the store and the served dataset untouched.
   */
  refresh(): Promise<DataResult<GeneralDataset>>;
}

export interface GeneralDatasetLoaderOptions extends GeneralDatasetOptions {
  /** Where the built snapshot is persisted. Omit for the original process-lifetime in-memory behaviour. */
  readonly store?: GeneralDatasetStore | undefined;
  /** A stored snapshot older than this triggers a background refresh. Default 12 hours. */
  readonly maxAgeMs?: number | undefined;
  /** Store/refresh problems that are swallowed (never thrown) are reported here. */
  readonly onWarning?: ((message: string) => void) | undefined;
}

export const DEFAULT_SNAPSHOT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
/** A refresh with fewer than this fraction of the held players is treated as a degraded build and rejected. */
export const MIN_REFRESH_PLAYER_RATIO = 0.8;

function configuredCompetitionCount(options: GeneralDatasetOptions): number {
  const codes = options.competitions ?? COMPETITION_CONFIGS.map((entry) => entry.code);
  return COMPETITION_CONFIGS.filter((entry) => codes.includes(entry.code)).length;
}

function competitionsWithStats(dataset: GeneralDataset): number {
  return new Set(dataset.seasonStats.map((row) => row.competitionId)).size;
}

/** True when fewer than half of the configured competitions yielded any season stats. */
function isPartialBuild(dataset: GeneralDataset, options: GeneralDatasetOptions): boolean {
  const configured = configuredCompetitionCount(options);
  return configured > 0 && competitionsWithStats(dataset) * 2 < configured;
}

function flagPartial(dataset: GeneralDataset, options: GeneralDatasetOptions): GeneralDataset {
  const note = `Partial build: only ${competitionsWithStats(dataset)} of ${configuredCompetitionCount(options)} competitions produced season stats.`;
  return { ...dataset, quality: { ...dataset.quality, notes: [...dataset.quality.notes, note] } };
}

/**
 * The app-start cache: one dataset per process, coalesced.
 *
 * Without a `store` this is the original lazy build-once cache. With one, `load()` prefers the persisted snapshot
 * (instant) and refreshes in the background when it is older than `maxAgeMs`. A refresh only replaces what is
 * stored and served when it succeeded, has players, is not a partial build and has at least
 * `MIN_REFRESH_PLAYER_RATIO` of the held player count. A build where fewer than half of the configured
 * competitions produced stats is always flagged in `quality.notes`; with a store and nothing to serve instead, it
 * is a retryable failure rather than being cached for the process life.
 */
export function createGeneralDatasetLoader(
  provider: FootballDataProvider,
  options: GeneralDatasetLoaderOptions = {},
): RefreshableGeneralDatasetLoader {
  const store = options.store;
  const clock = options.clock ?? systemDataClock;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_SNAPSHOT_MAX_AGE_MS;
  const warn = (message: string): void => {
    try {
      options.onWarning?.(message);
    } catch {
      // a broken warning sink must not break loading
    }
  };

  let cached: GeneralDataset | null = null;
  let loading: Promise<DataResult<GeneralDataset>> | null = null;
  let refreshing: Promise<DataResult<GeneralDataset>> | null = null;

  const readStored = async (): Promise<GeneralDataset | null> => {
    if (store === undefined) return null;
    try {
      const stored = await store.read();
      if (stored === null) return null;
      const hydrated = hydrateGeneralDataset(stored.snapshot);
      if (!hydrated.ok) {
        warn(`Stored general dataset snapshot is unusable: ${hydrated.error.message}`);
        return null;
      }
      return hydrated.value;
    } catch (thrown) {
      warn(`Could not read the general dataset store: ${describeThrown(thrown)}`);
      return null;
    }
  };

  const writeStored = async (dataset: GeneralDataset): Promise<void> => {
    if (store === undefined) return;
    try {
      await store.write(serializeGeneralDataset(dataset), {
        builtAt: dataset.builtAt,
        playerCount: dataset.players.length,
      });
    } catch (thrown) {
      warn(`Could not write the general dataset store: ${describeThrown(thrown)}`);
    }
  };

  const build = async (): Promise<DataResult<GeneralDataset>> => {
    try {
      const result = await buildGeneralDataset(provider, options);
      if (!result.ok) return result;
      return isPartialBuild(result.value, options) ? ok(flagPartial(result.value, options), result.notes) : result;
    } catch (thrown) {
      return fail('UPSTREAM', `general dataset build threw: ${describeThrown(thrown)}`, { retryable: true });
    }
  };

  const runRefresh = async (): Promise<DataResult<GeneralDataset>> => {
    const built = await build();
    if (!built.ok) {
      warn(`General dataset refresh failed: ${built.error.message}`);
      return built;
    }
    const next = built.value;
    const baseline = cached ?? (await readStored());
    let rejection: string | null = null;
    if (next.players.length === 0) rejection = 'it has no players';
    else if (baseline !== null) {
      if (isPartialBuild(next, options)) rejection = 'it is a partial build';
      else if (next.players.length < baseline.players.length * MIN_REFRESH_PLAYER_RATIO) {
        rejection = `it has ${next.players.length} players against ${baseline.players.length} currently held`;
      }
    }
    if (rejection !== null) {
      const message = `General dataset refresh rejected: ${rejection}`;
      warn(message);
      return fail('INVALID_RESPONSE', message, { retryable: true });
    }
    // A store-write failure does not stop the fresher data being served; it is reported and the next sync retries.
    await writeStored(next);
    cached = next;
    return built;
  };

  const refresh = (): Promise<DataResult<GeneralDataset>> => {
    if (refreshing !== null) return refreshing;
    const running = runRefresh().finally(() => {
      refreshing = null;
    });
    refreshing = running;
    return running;
  };

  const loadOnce = async (): Promise<DataResult<GeneralDataset>> => {
    const stored = await readStored();
    if (stored !== null) {
      cached = stored;
      if (!isSnapshotFresh(stored.builtAt, maxAgeMs, clock)) {
        void refresh().catch((thrown: unknown) => warn(`Background refresh crashed: ${describeThrown(thrown)}`));
      }
      return ok(stored, stored.quality.notes, true);
    }
    const built = await build();
    if (!built.ok) return built;
    if (store !== undefined && isPartialBuild(built.value, options)) {
      return fail('INVALID_RESPONSE', 'general dataset build was partial and no stored snapshot is available', {
        retryable: true,
      });
    }
    cached = built.value;
    await writeStored(built.value);
    return built;
  };

  return {
    load: async (): Promise<DataResult<GeneralDataset>> => {
      if (cached !== null) return ok(cached, cached.quality.notes, true);
      if (loading !== null) return loading;
      const running = loadOnce().finally(() => {
        loading = null;
      });
      loading = running;
      return running;
    },
    peek: (): GeneralDataset | null => cached,
    invalidate: (): void => {
      cached = null;
    },
    refresh,
  };
}

