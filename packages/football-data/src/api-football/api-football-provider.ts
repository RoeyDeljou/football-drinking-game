/**
 * `ApiFootballProvider` — the live implementation, backed by API-Football v3 over RapidAPI.
 *
 * Every upstream call goes through the same pipeline:
 *
 *   TTL cache (+ coalescing) → rate limiter → HTTP with retry/backoff → Zod validation → normalization
 *
 * so no path can skip the request budget, and no unvalidated payload can reach the engine. The API key arrives
 * through config; this file never reads `process.env`.
 */

import type { CacheTtlConfig } from '../cache.js';
import { cacheKey, DEFAULT_CACHE_TTL, ResourceCache } from '../cache.js';
import type { DataClock } from '../clock.js';
import { systemDataClock } from '../clock.js';
import type { CompetitionConfig } from '../competitions.js';
import {
  allCompetitions,
  competitionConfigByApiFootballId,
  competitionConfigByCode,
  competitionConfigById,
  COMPETITION_CONFIGS,
  CURRENT_SEASON_YEAR,
  seasonLabel,
  seasonStartYear,
} from '../competitions.js';
import type {
  Competition,
  CompetitionId,
  Fixture,
  FixtureId,
  FixtureLineups,
  FootballPlayerId,
  LiveMatchState,
  MatchEvent,
  Player,
  PlayerMatchStats,
  PlayerProfile,
  PlayerSeasonStats,
  TeamId,
  TeamMatchStats,
} from '../domain.js';
import { asSeasonId } from '../domain.js';
import type { HttpClient, HttpOutcome, RetryConfig } from '../http.js';
import { createFetchHttpClient, DEFAULT_RETRY, DEFAULT_TIMEOUT_MS, requestWithRetry } from '../http.js';
import type {
  FixtureQuery,
  FixturesByDateQuery,
  FootballDataProvider,
  PollIntervalConfig,
  ProviderKind,
  SeasonStatsQuery,
} from '../provider.js';
import { DEFAULT_POLL_INTERVALS, loadProfilesSequentially } from '../provider.js';
import type { RateLimitConfig } from '../rate-limiter.js';
import { DEFAULT_RATE_LIMIT, RateLimiter, RateLimitQueueFullError } from '../rate-limiter.js';
import type { DataResult } from '../result.js';
import { describeThrown, fail, ok } from '../result.js';
import {
  normalizeCareer,
  normalizeEvents,
  normalizeFixture,
  normalizeFixtures,
  normalizeLineups,
  normalizePlayerBio,
  normalizePlayerMatchStats,
  normalizePlayerSeasonStats,
  normalizeSquad,
  normalizeTeamStats,
} from './normalize.js';
import type { z } from 'zod';
import {
  envelopeErrorMessage,
  eventsResponseSchema,
  fixturePlayersResponseSchema,
  fixturesResponseSchema,
  lineupsResponseSchema,
  playersResponseSchema,
  squadsResponseSchema,
  teamStatisticsResponseSchema,
  transfersResponseSchema,
} from './schemas.js';

export const API_FOOTBALL_DEFAULT_HOST = 'api-football-v1.p.rapidapi.com';
export const API_FOOTBALL_DEFAULT_BASE_URL = 'https://api-football-v1.p.rapidapi.com/v3';

export interface ApiFootballConfig {
  /** RapidAPI key. Injected by the caller; never read from the environment inside this package. */
  readonly apiKey: string;
  /** RapidAPI host header. Defaults to the API-Football v1 host. */
  readonly host?: string | undefined;
  /** Base URL. Override to point at a proxy or a mock server. */
  readonly baseUrl?: string | undefined;
  /** Season to request when a query does not name one. Defaults to the competitions config map. */
  readonly seasonYear?: number | undefined;
  readonly cacheTtl?: Partial<CacheTtlConfig> | undefined;
  readonly rateLimit?: Partial<RateLimitConfig> | undefined;
  readonly retry?: Partial<RetryConfig> | undefined;
  readonly pollIntervals?: Partial<PollIntervalConfig> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly http?: HttpClient | undefined;
  readonly clock?: DataClock | undefined;
  /** Cap on `/players` pages fetched per competition. Each page is 20 rows. Default 3 (60 players). */
  readonly maxPlayerPages?: number | undefined;
}

export interface ApiFootballTelemetry {
  readonly cache: ReturnType<ResourceCache['stats']>;
  readonly rateLimit: ReturnType<RateLimiter['stats']>;
  readonly upstreamCalls: number;
}

export class ApiFootballProvider implements FootballDataProvider {
  readonly kind: ProviderKind = 'api-football';

  private readonly apiKey: string;
  private readonly host: string;
  private readonly baseUrl: string;
  private readonly seasonYear: number | null;
  private readonly ttl: CacheTtlConfig;
  private readonly retry: RetryConfig;
  private readonly timeoutMs: number;
  private readonly http: HttpClient;
  private readonly clock: DataClock;
  private readonly cache: ResourceCache;
  private readonly limiter: RateLimiter;
  private readonly maxPlayerPages: number;

  readonly pollIntervals: PollIntervalConfig;

  private upstreamCalls = 0;

  constructor(config: ApiFootballConfig) {
    this.apiKey = config.apiKey;
    this.host = config.host ?? API_FOOTBALL_DEFAULT_HOST;
    this.baseUrl = (config.baseUrl ?? API_FOOTBALL_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.seasonYear = config.seasonYear ?? null;
    this.ttl = { ...DEFAULT_CACHE_TTL, ...config.cacheTtl };
    this.retry = { ...DEFAULT_RETRY, ...config.retry };
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.http = config.http ?? createFetchHttpClient();
    this.clock = config.clock ?? systemDataClock;
    this.cache = new ResourceCache({ clock: this.clock });
    this.limiter = new RateLimiter({ ...DEFAULT_RATE_LIMIT, ...config.rateLimit }, this.clock);
    this.pollIntervals = { ...DEFAULT_POLL_INTERVALS, ...config.pollIntervals };
    this.maxPlayerPages = Math.max(1, config.maxPlayerPages ?? 3);
  }

  telemetry(): ApiFootballTelemetry {
    return { cache: this.cache.stats(), rateLimit: this.limiter.stats(), upstreamCalls: this.upstreamCalls };
  }

  /** Drop every cached response. Used when a host restarts a session and wants fresh data. */
  clearCache(): void {
    this.cache.clear();
  }

  listCompetitions(): Promise<DataResult<readonly Competition[]>> {
    // The supported set is config, not upstream data, so this is free and always available.
    return Promise.resolve(ok(allCompetitions()));
  }

  async getFixturesByCompetition(
    competitionId: CompetitionId,
    query: FixtureQuery = {},
  ): Promise<DataResult<readonly Fixture[]>> {
    const config = competitionConfigById(competitionId);
    if (config === null) {
      return fail('BAD_REQUEST', `unsupported competition id: ${competitionId}`, { retryable: false });
    }
    const season = this.resolveSeasonYear(config, query.season);
    const params: Record<string, string | number> = { league: config.apiFootballLeagueId, season };
    if (query.from !== undefined) params['from'] = query.from;
    if (query.to !== undefined) params['to'] = query.to;

    const result = await this.get('fixtures', params, this.ttl.fixtures, fixturesResponseSchema);
    if (!result.ok) return result;
    const normalized = normalizeFixtures(result.value.response, () => config);
    const limited =
      query.limit === undefined ? normalized.value : normalized.value.slice(0, Math.max(0, query.limit));
    return ok(limited, [...result.notes, ...normalized.notes], result.fromCache);
  }

  async getFixturesByDate(query: FixturesByDateQuery): Promise<DataResult<readonly Fixture[]>> {
    const configs: readonly CompetitionConfig[] =
      query.competitions === undefined
        ? COMPETITION_CONFIGS
        : query.competitions.map((code) => competitionConfigByCode(code));

    const notes: string[] = [];
    const fixtures: Fixture[] = [];
    let allFromCache = true;
    let lastFailure: DataResult<readonly Fixture[]> | null = null;

    for (const config of configs) {
      const result = await this.get(
        'fixtures',
        { date: query.date, league: config.apiFootballLeagueId, season: this.resolveSeasonYear(config, undefined) },
        this.ttl.fixtures,
        fixturesResponseSchema,
      );
      if (!result.ok) {
        // One competition failing must not blank the whole matchday list.
        notes.push(`Could not load ${config.name} fixtures for ${query.date}: ${result.error.message}`);
        lastFailure = result;
        continue;
      }
      if (!result.fromCache) allFromCache = false;
      const normalized = normalizeFixtures(result.value.response, (leagueId) =>
        leagueId === config.apiFootballLeagueId ? config : competitionConfigByApiFootballId(leagueId),
      );
      fixtures.push(...normalized.value);
      notes.push(...result.notes, ...normalized.notes);
    }

    if (fixtures.length === 0 && lastFailure !== null) return lastFailure;
    fixtures.sort((left, right) => left.kickoff.localeCompare(right.kickoff));
    return ok(fixtures, notes, allFromCache && fixtures.length > 0);
  }

  async getFixture(fixtureId: FixtureId): Promise<DataResult<Fixture | null>> {
    const result = await this.get('fixtures', { id: fixtureId }, this.ttl.fixture, fixturesResponseSchema);
    if (!result.ok) return result;
    const row = result.value.response[0];
    if (row === undefined) return ok(null, [...result.notes, `Fixture ${fixtureId} not found upstream.`]);
    const config = competitionConfigByApiFootballId(row.league.id);
    if (config === null) {
      return ok(null, [
        ...result.notes,
        `Fixture ${fixtureId} belongs to unsupported league ${String(row.league.id)}.`,
      ]);
    }
    const normalized = normalizeFixture(row, config);
    return ok(normalized.value, [...result.notes, ...normalized.notes], result.fromCache);
  }

  async getLineups(fixtureId: FixtureId): Promise<DataResult<FixtureLineups | null>> {
    const fixtureResult = await this.getFixture(fixtureId);
    if (!fixtureResult.ok) return fixtureResult;
    const fixture = fixtureResult.value;
    if (fixture === null) {
      return ok(null, [...fixtureResult.notes, `Cannot load lineups: fixture ${fixtureId} is unknown.`]);
    }

    const result = await this.get('fixtures/lineups', { fixture: fixtureId }, this.ttl.lineups, lineupsResponseSchema);
    if (!result.ok) return result;
    const normalized = normalizeLineups(fixtureId, result.value.response, fixture.homeTeam.id);
    return ok(normalized.value, [...result.notes, ...normalized.notes], result.fromCache);
  }

  async getSquad(teamId: TeamId): Promise<DataResult<readonly Player[]>> {
    const result = await this.get('players/squads', { team: teamId }, this.ttl.squad, squadsResponseSchema);
    if (!result.ok) return result;
    const row = result.value.response[0];
    if (row === undefined) return ok([], [...result.notes, `No squad returned for team ${teamId}.`]);
    const normalized = normalizeSquad(row);
    return ok(normalized.value, [...result.notes, ...normalized.notes], result.fromCache);
  }

  async getPlayerSeasonStats(query: SeasonStatsQuery): Promise<DataResult<readonly PlayerSeasonStats[]>> {
    const config = competitionConfigById(query.competitionId);
    if (config === null) {
      return fail('BAD_REQUEST', `unsupported competition id: ${query.competitionId}`, { retryable: false });
    }
    const season = this.resolveSeasonYear(config, query.season);
    const seasonId = asSeasonId(seasonLabel(season));
    const rows: PlayerSeasonStats[] = [];
    const notes: string[] = [];
    let allFromCache = true;

    for (let page = 1; page <= this.maxPlayerPages; page += 1) {
      const params: Record<string, string | number> = { league: config.apiFootballLeagueId, season, page };
      if (query.teamId !== undefined) params['team'] = query.teamId;
      const result = await this.get('players', params, this.ttl.seasonStats, playersResponseSchema);
      if (!result.ok) {
        if (rows.length === 0) return result;
        notes.push(`Stopped paging player statistics after page ${String(page - 1)}: ${result.error.message}`);
        break;
      }
      if (!result.fromCache) allFromCache = false;
      notes.push(...result.notes);
      for (const raw of result.value.response) {
        const normalized = normalizePlayerSeasonStats(raw, competitionConfigByApiFootballId);
        rows.push(...normalized.value.filter((row) => row.competitionId === config.id && row.season === seasonId));
      }
      const paging = result.value.paging;
      if (paging === undefined || paging.current >= paging.total) break;
      if (query.limit !== undefined && rows.length >= query.limit) break;
    }

    const limited = query.limit === undefined ? rows : rows.slice(0, Math.max(0, query.limit));
    if (limited.length === 0) notes.push(`No season statistics returned for ${config.name} ${season}.`);
    return ok(limited, notes, allFromCache && limited.length > 0);
  }

  async getPlayerProfile(playerId: FootballPlayerId): Promise<DataResult<PlayerProfile | null>> {
    const bioResult = await this.get(
      'players',
      { id: playerId, season: this.seasonYear ?? CURRENT_SEASON_YEAR },
      this.ttl.playerProfile,
      playersResponseSchema,
    );
    if (!bioResult.ok) return bioResult;
    const raw = bioResult.value.response[0];
    if (raw === undefined) return ok(null, [...bioResult.notes, `Player ${playerId} not found upstream.`]);
    const bio = normalizePlayerBio(raw);
    if (bio.value === null) return ok(null, [...bioResult.notes, ...bio.notes]);

    const notes = [...bioResult.notes, ...bio.notes];
    const careerResult = await this.get(
      'transfers',
      { player: playerId },
      this.ttl.playerProfile,
      transfersResponseSchema,
    );
    if (!careerResult.ok) {
      // A missing career is a `DataQuality` matter (it disables G3/G8), not a failed profile.
      notes.push(`Career history unavailable for ${bio.value.name}: ${careerResult.error.message}`);
      return ok({ player: bio.value, career: [] }, notes);
    }
    const transferRow = careerResult.value.response[0];
    if (transferRow === undefined) {
      notes.push(`No transfer history returned for ${bio.value.name}.`);
      return ok({ player: bio.value, career: [] }, notes);
    }
    const career = normalizeCareer(transferRow);
    return ok({ player: bio.value, career: career.value }, [...notes, ...career.notes]);
  }

  getPlayerProfiles(playerIds: readonly FootballPlayerId[]): Promise<DataResult<readonly PlayerProfile[]>> {
    return loadProfilesSequentially(this, playerIds);
  }

  async getLiveMatchState(fixtureId: FixtureId): Promise<DataResult<LiveMatchState | null>> {
    const fixtureResult = await this.getFixture(fixtureId);
    if (!fixtureResult.ok) return fixtureResult;
    const fixture = fixtureResult.value;
    if (fixture === null) return ok(null, [...fixtureResult.notes, `Fixture ${fixtureId} is unknown.`]);

    const notes = [...fixtureResult.notes];
    const eventsResult = await this.getMatchEvents(fixtureId);
    let events: readonly MatchEvent[] = [];
    if (eventsResult.ok) {
      events = eventsResult.value;
      notes.push(...eventsResult.notes);
    } else {
      notes.push(`Event feed unavailable for fixture ${fixtureId}: ${eventsResult.error.message}`);
    }

    let teamStats: readonly TeamMatchStats[] = [];
    const statsResult = await this.get(
      'fixtures/statistics',
      { fixture: fixtureId },
      this.ttl.liveMatch,
      teamStatisticsResponseSchema,
    );
    if (statsResult.ok) {
      const normalized = normalizeTeamStats(statsResult.value.response);
      teamStats = normalized.value;
      notes.push(...statsResult.notes, ...normalized.notes);
    } else {
      notes.push(`Team statistics unavailable for fixture ${fixtureId}: ${statsResult.error.message}`);
    }

    let playerStats: readonly PlayerMatchStats[] = [];
    const playersResult = await this.get(
      'fixtures/players',
      { fixture: fixtureId },
      this.ttl.liveMatch,
      fixturePlayersResponseSchema,
    );
    if (playersResult.ok) {
      const normalized = normalizePlayerMatchStats(playersResult.value.response);
      playerStats = normalized.value;
      notes.push(...playersResult.notes, ...normalized.notes);
    } else {
      notes.push(`Player match statistics unavailable for fixture ${fixtureId}: ${playersResult.error.message}`);
    }

    return ok(
      {
        fixture,
        events,
        teamStats,
        playerStats,
        updatedAt: new Date(this.clock.now()).toISOString(),
      },
      notes,
    );
  }

  async getMatchEvents(fixtureId: FixtureId): Promise<DataResult<readonly MatchEvent[]>> {
    const result = await this.get(
      'fixtures/events',
      { fixture: fixtureId },
      this.ttl.matchEvents,
      eventsResponseSchema,
    );
    if (!result.ok) return result;
    const normalized = normalizeEvents(fixtureId, result.value.response);
    return ok(normalized.value, [...result.notes, ...normalized.notes], result.fromCache);
  }

  private resolveSeasonYear(config: CompetitionConfig, season: string | undefined): number {
    if (season !== undefined) {
      const parsed = seasonStartYear(season);
      if (parsed !== null) return parsed;
    }
    return this.seasonYear ?? config.currentSeasonYear;
  }

  /**
   * The single upstream path: cache → coalesce → rate limit → retry → validate.
   * Every endpoint goes through here, so no call site can bypass the request budget.
   */
  private async get<T>(
    endpoint: string,
    params: Readonly<Record<string, string | number | null | undefined>>,
    ttlMs: number,
    schema: z.ZodType<T>,
  ): Promise<DataResult<T>> {
    if (this.apiKey.length === 0) {
      return fail('NOT_CONFIGURED', 'ApiFootballProvider was constructed without an API key', { retryable: false });
    }
    const key = cacheKey(endpoint, params);
    return this.cache.fetch<T>(key, ttlMs, async () => {
      const url = this.buildUrl(endpoint, params);
      let outcome: DataResult<HttpOutcome>;
      try {
        outcome = await this.limiter.schedule(async () => {
          this.upstreamCalls += 1;
          return requestWithRetry({
            http: this.http,
            clock: this.clock,
            retry: this.retry,
            request: {
              url,
              headers: { 'x-rapidapi-key': this.apiKey, 'x-rapidapi-host': this.host, accept: 'application/json' },
              timeoutMs: this.timeoutMs,
            },
          });
        });
      } catch (thrown) {
        if (thrown instanceof RateLimitQueueFullError) {
          return fail('RATE_LIMITED', thrown.message, { retryable: true });
        }
        return fail('NETWORK', describeThrown(thrown), { retryable: true });
      }

      if (!outcome.ok) return outcome;
      const { response, telemetry } = outcome.value;

      const envelopeError = extractEnvelopeError(response.body);
      if (envelopeError !== null) {
        return fail('UPSTREAM', `API-Football reported: ${envelopeError}`, {
          status: response.status,
          attempts: telemetry.attempts,
        });
      }

      const parsed = schema.safeParse(response.body);
      if (!parsed.success) {
        return fail(
          'INVALID_RESPONSE',
          `unexpected /${endpoint} payload — ${parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ')}`,
          { status: response.status, retryable: false, attempts: telemetry.attempts },
        );
      }
      const notes =
        telemetry.attempts > 1
          ? [`Upstream /${endpoint} needed ${String(telemetry.attempts)} attempts (backoff applied).`]
          : [];
      return ok(parsed.data, notes);
    });
  }

  private buildUrl(endpoint: string, params: Readonly<Record<string, string | number | null | undefined>>): string {
    const url = new URL(`${this.baseUrl}/${endpoint}`);
    for (const name of Object.keys(params).sort()) {
      const value = params[name];
      if (value === null || value === undefined) continue;
      url.searchParams.set(name, String(value));
    }
    return url.toString();
  }
}

function extractEnvelopeError(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  if (!('errors' in body)) return null;
  return envelopeErrorMessage((body as { errors: unknown }).errors);
}
