/**
 * `EspnProvider` — the primary live implementation, backed by ESPN's public site API. Free, no key.
 *
 * The API is unofficial and undocumented: no SLA, shapes can change, and the terms are unclear. This adapter is
 * therefore deliberately polite and deliberately tolerant:
 *
 * - **Polite**: a sliding-window limiter defaulting to 5 requests per 5 seconds (≈1 req/s sustained, bursts of 5)
 *   with 2 in flight, per-endpoint TTLs, coalescing of identical concurrent requests, backoff on 429/5xx, and a
 *   descriptive User-Agent. ESPN's edge answers 403 to bare tokens like `MyApp/1.0`; a UA with a `(+contact-url)`
 *   comment is accepted, which is also simply good manners.
 * - **Tolerant**: lenient Zod schemas plus normalizers that turn missing fields into nulls and notes.
 *
 * Endpoints used (all `https://site.api.espn.com/apis/site/v2/sports/soccer/...`):
 *
 * | Capability            | Endpoint                                   |
 * |-----------------------|--------------------------------------------|
 * | fixtures              | `{slug}/scoreboard[?dates=YYYYMMDD]`        |
 * | fixture, lineups, live| `all/summary?event={id}`                   |
 * | teams                 | `{slug}/teams`                             |
 * | squad + season stats  | `{slug}/teams/{teamId}/roster`             |
 * | athlete bio fallback  | `site.web.api.espn.com/apis/common/v3/sports/soccer/athletes/{id}` |
 *
 * Career history is not an ESPN capability; `CompositeProvider` fills it from Wikidata.
 */

import type { CacheTtlConfig } from '../cache.js';
import { DEFAULT_CACHE_TTL, withLivePollTtl } from '../cache.js';
import type { DataClock } from '../clock.js';
import { systemDataClock } from '../clock.js';
import type { CompetitionConfig } from '../competitions.js';
import {
  allCompetitions,
  allEspnSlugs,
  COMPETITION_CONFIGS,
  competitionConfigByCode,
  competitionConfigByEspnSlug,
  competitionConfigById,
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
  PlayerProfile,
  PlayerSeasonStats,
  TeamId,
} from '../domain.js';
import type { HttpClient, RetryConfig } from '../http.js';
import { createFetchHttpClient, DEFAULT_RETRY, DEFAULT_TIMEOUT_MS } from '../http.js';
import type {
  FixtureQuery,
  FixturesByDateQuery,
  FootballDataProvider,
  PollIntervalConfig,
  ProviderKind,
  SeasonStatsQuery,
} from '../provider.js';
import { DEFAULT_POLL_INTERVALS, listLiveFixturesFor, loadProfilesSequentially } from '../provider.js';
import type { RateLimitConfig } from '../rate-limiter.js';
import type { DataResult } from '../result.js';
import { fail, ok } from '../result.js';
import type { UpstreamTelemetry } from '../upstream.js';
import { UpstreamClient } from '../upstream.js';
import { eventsMatchFixtureScore, withGuaranteedFullTime } from '../full-time.js';
import {
  isEspnFinalConfirmed,
  isEspnSummaryComplete,
  normalizeEspnAthlete,
  normalizeEspnEvents,
  normalizeEspnLineups,
  normalizeEspnPlayerMatchStats,
  normalizeEspnRosterPlayers,
  normalizeEspnRosterSeasonStats,
  normalizeEspnScoreboard,
  normalizeEspnSummaryFixture,
  normalizeEspnTeams,
  normalizeEspnTeamStats,
} from './normalize.js';
import type { EspnRoster, EspnSummary } from './schemas.js';
import {
  espnAthleteSchema,
  espnRosterSchema,
  espnScoreboardSchema,
  espnSummarySchema,
  espnTeamsSchema,
} from './schemas.js';

export const ESPN_DEFAULT_BASE_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
export const ESPN_DEFAULT_ATHLETE_BASE_URL = 'https://site.web.api.espn.com/apis/common/v3/sports/soccer';
/** Default descriptive User-Agent. Override it with your deployment's own contact URL. */
export const DEFAULT_DATA_USER_AGENT = 'FootballDrinkingGame/0.1 (+https://github.com/football-drinking-game)';

/** ≈1 request/second sustained, bursts of 5, never more than 2 in flight. */
export const ESPN_DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 5,
  windowMs: 5_000,
  maxConcurrent: 2,
  maxQueueDepth: 300,
};

/** Longest date window `getFixturesByCompetition` will walk day by day (ESPN rejects soccer date ranges). */
export const ESPN_MAX_DATE_WINDOW_DAYS = 14;

export interface EspnProviderConfig {
  readonly userAgent?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly athleteBaseUrl?: string | undefined;
  readonly cacheTtl?: Partial<CacheTtlConfig> | undefined;
  readonly rateLimit?: Partial<RateLimitConfig> | undefined;
  readonly retry?: Partial<RetryConfig> | undefined;
  readonly pollIntervals?: Partial<PollIntervalConfig> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly http?: HttpClient | undefined;
  readonly clock?: DataClock | undefined;
}

/** ESPN-specific TTLs on top of the shared defaults: summaries of finished matches barely change. */
const FINISHED_SUMMARY_TTL_MS = 6 * 60 * 60 * 1000;
const SCHEDULED_SUMMARY_TTL_MS = 5 * 60 * 1000;
/** A 'post' summary that is not provably complete is polled at the live cadence for this long after kickoff. */
const INCOMPLETE_SUMMARY_GRACE_MS = 4 * 60 * 60 * 1000;
/** ...then re-checked at this moderate interval. */
const INCOMPLETE_SUMMARY_TTL_MS = 30 * 60 * 1000;
/** From this long before the scheduled kickoff a pre-match summary is polled at the live cadence. */
export const PRE_KICKOFF_LIVE_WINDOW_MS = 2 * 60 * 1000;

export class EspnProvider implements FootballDataProvider {
  readonly kind: ProviderKind = 'espn';
  readonly pollIntervals: PollIntervalConfig;

  private readonly baseUrl: string;
  private readonly athleteBaseUrl: string;
  private readonly ttl: CacheTtlConfig;
  private readonly client: UpstreamClient;
  private readonly clock: DataClock;

  /** Learned id → competition routes, so an id-only call knows which league endpoint to use. */
  private readonly teamSlugs = new Map<string, string>();
  private readonly playerIndex = new Map<string, Player>();

  constructor(config: EspnProviderConfig = {}) {
    this.baseUrl = (config.baseUrl ?? ESPN_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.athleteBaseUrl = (config.athleteBaseUrl ?? ESPN_DEFAULT_ATHLETE_BASE_URL).replace(/\/+$/, '');
    this.pollIntervals = { ...DEFAULT_POLL_INTERVALS, ...config.pollIntervals };
    this.ttl = withLivePollTtl({ ...DEFAULT_CACHE_TTL, ...config.cacheTtl }, this.pollIntervals);
    const retry: RetryConfig = { ...DEFAULT_RETRY, ...config.retry };
    this.clock = config.clock ?? systemDataClock;
    this.client = new UpstreamClient({
      name: 'ESPN',
      http: config.http ?? createFetchHttpClient(),
      clock: this.clock,
      retry,
      rateLimit: { ...ESPN_DEFAULT_RATE_LIMIT, ...config.rateLimit },
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      headers: { 'user-agent': config.userAgent ?? DEFAULT_DATA_USER_AGENT, accept: 'application/json' },
    });
  }

  telemetry(): UpstreamTelemetry {
    return this.client.telemetry();
  }

  clearCache(): void {
    this.client.clearCache();
  }

  listCompetitions(): Promise<DataResult<readonly Competition[]>> {
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

    const notes: string[] = [];
    let fixtures: Fixture[] = [];
    if (query.from === undefined && query.to === undefined) {
      const result = await this.scoreboard(config, null);
      if (!result.ok) return result;
      fixtures = [...result.value];
      notes.push(...result.notes);
    } else {
      const days = dayRange(query.from ?? query.to ?? '', query.to ?? query.from ?? '');
      if (days.length === 0) return fail('BAD_REQUEST', 'invalid date window', { retryable: false });
      const capped = days.slice(0, ESPN_MAX_DATE_WINDOW_DAYS);
      if (capped.length < days.length) {
        notes.push(`Date window capped at ${String(ESPN_MAX_DATE_WINDOW_DAYS)} days to protect the request budget.`);
      }
      let failures = 0;
      for (const day of capped) {
        const result = await this.scoreboard(config, day);
        if (!result.ok) {
          failures += 1;
          notes.push(`Could not load ${config.name} fixtures for ${day}: ${result.error.message}`);
          if (failures === capped.length) return result;
          continue;
        }
        fixtures.push(...result.value);
        notes.push(...result.notes);
      }
    }

    if (query.season !== undefined) {
      const season = query.season;
      fixtures = fixtures.filter((fixture) => fixture.season === season);
    }
    fixtures = dedupeFixtures(fixtures);
    const limited = query.limit === undefined ? fixtures : fixtures.slice(0, Math.max(0, query.limit));
    return ok(limited, dedupeNotes(notes));
  }

  listLiveFixtures(competitionId: CompetitionId): Promise<DataResult<readonly Fixture[]>> {
    return listLiveFixturesFor(this, competitionId);
  }

  async getFixturesByDate(query: FixturesByDateQuery): Promise<DataResult<readonly Fixture[]>> {
    const day = compactDate(query.date);
    if (day === null) return fail('BAD_REQUEST', `invalid date: ${query.date}`, { retryable: false });
    const configs =
      query.competitions === undefined ? COMPETITION_CONFIGS : query.competitions.map(competitionConfigByCode);

    const fixtures: Fixture[] = [];
    const notes: string[] = [];
    let lastFailure: DataResult<readonly Fixture[]> | null = null;
    for (const config of configs) {
      const result = await this.scoreboard(config, day);
      if (!result.ok) {
        notes.push(`Could not load ${config.name} fixtures for ${query.date}: ${result.error.message}`);
        lastFailure = result;
        continue;
      }
      fixtures.push(...result.value);
      notes.push(...result.notes);
    }
    if (fixtures.length === 0 && lastFailure !== null) return lastFailure;
    fixtures.sort((left, right) => left.kickoff.localeCompare(right.kickoff));
    return ok(fixtures, dedupeNotes(notes));
  }

  async getFixture(fixtureId: FixtureId): Promise<DataResult<Fixture | null>> {
    const summary = await this.summary(fixtureId);
    if (!summary.ok) return summary;
    if (summary.value === null) return ok(null, summary.notes);
    const { payload, config } = summary.value;
    const events = normalizeEspnEvents(payload, fixtureId);
    const fixture = normalizeEspnSummaryFixture(payload, config, events.value);
    return ok(fixture.value, [...summary.notes, ...fixture.notes], summary.fromCache);
  }

  async getLineups(fixtureId: FixtureId): Promise<DataResult<FixtureLineups | null>> {
    const summary = await this.summary(fixtureId);
    if (!summary.ok) return summary;
    if (summary.value === null) return ok(null, summary.notes);
    const lineups = normalizeEspnLineups(summary.value.payload, fixtureId);
    return ok(lineups.value, [...summary.notes, ...lineups.notes], summary.fromCache);
  }

  async getSquad(teamId: TeamId): Promise<DataResult<readonly Player[]>> {
    const route = await this.resolveTeamCompetition(teamId);
    if (!route.ok) return route;
    if (route.value === null) {
      return ok([], [`Team ${teamId} is not in any supported ESPN competition.`]);
    }
    const roster = await this.roster(route.value, teamId);
    if (!roster.ok) return roster;
    const players = normalizeEspnRosterPlayers(roster.value, teamId);
    return ok(players.value, [...roster.notes, ...players.notes], roster.fromCache);
  }

  async getPlayerSeasonStats(query: SeasonStatsQuery): Promise<DataResult<readonly PlayerSeasonStats[]>> {
    const config = competitionConfigById(query.competitionId);
    if (config === null) {
      return fail('BAD_REQUEST', `unsupported competition id: ${query.competitionId}`, { retryable: false });
    }
    if (query.season !== undefined && query.season !== config.currentSeason) {
      return ok(
        [],
        [`ESPN roster statistics only cover the current season (${config.currentSeason}); ${query.season} requested.`],
      );
    }

    const notes: string[] = [];
    let teamIds: string[];
    if (query.teamId !== undefined) {
      teamIds = [query.teamId];
    } else {
      const teams = await this.teams(config);
      if (!teams.ok) return teams;
      teamIds = teams.value.map((team) => team.id);
      notes.push(...teams.notes);
    }

    const rows: PlayerSeasonStats[] = [];
    let failures = 0;
    let lastFailure: DataResult<readonly PlayerSeasonStats[]> | null = null;
    for (const teamId of teamIds) {
      if (query.limit !== undefined && rows.length >= query.limit) break;
      const roster = await this.roster(config, teamId);
      if (!roster.ok) {
        failures += 1;
        lastFailure = roster;
        notes.push(`Season stats for team ${teamId} unavailable: ${roster.error.message}`);
        continue;
      }
      const stats = normalizeEspnRosterSeasonStats(roster.value, teamId, config);
      rows.push(...stats.value);
      notes.push(...roster.notes, ...stats.notes);
    }
    if (rows.length === 0 && lastFailure !== null && failures === teamIds.length) return lastFailure;

    rows.sort((left, right) => right.goals - left.goals || right.appearances - left.appearances);
    const limited = query.limit === undefined ? rows : rows.slice(0, Math.max(0, query.limit));
    return ok(limited, dedupeNotes(notes));
  }

  async getPlayerProfile(playerId: FootballPlayerId): Promise<DataResult<PlayerProfile | null>> {
    const careerNote = 'ESPN has no career history; use CompositeProvider with Wikidata for careers.';
    const known = this.playerIndex.get(playerId);
    if (known !== undefined) return ok({ player: known, career: [] }, [careerNote]);

    const url = `${this.athleteBaseUrl}/athletes/${encodeURIComponent(playerId)}`;
    const athlete = await this.client.getJson(`athlete:${playerId}`, url, this.ttl.playerProfile, espnAthleteSchema);
    if (!athlete.ok) return athlete;
    const bio = normalizeEspnAthlete(athlete.value);
    if (bio.value === null) return ok(null, [...athlete.notes, ...bio.notes]);

    // The athlete endpoint lacks DOB and height; the team roster has both, so prefer it when reachable.
    const squad = await this.getSquad(bio.value.teamId);
    if (squad.ok) {
      const full = squad.value.find((player) => player.id === playerId);
      if (full !== undefined) return ok({ player: full, career: [] }, [careerNote]);
    }
    return ok({ player: bio.value, career: [] }, [...athlete.notes, ...bio.notes, careerNote]);
  }

  getPlayerProfiles(playerIds: readonly FootballPlayerId[]): Promise<DataResult<readonly PlayerProfile[]>> {
    return loadProfilesSequentially(this, playerIds);
  }

  async getLiveMatchState(fixtureId: FixtureId): Promise<DataResult<LiveMatchState | null>> {
    const summary = await this.summary(fixtureId);
    if (!summary.ok) return summary;
    if (summary.value === null) return ok(null, summary.notes);
    const { payload, config } = summary.value;

    const events = normalizeEspnEvents(payload, fixtureId);
    const fixture = normalizeEspnSummaryFixture(payload, config, events.value);
    if (fixture.value === null) return ok(null, [...summary.notes, ...fixture.notes]);
    const finalized = finalizeEvents(payload, fixture.value, fixtureId, events.value);
    const guaranteed = finalized.events;
    const synthesized = finalized.notes;
    const teamStats = normalizeEspnTeamStats(payload);
    const playerStats = normalizeEspnPlayerMatchStats(payload, fixture.value);

    return ok(
      {
        fixture: fixture.value,
        events: guaranteed,
        teamStats: teamStats.value,
        playerStats: playerStats.value,
        updatedAt: new Date(this.clock.now()).toISOString(),
      },
      dedupeNotes([...summary.notes, ...events.notes, ...synthesized, ...fixture.notes, ...teamStats.notes, ...playerStats.notes]),
      summary.fromCache,
    );
  }

  async getMatchEvents(fixtureId: FixtureId): Promise<DataResult<readonly MatchEvent[]>> {
    const summary = await this.summary(fixtureId);
    if (!summary.ok) return summary;
    if (summary.value === null) return ok([], summary.notes);
    const { payload, config } = summary.value;
    const events = normalizeEspnEvents(payload, fixtureId);
    const fixture = normalizeEspnSummaryFixture(payload, config, events.value);
    const finalized =
      fixture.value === null
        ? { events: events.value, notes: [] as string[] }
        : finalizeEvents(payload, fixture.value, fixtureId, events.value);
    const guaranteed = finalized.events;
    return ok(guaranteed, [...summary.notes, ...events.notes, ...finalized.notes], summary.fromCache);
  }

  // ---- endpoint helpers ---------------------------------------------------

  /**
   * Fixtures for a competition on one day (or the current window), aggregated across every ESPN slug the
   * competition maps to (`allEspnSlugs`). For every competition but National Teams this is exactly one slug, so
   * behaviour is unchanged; for National Teams it queries each slug in turn — sequentially, through the same
   * shared rate limiter/cache/backoff every other request uses, so a cold multi-slug fetch is simply several
   * polite, queued requests rather than a burst.
   */
  private async scoreboard(config: CompetitionConfig, day: string | null): Promise<DataResult<readonly Fixture[]>> {
    const slugs = allEspnSlugs(config);
    const fixtures: Fixture[] = [];
    const notes: string[] = [];
    let fromCache = true;
    let lastFailure: DataResult<readonly Fixture[]> | null = null;
    let failures = 0;
    for (const slug of slugs) {
      const result = await this.scoreboardForSlug(config, slug, day);
      if (!result.ok) {
        failures += 1;
        lastFailure = result;
        notes.push(`Could not load ${config.name} (${slug}) fixtures for ${day ?? 'the current window'}: ${result.error.message}`);
        continue;
      }
      fixtures.push(...result.value);
      notes.push(...result.notes);
      if (!result.fromCache) fromCache = false;
    }
    if (fixtures.length === 0 && lastFailure !== null && failures === slugs.length) return lastFailure;
    return ok(dedupeFixtures(fixtures), dedupeNotes(notes), fromCache);
  }

  private async scoreboardForSlug(
    config: CompetitionConfig,
    slug: string,
    day: string | null,
  ): Promise<DataResult<readonly Fixture[]>> {
    const suffix = day === null ? '' : `?dates=${day}`;
    const url = `${this.baseUrl}/${slug}/scoreboard${suffix}`;
    const result = await this.client.getJson(
      `scoreboard:${slug}:${day ?? 'current'}`,
      url,
      // The current (undated) scoreboard and today's dated one carry live statuses/minutes/scores, so they get the
      // short live TTL; other days (past results, future schedules) keep the long fixtures TTL.
      day === null || day === compactUtcDate(this.clock.now()) ? this.ttl.liveMatch : this.ttl.fixtures,
      espnScoreboardSchema,
    );
    if (!result.ok) return result;
    const normalized = normalizeEspnScoreboard(result.value, config);
    for (const fixture of normalized.value) {
      this.teamSlugs.set(fixture.homeTeam.id, slug);
      this.teamSlugs.set(fixture.awayTeam.id, slug);
    }
    return ok(normalized.value, [...result.notes, ...normalized.notes], result.fromCache);
  }

  private async summary(
    fixtureId: FixtureId,
  ): Promise<DataResult<{ payload: EspnSummary; config: CompetitionConfig } | null>> {
    const url = `${this.baseUrl}/all/summary?event=${encodeURIComponent(fixtureId)}`;
    const result = await this.client.getJson(`summary:${fixtureId}`, url, summaryTtl(this.ttl, () => this.clock.now()), espnSummarySchema);
    if (!result.ok) return result;
    const slug = result.value.header.league?.slug ?? null;
    if (slug === null) {
      return ok(null, [`Fixture ${fixtureId} belongs to an unsupported competition (unknown).`]);
    }
    const config = competitionConfigByEspnSlug(slug);
    if (config === null) {
      return ok(null, [`Fixture ${fixtureId} belongs to an unsupported competition (${slug}).`]);
    }
    for (const competitor of result.value.header.competitions[0]?.competitors ?? []) {
      this.teamSlugs.set(competitor.team.id, slug);
    }
    return ok({ payload: result.value, config }, result.notes, result.fromCache);
  }

  /**
   * Teams for a competition, aggregated across every ESPN slug it maps to and deduped by team id — a team's ESPN
   * id is stable across the slugs it appears under (verified live: France/Germany/Belgium share one id across
   * `fifa.friendly`, `uefa.nations` and `fifa.worldq.uefa`), so the second and later sightings of the same id are
   * simply dropped rather than merged.
   */
  private async teams(config: CompetitionConfig): Promise<DataResult<readonly { id: string }[]>> {
    const slugs = allEspnSlugs(config);
    const byId = new Map<string, { id: string }>();
    const notes: string[] = [];
    let fromCache = true;
    let lastFailure: DataResult<readonly { id: string }[]> | null = null;
    let failures = 0;
    for (const slug of slugs) {
      const url = `${this.baseUrl}/${slug}/teams`;
      const result = await this.client.getJson(`teams:${slug}`, url, this.ttl.squad, espnTeamsSchema);
      if (!result.ok) {
        failures += 1;
        lastFailure = result;
        notes.push(`Could not load ${config.name} (${slug}) teams: ${result.error.message}`);
        continue;
      }
      const teams = normalizeEspnTeams(result.value, config);
      for (const team of teams.value) {
        if (!byId.has(team.id)) byId.set(team.id, team);
        if (!this.teamSlugs.has(team.id)) this.teamSlugs.set(team.id, slug);
      }
      notes.push(...result.notes, ...teams.notes);
      if (!result.fromCache) fromCache = false;
    }
    if (byId.size === 0 && lastFailure !== null && failures === slugs.length) return lastFailure;
    return ok([...byId.values()], dedupeNotes(notes), fromCache);
  }

  /**
   * A team's roster. National teams' rosters are per call-up window, not per tournament: verified live, France's
   * roster under `fifa.friendly` and under `uefa.nations` was the identical 22 names during the same window. So
   * there is nothing to merge — the roster is fetched from whichever slug the team was actually discovered under
   * (`teamSlugs`, populated by `scoreboard`/`teams`/`summary`), falling back to the competition's primary slug.
   */
  private async roster(config: CompetitionConfig, teamId: string): Promise<DataResult<EspnRoster>> {
    const slug = this.teamSlugs.get(teamId) ?? config.espnSlug;
    const url = `${this.baseUrl}/${slug}/teams/${encodeURIComponent(teamId)}/roster`;
    const result = await this.client.getJson(`roster:${slug}:${teamId}`, url, this.ttl.squad, espnRosterSchema);
    if (result.ok) {
      for (const player of normalizeEspnRosterPlayers(result.value, teamId).value) {
        this.playerIndex.set(player.id, player);
      }
    }
    return result;
  }

  /**
   * Squads are per competition on ESPN, but `getSquad` only has a team id. Use a learned route when we have one;
   * otherwise scan the domestic leagues' team lists (cached for hours) before the Champions League.
   */
  private async resolveTeamCompetition(teamId: TeamId): Promise<DataResult<CompetitionConfig | null>> {
    const known = this.teamSlugs.get(teamId);
    if (known !== undefined) {
      const config = competitionConfigByEspnSlug(known);
      if (config !== null && !config.isCup) return ok(config);
    }
    const ordered = [...COMPETITION_CONFIGS].sort((left, right) => Number(left.isCup) - Number(right.isCup));
    let lastFailure: DataResult<CompetitionConfig | null> | null = null;
    for (const config of ordered) {
      const teams = await this.teams(config);
      if (!teams.ok) {
        lastFailure = teams;
        continue;
      }
      if (teams.value.some((team) => team.id === teamId)) return ok(config);
    }
    if (known !== undefined) return ok(competitionConfigByEspnSlug(known));
    return lastFailure ?? ok(null);
  }
}

/**
 * Apply the FULL_TIME guarantee (see full-time.ts) for a finished ESPN fixture. A synthetic FULL_TIME is only
 * created when the status is an explicit final and the events add up to the header score.
 */
function finalizeEvents(
  payload: EspnSummary,
  fixture: Fixture,
  fixtureId: FixtureId,
  events: readonly MatchEvent[],
): { events: readonly MatchEvent[]; notes: string[] } {
  if (fixture.status !== 'FINISHED') return { events, notes: [] };
  const confirmed = isEspnFinalConfirmed(payload.header.competitions[0]?.status?.type);
  const consistent = eventsMatchFixtureScore(fixture, events);
  const guaranteed = withGuaranteedFullTime(fixtureId, events, confirmed && consistent);
  const hasFullTime = guaranteed.some((event) => event.type === 'FULL_TIME');
  if (hasFullTime) {
    return {
      events: guaranteed,
      notes: guaranteed.some((event) => event.id.startsWith('synthetic:'))
        ? ['ESPN reported the match finished without a full-time play; a synthetic FULL_TIME event was added.']
        : [],
    };
  }
  return {
    events: guaranteed,
    notes: [
      `ESPN fixture ${fixtureId} is finished but no FULL_TIME was synthesized: ${
        confirmed ? 'the events do not add up to the reported score (feed still catching up)' : 'the final status is not confirmed'
      }.`,
    ],
  };
}

function summaryTtl(ttl: CacheTtlConfig, now: () => number): (payload: EspnSummary) => number {
  return (payload) => {
    const type = payload.header.competitions[0]?.status?.type;
    if (type?.completed === true || type?.state === 'post') {
      // Cache for hours only when the summary is provably complete: explicit final status, a real full-time play,
      // and events that account for the header score. Anything else (ESPN flips to 'post' before its plays
      // catch up, a suspended match, a payload with no plays) stays on the short live TTL while the match is
      // recent, so late plays land on the next poll, then drops to a moderate TTL so an old, permanently
      // incomplete summary is not hammered.
      if (isEspnSummaryComplete(payload)) return FINISHED_SUMMARY_TTL_MS;
      const kickoffMs = Date.parse(payload.header.competitions[0]?.date ?? '');
      const recent = Number.isNaN(kickoffMs) || now() < kickoffMs + INCOMPLETE_SUMMARY_GRACE_MS;
      return recent ? ttl.liveMatch : INCOMPLETE_SUMMARY_TTL_MS;
    }
    if (type?.state === 'pre') return scheduledSummaryTtl(ttl, payload.header.competitions[0]?.date, now());
    return ttl.liveMatch;
  };
}

/**
 * TTL for a pre-match summary, derived from the scheduled kickoff so kickoff is never seen late. Far from kickoff it
 * is 5 minutes, but never longer than the time left until the live window opens (kickoff − 2 min), so an entry cached
 * early cannot outlive that window. From the window opening — and after the scheduled time has passed while ESPN
 * still says 'pre' — it is the live TTL. An unparseable kickoff falls back to the 5 minute default.
 */
export function scheduledSummaryTtl(ttl: CacheTtlConfig, kickoff: string | null | undefined, nowMs: number): number {
  const kickoffMs = kickoff === null || kickoff === undefined ? Number.NaN : Date.parse(kickoff);
  if (Number.isNaN(kickoffMs)) return SCHEDULED_SUMMARY_TTL_MS;
  const untilWindow = kickoffMs - PRE_KICKOFF_LIVE_WINDOW_MS - nowMs;
  if (untilWindow <= 0) return ttl.liveMatch;
  return Math.max(ttl.liveMatch, Math.min(SCHEDULED_SUMMARY_TTL_MS, untilWindow));
}

/** Epoch ms -> `YYYYMMDD` (UTC), the form ESPN's `dates=` parameter uses. */
function compactUtcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

/** `2026-09-16` → `20260916`; null for anything else. */
export function compactDate(date: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return null;
  return `${match[1] ?? ''}${match[2] ?? ''}${match[3] ?? ''}`;
}

function dayRange(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return [];
  const days: string[] = [];
  for (let at = start; at <= end; at += 24 * 60 * 60 * 1000) {
    const compact = compactDate(new Date(at).toISOString().slice(0, 10));
    if (compact !== null) days.push(compact);
    if (days.length > 366) break;
  }
  return days;
}

function dedupeFixtures(fixtures: readonly Fixture[]): Fixture[] {
  const seen = new Map<string, Fixture>();
  for (const fixture of fixtures) seen.set(fixture.id, fixture);
  return [...seen.values()].sort((left, right) => left.kickoff.localeCompare(right.kickoff));
}

function dedupeNotes(notes: readonly string[]): readonly string[] {
  return [...new Set(notes)];
}

