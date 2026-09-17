/**
 * `@fdg/football-data` — normalized football domain types plus the provider layer that fills them.
 *
 * Consumers should need exactly three things from here:
 *
 *   1. `createFootballDataProvider(config)` — build the provider. `live` (default) wires up `EspnProvider` +
 *      `WikidataCareerProvider` behind a `CompositeProvider`, with `ApiFootballProvider` as an optional fallback
 *      when a free key is configured. `fixture` serves the recorded offline snapshot in `data/`.
 *   2. The `FootballDataProvider` interface and the normalized domain types.
 *   3. `MatchdayPrefetcher` for the loading screen and `createGeneralDatasetLoader` for the general games.
 *
 * Everything else exported here (cache, rate limiter, clock, replay, normalizers, per-source adapters) is
 * available for tests and for a hub that wants to reuse the plumbing, but no game code needs it directly.
 *
 * See `README.md` for the required environment variables, the data sources behind each capability, and how to
 * switch providers.
 */

export const FOOTBALL_DATA_VERSION = '0.2.0';

// ---- Domain contract -------------------------------------------------------
export * from './domain.js';

// ---- Provider seam ---------------------------------------------------------
export type {
  FixtureQuery,
  FixturesByDateQuery,
  FootballDataProvider,
  PollIntervalConfig,
  ProviderKind,
  SeasonStatsQuery,
} from './provider.js';
export { DEFAULT_POLL_INTERVALS, loadProfilesSequentially } from './provider.js';

export type { DataError, DataErrorKind, DataFail, DataOk, DataResult } from './result.js';
export { describeThrown, fail, isFail, isOk, mapResult, ok, unwrapOr, withNotes } from './result.js';

// ---- Competitions config map ------------------------------------------------
export type { CompetitionConfig } from './competitions.js';
export {
  allCompetitions,
  COMPETITION_CODES,
  COMPETITION_CONFIGS,
  COMPETITIONS,
  competitionConfigByApiFootballId,
  competitionConfigByCode,
  competitionConfigById,
  competitionConfigByEspnSlug,
  CURRENT_SEASON_YEAR,
  isSupportedCompetitionId,
  seasonLabel,
  seasonStartYear,
  toCompetition,
} from './competitions.js';

// ---- Factory (free sources: live = ESPN + Wikidata (+ optional API-Football fallback), or fixture) --------
export type {
  ApiFootballConfigInput,
  EspnConfigInput,
  FixtureProviderConfigInput,
  FootballDataConfig,
  FootballDataEnv,
  ProviderSelection,
  WikidataConfigInput,
} from './factory.js';
export {
  createFootballDataProvider,
  describeLiveWiring,
  FOOTBALL_DATA_ENV_VARS,
  FootballDataConfigError,
  readFootballDataConfigFromEnv,
  resolveProviderSelection,
} from './factory.js';

// ---- Composite routing -------------------------------------------------------
export type { CompositeProviderConfig } from './composite.js';
export { CompositeProvider } from './composite.js';

// ---- Implementations ---------------------------------------------------------
export type { EspnProviderConfig } from './espn/espn-provider.js';
export {
  compactDate,
  DEFAULT_DATA_USER_AGENT,
  ESPN_DEFAULT_ATHLETE_BASE_URL,
  ESPN_DEFAULT_BASE_URL,
  ESPN_DEFAULT_RATE_LIMIT,
  ESPN_MAX_DATE_WINDOW_DAYS,
  EspnProvider,
} from './espn/espn-provider.js';

export type { CareerLookup, CareerLookupResult, CareerProvider, WikidataCareerProviderConfig } from './wikidata/wikidata-career-provider.js';
export {
  WIKIDATA_DEFAULT_RATE_LIMIT,
  WIKIDATA_SPARQL_ENDPOINT,
  WikidataCareerProvider,
} from './wikidata/wikidata-career-provider.js';

export type { ApiFootballConfig, ApiFootballTelemetry } from './api-football/api-football-provider.js';
export {
  API_FOOTBALL_DEFAULT_BASE_URL,
  API_FOOTBALL_DEFAULT_HOST,
  ApiFootballProvider,
} from './api-football/api-football-provider.js';

export type { FixtureProviderOptions, FixtureReplayConfig } from './fixture/fixture-provider.js';
export { FixtureProvider, replayableFixtureIds } from './fixture/fixture-provider.js';

export type { MatchReplayOptions, MatchReplayStatus } from './fixture/replay.js';
export { buildElapsedAxis, MatchReplay } from './fixture/replay.js';

export type { RecordedDataset } from './fixture/dataset.js';
export { DATASET_INDEX_FILE, loadRecordedDataset, profileFor } from './fixture/dataset.js';

// ---- Prefetch and datasets ---------------------------------------------------
export type {
  MatchdayBundle,
  MatchdayPrefetchOptions,
  MatchdayPrefetchProgress,
  PrefetchStep,
  PrefetchStepId,
  PrefetchStepStatus,
  TeamSquad,
} from './prefetch.js';
export { MatchdayPrefetcher, PREFETCH_STEP_LABELS, PREFETCH_STEP_ORDER } from './prefetch.js';

export type { GeneralDataset, GeneralDatasetLoader, GeneralDatasetOptions } from './general-dataset.js';
export {
  buildGeneralDataset,
  buildLeaderboards,
  createGeneralDatasetLoader,
  DEFAULT_LEADERBOARD_METRICS,
} from './general-dataset.js';

// ---- Guessable stats (G7 Guess the Number) -----------------------------------
export type { GuessableStatFact, GuessableStatMetric, GuessableStatUnit } from './guessable-stats.js';
export {
  BIO_GUESSABLE_METRICS,
  buildBioGuessableStats,
  buildGuessableStats,
  buildSeasonGuessableStats,
  groupGuessableStatsByPlayer,
  METRIC_LABEL,
  SEASON_GUESSABLE_METRICS,
} from './guessable-stats.js';

// ---- Data quality -------------------------------------------------------------
export type { DataCapability, FixtureQualityInput, GameAvailability, GeneralQualityInput } from './data-quality.js';
export {
  assessFixtureDataQuality,
  assessGeneralDataQuality,
  availableGameIds,
  DATA_CAPABILITIES,
  EMPTY_DATA_QUALITY,
  evaluateGameAvailability,
  GAME_DATA_REQUIREMENTS,
  mergeDataQuality,
} from './data-quality.js';

// ---- Team-name matching (careers → real team ids) -----------------------------
export type { TeamNameResolver } from './team-names.js';
export { createTeamNameResolver, teamNameKey } from './team-names.js';

// ---- Ports and plumbing ---------------------------------------------------------
export type { DataClock, ManualClock } from './clock.js';
export { createManualClock, systemDataClock } from './clock.js';

export type { DataSource } from './data-source.js';
export { createInMemoryDataSource } from './data-source.js';
export { createNodeDataSource, defaultDataDir } from './node-data-source.js';

export type { CacheStats, CacheTtlConfig, TtlCacheOptions } from './cache.js';
export { cacheKey, DEFAULT_CACHE_TTL, ResourceCache } from './cache.js';

export type { RateLimitConfig } from './rate-limiter.js';
export { DEFAULT_RATE_LIMIT, RateLimiter, RateLimitQueueFullError } from './rate-limiter.js';

export type { HttpClient, HttpOutcome, HttpRequest, HttpResponse, RetryConfig } from './http.js';
export { backoffDelayMs, createFetchHttpClient, DEFAULT_RETRY, DEFAULT_TIMEOUT_MS, requestWithRetry } from './http.js';

export type { UpstreamClientOptions, UpstreamTelemetry } from './upstream.js';
export { UpstreamClient } from './upstream.js';

// ---- Normalizers (exported for adapter tests and for hub re-use) -----------------
export type { Normalized } from './api-football/normalize.js';
export {
  coerceNumber,
  normalizeCareer,
  normalizeEvents,
  normalizeEventType,
  normalizeFixture,
  normalizeFixtures,
  normalizeFixtureStatus,
  normalizeLineups,
  normalizePlayerBio,
  normalizePlayerMatchStats,
  normalizePlayerSeasonStats,
  normalizePosition,
  normalizeSquad,
  normalizeTeam,
  normalizeTeamStats,
  playerIdsInEvents,
} from './api-football/normalize.js';

export {
  buildSummaryIndex,
  foldName,
  normalizeEspnAthlete,
  normalizeEspnEvents,
  normalizeEspnLineups,
  normalizeEspnPlayType,
  normalizeEspnPlayerMatchStats,
  normalizeEspnPosition,
  normalizeEspnRosterAthlete,
  normalizeEspnRosterPlayers,
  normalizeEspnRosterSeasonStats,
  normalizeEspnScoreboard,
  normalizeEspnScoreboardEvent,
  normalizeEspnStatus,
  normalizeEspnSummaryFixture,
  normalizeEspnTeam,
  normalizeEspnTeams,
  normalizeEspnTeamStats,
  parseEspnClock,
  rosterAthleteIds,
} from './espn/normalize.js';
export type { SummaryIndex } from './espn/normalize.js';

export type {
  CareerMatchStatus,
  MatchOutcome,
  ParsedCareer,
  WikidataCandidate,
} from './wikidata/normalize.js';
export {
  foldPersonName,
  matchCandidate,
  parseCandidates,
  parseCareers,
  seasonFromWikidataDate,
} from './wikidata/normalize.js';

export type { SparqlBinding, SparqlResults } from './wikidata/sparql.js';
export {
  candidatesByBirthDateQuery,
  careersQuery,
  entityIdFromUri,
  isEntityId,
  isIsoDate,
  WIKIDATA_FOOTBALLER,
} from './wikidata/sparql.js';
