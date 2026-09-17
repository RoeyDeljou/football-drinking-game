/**
 * The one interface every consumer talks to.
 *
 * `apps/api`, `MatchdayPrefetcher` and the `GeneralDataset` builder depend on `FootballDataProvider` and the
 * normalized domain types only. No consumer ever sees an API-Football shape, a Zod schema, a cache or an HTTP
 * status — those live behind the two implementations (`ApiFootballProvider`, `FixtureProvider`).
 *
 * Every method returns a `DataResult`, so "the upstream is down" and "this fixture has no lineups yet" are both
 * ordinary values rather than exceptions.
 */

import type {
  Competition,
  CompetitionCode,
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
  SeasonId,
  TeamId,
} from './domain.js';
import type { DataResult } from './result.js';

export type ProviderKind = 'espn' | 'api-football' | 'fixture' | 'composite';

export interface FixtureQuery {
  /** Defaults to the competition's configured current season. */
  readonly season?: SeasonId | undefined;
  /** Inclusive ISO date (`YYYY-MM-DD`). */
  readonly from?: string | undefined;
  /** Inclusive ISO date (`YYYY-MM-DD`). */
  readonly to?: string | undefined;
  /** Cap the number of fixtures returned, applied after sorting by kickoff. */
  readonly limit?: number | undefined;
}

export interface FixturesByDateQuery {
  /** ISO date (`YYYY-MM-DD`). */
  readonly date: string;
  /** Restrict to a subset of the six supported competitions. Defaults to all of them. */
  readonly competitions?: readonly CompetitionCode[] | undefined;
}

export interface SeasonStatsQuery {
  readonly competitionId: CompetitionId;
  readonly season?: SeasonId | undefined;
  /** Narrow to one team, which is what the matchday prefetch does. */
  readonly teamId?: TeamId | undefined;
  /** Cap the rows returned; providers page upstream requests to satisfy it. */
  readonly limit?: number | undefined;
}

export interface FootballDataProvider {
  readonly kind: ProviderKind;

  /** The six supported competitions, from the config map. */
  listCompetitions(): Promise<DataResult<readonly Competition[]>>;

  /** Fixtures for one competition, optionally windowed by date. Sorted by kickoff ascending. */
  getFixturesByCompetition(
    competitionId: CompetitionId,
    query?: FixtureQuery,
  ): Promise<DataResult<readonly Fixture[]>>;

  /** Everything kicking off on one calendar date across the supported competitions. */
  getFixturesByDate(query: FixturesByDateQuery): Promise<DataResult<readonly Fixture[]>>;

  /** One fixture. `null` when the id is unknown rather than an error. */
  getFixture(fixtureId: FixtureId): Promise<DataResult<Fixture | null>>;

  /** Confirmed or projected lineups. `null` before the teams are published. */
  getLineups(fixtureId: FixtureId): Promise<DataResult<FixtureLineups | null>>;

  /** Full squad for a team. Empty when the provider has no squad data. */
  getSquad(teamId: TeamId): Promise<DataResult<readonly Player[]>>;

  /** Season statistics rows for a competition, optionally narrowed to one team. */
  getPlayerSeasonStats(query: SeasonStatsQuery): Promise<DataResult<readonly PlayerSeasonStats[]>>;

  /** Player bio plus career history. `null` when the player is unknown. */
  getPlayerProfile(playerId: FootballPlayerId): Promise<DataResult<PlayerProfile | null>>;

  /**
   * Many profiles at once. Unknown players are omitted (and noted) rather than failing the batch. Providers with an
   * expensive per-player source — Wikidata careers — batch the upstream work here, so prefer it over looping.
   */
  getPlayerProfiles(playerIds: readonly FootballPlayerId[]): Promise<DataResult<readonly PlayerProfile[]>>;

  /** Live snapshot: fixture, events so far, team and per-player match stats. `null` for an unknown fixture. */
  getLiveMatchState(fixtureId: FixtureId): Promise<DataResult<LiveMatchState | null>>;

  /** Just the event feed, which is what the live ingestion loop polls. Ordered by minute ascending. */
  getMatchEvents(fixtureId: FixtureId): Promise<DataResult<readonly MatchEvent[]>>;
}

/**
 * Recommended polling intervals in milliseconds. These are the documented live-poll budgets: at 15s a 90-minute
 * match costs ~360 event calls, which is why the TTL cache uses the same number and coalesces concurrent polls.
 */
export interface PollIntervalConfig {
  /** Event feed during a live match. */
  readonly liveEventsMs: number;
  /** Team/player match statistics during a live match — these move slower than events. */
  readonly liveStatsMs: number;
  /** Lineup polling in the hour before kickoff, waiting for confirmation. */
  readonly prekickoffLineupsMs: number;
  /** Fixture list refresh while a lobby is open. */
  readonly fixtureListMs: number;
}

/**
 * The straightforward `getPlayerProfiles` for providers with no batch endpoint: one profile at a time, unknown and
 * failed players noted and skipped. A batch only fails when every single lookup failed.
 */
export async function loadProfilesSequentially(
  provider: Pick<FootballDataProvider, 'getPlayerProfile'>,
  playerIds: readonly FootballPlayerId[],
): Promise<DataResult<readonly PlayerProfile[]>> {
  const profiles: PlayerProfile[] = [];
  const notes: string[] = [];
  let lastFailure: DataResult<readonly PlayerProfile[]> | null = null;
  let failures = 0;
  for (const playerId of [...new Set(playerIds)]) {
    const result = await provider.getPlayerProfile(playerId);
    if (!result.ok) {
      failures += 1;
      lastFailure = result;
      notes.push(`Profile for player ${playerId} unavailable: ${result.error.message}`);
      continue;
    }
    notes.push(...result.notes);
    if (result.value === null) notes.push(`No profile found for player ${playerId}.`);
    else profiles.push(result.value);
  }
  if (profiles.length === 0 && lastFailure !== null && failures === new Set(playerIds).size) return lastFailure;
  return { ok: true, value: profiles, notes: [...new Set(notes)], fromCache: false };
}

export const DEFAULT_POLL_INTERVALS: PollIntervalConfig = {
  liveEventsMs: 15_000,
  liveStatsMs: 30_000,
  prekickoffLineupsMs: 60_000,
  fixtureListMs: 600_000,
};
