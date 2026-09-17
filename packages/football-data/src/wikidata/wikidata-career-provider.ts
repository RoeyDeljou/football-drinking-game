/**
 * `WikidataCareerProvider` — career history (club + seasons) from the Wikidata Query Service. Free, no key.
 *
 * Not a full `FootballDataProvider`: Wikidata knows careers, not fixtures. `CompositeProvider` uses it to enrich
 * the player profiles and general dataset built from ESPN, which is what `G1` Guess the Player, `G3` Career Path
 * and `G8` Teammate Chain need.
 *
 * Budget and manners — the query service is a shared public resource:
 * - A descriptive User-Agent with a contact URL on every request (required by Wikimedia policy).
 * - Batching: a whole squad costs one candidate query per `batchSize` birth dates plus one career query per
 *   `batchSize` matched players.
 * - A local limiter (one request at a time, at most one per two seconds) **and** a hard hourly query budget.
 *   When the budget is spent, lookups return `RATE_LIMITED` instead of queueing indefinitely.
 * - Long TTLs: a player→entity match and a career are cached for a week, including "no match" outcomes, so a
 *   player who is not on Wikidata costs one query per week rather than one per session.
 */

import type { DataClock } from '../clock.js';
import { systemDataClock } from '../clock.js';
import { ResourceCache } from '../cache.js';
import type { CareerEntry, FootballPlayerId, TeamId } from '../domain.js';
import type { HttpClient, RetryConfig } from '../http.js';
import { createFetchHttpClient, DEFAULT_RETRY, DEFAULT_TIMEOUT_MS } from '../http.js';
import type { RateLimitConfig } from '../rate-limiter.js';
import type { DataResult } from '../result.js';
import { fail, ok } from '../result.js';
import { UpstreamClient } from '../upstream.js';
import type { CareerMatchStatus } from './normalize.js';
import { matchCandidate, parseCandidates, parseCareers } from './normalize.js';
import type { SparqlResults } from './sparql.js';
import { candidatesByBirthDateQuery, careersQuery, isIsoDate, sparqlResultsSchema } from './sparql.js';

export const WIKIDATA_SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';

export const WIKIDATA_DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 1,
  windowMs: 2_000,
  maxConcurrent: 1,
  maxQueueDepth: 50,
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** The contract `CompositeProvider` depends on, so a hub can swap in its own career source. */
export interface CareerLookup {
  readonly playerId: FootballPlayerId;
  readonly name: string;
  readonly fullName?: string | null | undefined;
  /** ISO date `YYYY-MM-DD`. Without it there is no lookup — name alone is never enough. */
  readonly dateOfBirth: string | null;
}

export interface CareerLookupResult {
  readonly playerId: FootballPlayerId;
  readonly status: CareerMatchStatus;
  readonly wikidataId: string | null;
  /** Club career only, chronological. Empty unless `status` is `matched`. */
  readonly career: readonly CareerEntry[];
  /** Label of the senior national team, when Wikidata records one. Youth teams are not reported. */
  readonly seniorNationalTeam: string | null;
  readonly notes: readonly string[];
}

export interface CareerProvider {
  readonly source: string;
  getCareers(players: readonly CareerLookup[]): Promise<DataResult<readonly CareerLookupResult[]>>;
}

export interface WikidataCareerProviderConfig {
  readonly userAgent: string;
  readonly endpoint?: string | undefined;
  /** Birth dates / entities per query. Default 10. */
  readonly batchSize?: number | undefined;
  /** Hard ceiling on SPARQL requests per rolling hour. Default 30. */
  readonly maxQueriesPerHour?: number | undefined;
  readonly cacheTtlMs?: number | undefined;
  readonly rateLimit?: Partial<RateLimitConfig> | undefined;
  readonly retry?: Partial<RetryConfig> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly http?: HttpClient | undefined;
  readonly clock?: DataClock | undefined;
  /** Map a Wikidata club label to a known team id (e.g. ESPN's), so careers link to real teams where possible. */
  readonly resolveTeamId?: ((teamName: string) => TeamId | null) | undefined;
}

interface CachedMatch {
  readonly status: CareerMatchStatus;
  readonly entityId: string | null;
  readonly note: string;
}

interface CachedCareer {
  readonly career: readonly CareerEntry[];
  readonly seniorNationalTeam: string | null;
}

export class WikidataCareerProvider implements CareerProvider {
  readonly source = 'wikidata';

  private readonly endpoint: string;
  private readonly batchSize: number;
  private readonly maxQueriesPerHour: number;
  private readonly ttlMs: number;
  private readonly clock: DataClock;
  private readonly client: UpstreamClient;
  private readonly cache: ResourceCache;
  private readonly resolveTeamId: (teamName: string) => TeamId | null;
  private queryTimestamps: number[] = [];

  constructor(config: WikidataCareerProviderConfig) {
    this.endpoint = config.endpoint ?? WIKIDATA_SPARQL_ENDPOINT;
    this.batchSize = Math.max(1, Math.min(25, config.batchSize ?? 10));
    this.maxQueriesPerHour = Math.max(1, config.maxQueriesPerHour ?? 30);
    this.ttlMs = config.cacheTtlMs ?? WEEK_MS;
    this.clock = config.clock ?? systemDataClock;
    this.cache = new ResourceCache({ clock: this.clock, maxEntries: 20_000 });
    this.resolveTeamId = config.resolveTeamId ?? (() => null);
    this.client = new UpstreamClient({
      name: 'Wikidata',
      http: config.http ?? createFetchHttpClient(),
      clock: this.clock,
      retry: { ...DEFAULT_RETRY, ...config.retry },
      rateLimit: { ...WIKIDATA_DEFAULT_RATE_LIMIT, ...config.rateLimit },
      // SPARQL can be slow; the service itself times out at 60s.
      timeoutMs: config.timeoutMs ?? Math.max(DEFAULT_TIMEOUT_MS, 60_000),
      headers: { 'user-agent': config.userAgent, accept: 'application/sparql-results+json' },
    });
  }

  /** Queries spent in the current rolling hour, for telemetry and tests. */
  get queriesThisHour(): number {
    this.pruneBudget();
    return this.queryTimestamps.length;
  }

  async getCareers(players: readonly CareerLookup[]): Promise<DataResult<readonly CareerLookupResult[]>> {
    const notes: string[] = [];

    // ---- 1. Resolve player → entity, from cache where possible ------------
    const matches = new Map<string, CachedMatch>();
    const unmatched: CareerLookup[] = [];
    for (const player of players) {
      const dob = player.dateOfBirth === null ? null : player.dateOfBirth.slice(0, 10);
      if (dob === null || !isIsoDate(dob)) {
        matches.set(player.playerId, {
          status: 'no-date-of-birth',
          entityId: null,
          note: `${player.name}: no date of birth, so no Wikidata lookup.`,
        });
        continue;
      }
      const cached = this.cache.peek<CachedMatch>(`match:${player.playerId}`);
      if (cached !== null) matches.set(player.playerId, cached.value);
      else unmatched.push(player);
    }

    const dates = [...new Set(unmatched.map((player) => (player.dateOfBirth ?? '').slice(0, 10)))];
    for (let index = 0; index < dates.length; index += this.batchSize) {
      const batch = dates.slice(index, index + this.batchSize);
      const result = await this.query(candidatesByBirthDateQuery(batch));
      if (!result.ok) {
        if (matches.size === 0 && index === 0) return result;
        notes.push(`Wikidata candidate lookup stopped early: ${result.error.message}`);
        break;
      }
      const candidates = parseCandidates(result.value);
      for (const player of unmatched) {
        const dob = (player.dateOfBirth ?? '').slice(0, 10);
        if (!batch.includes(dob)) continue;
        const names = [player.name, player.fullName ?? ''].filter((name) => name.length > 0);
        const outcome = matchCandidate(names, dob, candidates);
        matches.set(player.playerId, outcome);
        this.cache.set(`match:${player.playerId}`, outcome, this.ttlMs);
      }
    }

    // ---- 2. Careers for matched entities, from cache where possible -------
    const careers = new Map<string, CachedCareer>();
    const entitiesToFetch: string[] = [];
    for (const match of matches.values()) {
      if (match.entityId === null) continue;
      const cached = this.cache.peek<CachedCareer>(`career:${match.entityId}`);
      if (cached !== null) careers.set(match.entityId, cached.value);
      else if (!entitiesToFetch.includes(match.entityId)) entitiesToFetch.push(match.entityId);
    }

    for (let index = 0; index < entitiesToFetch.length; index += this.batchSize) {
      const batch = entitiesToFetch.slice(index, index + this.batchSize);
      const result = await this.query(careersQuery(batch));
      if (!result.ok) {
        notes.push(`Wikidata career lookup stopped early: ${result.error.message}`);
        break;
      }
      const parsed = parseCareers(result.value, this.resolveTeamId);
      for (const entityId of batch) {
        const entry = parsed.get(entityId);
        const value: CachedCareer = {
          career: entry?.career ?? [],
          seniorNationalTeam: entry?.seniorNationalTeam ?? null,
        };
        careers.set(entityId, value);
        this.cache.set(`career:${entityId}`, value, this.ttlMs);
      }
    }

    // ---- 3. Assemble --------------------------------------------------------
    const results: CareerLookupResult[] = players.map((player) => {
      const match = matches.get(player.playerId);
      if (match === undefined) {
        return {
          playerId: player.playerId,
          status: 'no-match',
          wikidataId: null,
          career: [],
          seniorNationalTeam: null,
          notes: [`${player.name}: Wikidata lookup did not run (query budget or upstream failure).`],
        };
      }
      const career = match.entityId === null ? undefined : careers.get(match.entityId);
      const entryNotes = [match.note];
      if (match.entityId !== null && career === undefined) {
        entryNotes.push(`${player.name}: career for ${match.entityId} could not be loaded this time.`);
      } else if (career !== undefined && career.career.length === 0) {
        entryNotes.push(`${player.name}: Wikidata has no club career statements for ${match.entityId ?? ''}.`);
      }
      return {
        playerId: player.playerId,
        status: match.status,
        wikidataId: match.entityId,
        career: career?.career ?? [],
        seniorNationalTeam: career?.seniorNationalTeam ?? null,
        notes: entryNotes,
      };
    });

    const matched = results.filter((entry) => entry.status === 'matched').length;
    notes.push(`Wikidata: matched ${String(matched)} of ${String(players.length)} players by name and birth date.`);
    return ok(results, notes);
  }

  private pruneBudget(): void {
    const cutoff = this.clock.now() - HOUR_MS;
    this.queryTimestamps = this.queryTimestamps.filter((at) => at > cutoff);
  }

  private async query(sparql: string): Promise<DataResult<SparqlResults>> {
    this.pruneBudget();
    if (this.queryTimestamps.length >= this.maxQueriesPerHour) {
      return fail(
        'RATE_LIMITED',
        `Wikidata query budget spent (${String(this.maxQueriesPerHour)} queries/hour); try again later`,
        { retryable: true, attempts: 0 },
      );
    }
    this.queryTimestamps.push(this.clock.now());
    const url = `${this.endpoint}?format=json&query=${encodeURIComponent(sparql)}`;
    // Batches are cached per player above, so the raw query result itself is not cached (TTL 0).
    return this.client.getJson(`sparql:${String(this.clock.now())}:${sparql.length}`, url, 0, sparqlResultsSchema);
  }
}
