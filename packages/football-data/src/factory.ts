/**
 * Provider selection — one factory, one decision, free sources only.
 *
 * | `provider`        | What you get                                                                          |
 * |-------------------|---------------------------------------------------------------------------------------|
 * | `live` (default)  | `CompositeProvider`: ESPN (primary) + Wikidata careers, plus API-Football as a fallback **only if** an API key is configured |
 * | `fixture`         | `FixtureProvider`: the recorded snapshot in `data/`, fully offline, with match replay |
 *
 * Configuration arrives as an object. `readFootballDataConfigFromEnv` is the *only* bridge to environment
 * variables and takes the environment as an argument, so this package never reads `process.env` itself —
 * `apps/api` calls `readFootballDataConfigFromEnv(process.env)` and passes the result in.
 */

import type { DataClock } from './clock.js';
import { systemDataClock } from './clock.js';
import { CompositeProvider } from './composite.js';
import type { DataSource } from './data-source.js';
import type { HttpClient } from './http.js';
import { createNodeDataSource } from './node-data-source.js';
import type { FootballDataProvider } from './provider.js';
import type { ApiFootballConfig } from './api-football/api-football-provider.js';
import { ApiFootballProvider } from './api-football/api-football-provider.js';
import type { EspnProviderConfig } from './espn/espn-provider.js';
import { DEFAULT_DATA_USER_AGENT, EspnProvider } from './espn/espn-provider.js';
import type { FixtureReplayConfig } from './fixture/fixture-provider.js';
import { FixtureProvider } from './fixture/fixture-provider.js';
import type { WikidataCareerProviderConfig } from './wikidata/wikidata-career-provider.js';
import { WikidataCareerProvider } from './wikidata/wikidata-career-provider.js';

export type ProviderSelection = 'live' | 'fixture';

export type EspnConfigInput = Omit<EspnProviderConfig, 'http' | 'clock' | 'userAgent'>;

export interface WikidataConfigInput extends Omit<WikidataCareerProviderConfig, 'http' | 'clock' | 'userAgent'> {
  /** Default true. Turn off to run live without career enrichment (G3/G8 then report no career data). */
  readonly enabled?: boolean | undefined;
}

export interface ApiFootballConfigInput extends Omit<ApiFootballConfig, 'apiKey' | 'http' | 'clock'> {
  /** Free-tier RapidAPI key (100 requests/day). Its presence is what adds API-Football as a fallback. */
  readonly apiKey?: string | undefined;
}

export interface FixtureProviderConfigInput {
  /** Directory holding the recorded JSON. Defaults to the packaged `data/` directory. */
  readonly dataDir?: string | undefined;
  /** Supply the dataset directly, bypassing the filesystem entirely (browser bundles, tests). */
  readonly dataSource?: DataSource | undefined;
  readonly replay?: FixtureReplayConfig | undefined;
  readonly latencyMs?: number | undefined;
}

export interface FootballDataConfig {
  /** `live` (default) or `fixture`. */
  readonly provider?: ProviderSelection | undefined;
  /**
   * Descriptive User-Agent with a contact URL, sent to ESPN and Wikidata. Wikimedia requires one; ESPN's edge
   * rejects bare tokens. Defaults to `DEFAULT_DATA_USER_AGENT` — deployments should set their own.
   */
  readonly userAgent?: string | undefined;
  readonly espn?: EspnConfigInput | undefined;
  readonly wikidata?: WikidataConfigInput | undefined;
  readonly apiFootball?: ApiFootballConfigInput | undefined;
  readonly fixture?: FixtureProviderConfigInput | undefined;
  /** Injected clock, shared by every provider built. Defaults to the system clock. */
  readonly clock?: DataClock | undefined;
  /** Injected HTTP client for the live sources. Defaults to a `fetch` wrapper. */
  readonly http?: HttpClient | undefined;
}

/** Which wiring a config resolves to, without constructing anything. */
export function resolveProviderSelection(config: FootballDataConfig): ProviderSelection {
  return config.provider ?? 'live';
}

/** What the `live` wiring will contain for this config. */
export function describeLiveWiring(config: FootballDataConfig): {
  primary: 'espn';
  careers: 'wikidata' | null;
  fallback: 'api-football' | null;
} {
  const apiKey = config.apiFootball?.apiKey ?? '';
  return {
    primary: 'espn',
    careers: config.wikidata?.enabled === false ? null : 'wikidata',
    fallback: apiKey.length > 0 ? 'api-football' : null,
  };
}

/**
 * Build the provider. Synchronous: nothing touches the network or the filesystem until the first query
 * (`FixtureProvider` loads its dataset lazily and coalesces concurrent first queries).
 */
export function createFootballDataProvider(config: FootballDataConfig = {}): FootballDataProvider {
  const clock = config.clock ?? systemDataClock;
  const http = config.http === undefined ? {} : { http: config.http };

  if (resolveProviderSelection(config) === 'fixture') {
    const fixture = config.fixture ?? {};
    return new FixtureProvider({
      dataSource: fixture.dataSource ?? createNodeDataSource(fixture.dataDir),
      clock,
      ...(fixture.replay === undefined ? {} : { replay: fixture.replay }),
      ...(fixture.latencyMs === undefined ? {} : { latencyMs: fixture.latencyMs }),
    });
  }

  const userAgent = config.userAgent ?? DEFAULT_DATA_USER_AGENT;
  const wiring = describeLiveWiring(config);

  const espn = new EspnProvider({ ...config.espn, userAgent, clock, ...http });

  let careers: WikidataCareerProvider | undefined;
  if (wiring.careers !== null) {
    const { enabled: _enabled, ...wikidata } = config.wikidata ?? {};
    careers = new WikidataCareerProvider({ ...wikidata, userAgent, clock, ...http });
  }

  let fallback: ApiFootballProvider | undefined;
  const apiKey = config.apiFootball?.apiKey ?? '';
  if (wiring.fallback !== null) {
    fallback = new ApiFootballProvider({ ...config.apiFootball, apiKey, clock, ...http });
  }

  return new CompositeProvider({ primary: espn, careers, fallback });
}

/**
 * Environment-variable names the data layer understands. Documented in `packages/football-data/README.md`.
 * Values are read from the record passed in, never from the ambient process.
 */
export const FOOTBALL_DATA_ENV_VARS = {
  provider: 'FOOTBALL_DATA_PROVIDER',
  userAgent: 'FOOTBALL_DATA_USER_AGENT',
  livePollMs: 'FOOTBALL_LIVE_POLL_MS',
  espnBaseUrl: 'ESPN_BASE_URL',
  espnRequestsPerMinute: 'ESPN_RATE_LIMIT_PER_MINUTE',
  wikidataEnabled: 'WIKIDATA_ENABLED',
  wikidataEndpoint: 'WIKIDATA_SPARQL_URL',
  wikidataMaxQueriesPerHour: 'WIKIDATA_MAX_QUERIES_PER_HOUR',
  apiFootballKey: 'API_FOOTBALL_KEY',
  apiFootballHost: 'API_FOOTBALL_HOST',
  apiFootballBaseUrl: 'API_FOOTBALL_BASE_URL',
  apiFootballSeason: 'API_FOOTBALL_SEASON',
  dataDir: 'FOOTBALL_DATA_DIR',
  replayFixtureId: 'FOOTBALL_REPLAY_FIXTURE_ID',
  replaySpeed: 'FOOTBALL_REPLAY_SPEED',
  replayStartMinute: 'FOOTBALL_REPLAY_START_MINUTE',
  fixtureLatencyMs: 'FOOTBALL_FIXTURE_LATENCY_MS',
} as const;

export type FootballDataEnv = Readonly<Record<string, string | undefined>>;

export class FootballDataConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FootballDataConfigError';
  }
}

/**
 * Translate an environment record into a `FootballDataConfig`. Unset values fall back to defaults; an unrecognised
 * `FOOTBALL_DATA_PROVIDER` is a configuration mistake and throws rather than silently picking a source.
 */
export function readFootballDataConfigFromEnv(env: FootballDataEnv): FootballDataConfig {
  const vars = FOOTBALL_DATA_ENV_VARS;

  const rawProvider = nonEmpty(env[vars.provider])?.toLowerCase() ?? null;
  if (rawProvider !== null && rawProvider !== 'live' && rawProvider !== 'fixture') {
    throw new FootballDataConfigError(
      `${vars.provider} must be "live" or "fixture" (got "${rawProvider}").`,
    );
  }

  const config: {
    provider?: ProviderSelection;
    userAgent?: string;
    espn: { baseUrl?: string; rateLimit?: { maxRequests: number; windowMs: number }; pollIntervals?: { liveEventsMs: number } };
    wikidata: { enabled?: boolean; endpoint?: string; maxQueriesPerHour?: number };
    apiFootball: { apiKey?: string; host?: string; baseUrl?: string; seasonYear?: number };
    fixture: { dataDir?: string; latencyMs?: number; replay?: FixtureReplayConfig };
  } = { espn: {}, wikidata: {}, apiFootball: {}, fixture: {} };

  if (rawProvider === 'live' || rawProvider === 'fixture') config.provider = rawProvider;
  setIf(nonEmpty(env[vars.userAgent]), (value) => (config.userAgent = value));

  setIf(nonEmpty(env[vars.espnBaseUrl]), (value) => (config.espn.baseUrl = value));
  setIf(parseInteger(env[vars.espnRequestsPerMinute]), (perMinute) => {
    // Expressed per minute for operators; enforced as a 5-second window so bursts stay small.
    config.espn.rateLimit = { maxRequests: Math.max(1, Math.round(perMinute / 12)), windowMs: 5_000 };
  });
  setIf(parseInteger(env[vars.livePollMs]), (value) => (config.espn.pollIntervals = { liveEventsMs: value }));

  const wikidataEnabled = nonEmpty(env[vars.wikidataEnabled])?.toLowerCase() ?? null;
  if (wikidataEnabled !== null) config.wikidata.enabled = !['0', 'false', 'no', 'off'].includes(wikidataEnabled);
  setIf(nonEmpty(env[vars.wikidataEndpoint]), (value) => (config.wikidata.endpoint = value));
  setIf(parseInteger(env[vars.wikidataMaxQueriesPerHour]), (value) => (config.wikidata.maxQueriesPerHour = value));

  setIf(nonEmpty(env[vars.apiFootballKey]), (value) => (config.apiFootball.apiKey = value));
  setIf(nonEmpty(env[vars.apiFootballHost]), (value) => (config.apiFootball.host = value));
  setIf(nonEmpty(env[vars.apiFootballBaseUrl]), (value) => (config.apiFootball.baseUrl = value));
  setIf(parseInteger(env[vars.apiFootballSeason]), (value) => (config.apiFootball.seasonYear = value));

  setIf(nonEmpty(env[vars.dataDir]), (value) => (config.fixture.dataDir = value));
  setIf(parseInteger(env[vars.fixtureLatencyMs]), (value) => (config.fixture.latencyMs = value));
  setIf(nonEmpty(env[vars.replayFixtureId]), (fixtureId) => {
    const replay: { fixtureId: string; speedMultiplier?: number; startMinute?: number } = { fixtureId };
    setIf(parseNumber(env[vars.replaySpeed]), (value) => (replay.speedMultiplier = value));
    setIf(parseInteger(env[vars.replayStartMinute]), (value) => (replay.startMinute = value));
    config.fixture.replay = replay;
  });

  return config;
}

function setIf<T>(value: T | null, apply: (value: T) => unknown): void {
  if (value !== null) apply(value);
}

function nonEmpty(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parseInteger(raw: string | undefined): number | null {
  const value = nonEmpty(raw);
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseNumber(raw: string | undefined): number | null {
  const value = nonEmpty(raw);
  if (value === null) return null;
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
}
