/**
 * `CompositeProvider` — routes each capability to the best configured source and merges the answers.
 *
 * The default live wiring is:
 *
 * | Capability                         | Source                                  |
 * |------------------------------------|-----------------------------------------|
 * | competitions                       | config map                              |
 * | fixtures by competition / date     | primary (ESPN) → fallback (API-Football) on failure |
 * | fixture, lineups, live state/events| whichever source issued the fixture id  |
 * | squads, bios, season stats         | whichever source issued the team id     |
 * | career history                     | career provider (Wikidata), merged into the bio |
 *
 * Ids are the reason routing is per-id rather than per-call: ESPN and API-Football number fixtures, teams and
 * players independently, so an id is only meaningful to the source that produced it. The composite remembers which
 * source issued every id it has passed through; an id it has never seen goes to the primary first and to the
 * fallback only if the primary fails.
 *
 * Every successful result carries provenance notes (`source: espn`, `careers: wikidata`), so a `DataQuality`
 * report can say where each piece came from.
 */

import type { CareerLookupResult, CareerProvider } from './wikidata/wikidata-career-provider.js';
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
} from './domain.js';
import type {
  FixtureQuery,
  FixturesByDateQuery,
  FootballDataProvider,
  ProviderKind,
  SeasonStatsQuery,
} from './provider.js';
import type { DataResult } from './result.js';
import { ok, withNotes } from './result.js';
import { createTeamNameResolver } from './team-names.js';

export interface CompositeProviderConfig {
  /** Serves everything it can. In the live wiring this is `EspnProvider`. */
  readonly primary: FootballDataProvider;
  /** Used only when the primary fails, or for ids the fallback itself issued. Optional (`ApiFootballProvider`). */
  readonly fallback?: FootballDataProvider | undefined;
  /** Fills `PlayerProfile.career` when the bio source has none. Optional (`WikidataCareerProvider`). */
  readonly careers?: CareerProvider | undefined;
}

type IdKind = 'fixture' | 'team' | 'player';

export class CompositeProvider implements FootballDataProvider {
  readonly kind: ProviderKind = 'composite';

  private readonly primary: FootballDataProvider;
  private readonly fallback: FootballDataProvider | null;
  private readonly careers: CareerProvider | null;
  private readonly owners = new Map<string, FootballDataProvider>();
  private readonly careerOutcomes = new Map<string, CareerLookupResult>();
  private readonly teamNames = createTeamNameResolver();

  constructor(config: CompositeProviderConfig) {
    this.primary = config.primary;
    this.fallback = config.fallback ?? null;
    this.careers = config.careers ?? null;
  }

  /** Human-readable wiring, for logs and the health endpoint. */
  describeSources(): { primary: ProviderKind; fallback: ProviderKind | null; careers: string | null } {
    return {
      primary: this.primary.kind,
      fallback: this.fallback?.kind ?? null,
      careers: this.careers?.source ?? null,
    };
  }

  /** The most recent career lookup outcome for a player (matched / ambiguous / no-match), if any. */
  careerOutcome(playerId: FootballPlayerId): CareerLookupResult | null {
    return this.careerOutcomes.get(playerId) ?? null;
  }

  listCompetitions(): Promise<DataResult<readonly Competition[]>> {
    return this.withFallback((source) => source.listCompetitions(), () => undefined);
  }

  getFixturesByCompetition(
    competitionId: CompetitionId,
    query?: FixtureQuery,
  ): Promise<DataResult<readonly Fixture[]>> {
    return this.withFallback(
      (source) => source.getFixturesByCompetition(competitionId, query),
      (fixtures, source) => this.rememberFixtures(fixtures, source),
    );
  }

  getFixturesByDate(query: FixturesByDateQuery): Promise<DataResult<readonly Fixture[]>> {
    return this.withFallback(
      (source) => source.getFixturesByDate(query),
      (fixtures, source) => this.rememberFixtures(fixtures, source),
    );
  }

  getFixture(fixtureId: FixtureId): Promise<DataResult<Fixture | null>> {
    return this.byId('fixture', fixtureId, (source) => source.getFixture(fixtureId), (fixture, source) => {
      if (fixture !== null) this.rememberFixtures([fixture], source);
    });
  }

  getLineups(fixtureId: FixtureId): Promise<DataResult<FixtureLineups | null>> {
    return this.byId('fixture', fixtureId, (source) => source.getLineups(fixtureId), (lineups, source) => {
      if (lineups === null) return;
      for (const side of [lineups.home, lineups.away]) {
        this.remember('team', side.teamId, source);
        for (const entry of [...side.startingXI, ...side.substitutes]) this.remember('player', entry.playerId, source);
      }
    });
  }

  getLiveMatchState(fixtureId: FixtureId): Promise<DataResult<LiveMatchState | null>> {
    return this.byId('fixture', fixtureId, (source) => source.getLiveMatchState(fixtureId), (live, source) => {
      if (live !== null) this.rememberFixtures([live.fixture], source);
    });
  }

  getMatchEvents(fixtureId: FixtureId): Promise<DataResult<readonly MatchEvent[]>> {
    return this.byId('fixture', fixtureId, (source) => source.getMatchEvents(fixtureId), () => undefined);
  }

  getSquad(teamId: TeamId): Promise<DataResult<readonly Player[]>> {
    return this.byId('team', teamId, (source) => source.getSquad(teamId), (players, source) => {
      for (const player of players) this.remember('player', player.id, source);
    });
  }

  getPlayerSeasonStats(query: SeasonStatsQuery): Promise<DataResult<readonly PlayerSeasonStats[]>> {
    const remember = (rows: readonly PlayerSeasonStats[], source: FootballDataProvider): void => {
      for (const row of rows) {
        this.remember('player', row.playerId, source);
        this.remember('team', row.teamId, source);
      }
    };
    if (query.teamId !== undefined) {
      return this.byId('team', query.teamId, (source) => source.getPlayerSeasonStats(query), remember);
    }
    return this.withFallback((source) => source.getPlayerSeasonStats(query), remember);
  }

  async getPlayerProfile(playerId: FootballPlayerId): Promise<DataResult<PlayerProfile | null>> {
    const result = await this.getPlayerProfiles([playerId]);
    if (!result.ok) return result;
    return ok(result.value[0] ?? null, result.notes, result.fromCache);
  }

  async getPlayerProfiles(playerIds: readonly FootballPlayerId[]): Promise<DataResult<readonly PlayerProfile[]>> {
    // Bios come from whichever source issued each player id; group so each source answers one batch.
    const groups = new Map<FootballDataProvider, FootballPlayerId[]>();
    for (const playerId of [...new Set(playerIds)]) {
      const owner = this.owners.get(`player:${playerId}`) ?? this.primary;
      groups.set(owner, [...(groups.get(owner) ?? []), playerId]);
    }

    const profiles: PlayerProfile[] = [];
    const notes: string[] = [];
    let lastFailure: DataResult<readonly PlayerProfile[]> | null = null;
    for (const [source, ids] of groups) {
      let result = await source.getPlayerProfiles(ids);
      let answeredBy = source;
      if (!result.ok && this.fallback !== null && source !== this.fallback && !this.anyOwned('player', ids)) {
        result = await this.fallback.getPlayerProfiles(ids);
        answeredBy = this.fallback;
      }
      if (!result.ok) {
        lastFailure = result;
        notes.push(`Bios from ${source.kind} unavailable: ${result.error.message}`);
        continue;
      }
      for (const profile of result.value) this.remember('player', profile.player.id, answeredBy);
      profiles.push(...result.value);
      notes.push(...result.notes, `bios: ${answeredBy.kind}`);
    }
    if (profiles.length === 0 && lastFailure !== null) return lastFailure;

    const enriched = await this.enrichCareers(profiles);
    return ok(enriched.profiles, dedupe([...notes, ...enriched.notes]));
  }

  // ---- routing ------------------------------------------------------------

  private remember(kind: IdKind, id: string, source: FootballDataProvider): void {
    const key = `${kind}:${id}`;
    if (!this.owners.has(key)) this.owners.set(key, source);
  }

  private anyOwned(kind: IdKind, ids: readonly string[]): boolean {
    return ids.some((id) => this.owners.has(`${kind}:${id}`));
  }

  private rememberFixtures(fixtures: readonly Fixture[], source: FootballDataProvider): void {
    for (const fixture of fixtures) {
      this.remember('fixture', fixture.id, source);
      this.teamNames.add(fixture.homeTeam);
      this.teamNames.add(fixture.awayTeam);
      this.remember('team', fixture.homeTeam.id, source);
      this.remember('team', fixture.awayTeam.id, source);
    }
  }

  /** For id-free queries: primary first, fallback only when the primary fails. */
  private async withFallback<T>(
    call: (source: FootballDataProvider) => Promise<DataResult<T>>,
    onSuccess: (value: T, source: FootballDataProvider) => void,
  ): Promise<DataResult<T>> {
    const primary = await call(this.primary);
    if (primary.ok) {
      onSuccess(primary.value, this.primary);
      return withNotes(primary, [`source: ${this.primary.kind}`]);
    }
    if (this.fallback === null) return primary;
    const fallback = await call(this.fallback);
    if (!fallback.ok) return primary;
    onSuccess(fallback.value, this.fallback);
    return withNotes(fallback, [
      `source: ${this.fallback.kind} (fallback; ${this.primary.kind} failed: ${primary.error.message})`,
    ]);
  }

  /** For id-based queries: the source that issued the id; an unseen id tries primary, then fallback. */
  private async byId<T>(
    kind: IdKind,
    id: string,
    call: (source: FootballDataProvider) => Promise<DataResult<T>>,
    onSuccess: (value: T, source: FootballDataProvider) => void,
  ): Promise<DataResult<T>> {
    const owner = this.owners.get(`${kind}:${id}`);
    if (owner !== undefined) {
      const result = await call(owner);
      if (result.ok) onSuccess(result.value, owner);
      return result.ok ? withNotes(result, [`source: ${owner.kind}`]) : result;
    }
    return this.withFallback(call, onSuccess);
  }

  // ---- career enrichment ----------------------------------------------------

  private async enrichCareers(
    profiles: readonly PlayerProfile[],
  ): Promise<{ profiles: readonly PlayerProfile[]; notes: readonly string[] }> {
    if (this.careers === null) {
      const missing = profiles.filter((profile) => profile.career.length === 0).length;
      return {
        profiles,
        notes: missing > 0 ? [`No career source configured; ${String(missing)} profiles have no career history.`] : [],
      };
    }
    const needCareer = profiles.filter((profile) => profile.career.length === 0);
    if (needCareer.length === 0) return { profiles, notes: [] };

    const lookups = needCareer.map((profile) => ({
      playerId: profile.player.id,
      name: profile.player.name,
      fullName: profile.player.fullName,
      dateOfBirth: profile.player.dateOfBirth,
    }));
    const result = await this.careers.getCareers(lookups);
    if (!result.ok) {
      return {
        profiles,
        notes: [`Career history unavailable from ${this.careers.source}: ${result.error.message}`],
      };
    }

    const byPlayer = new Map(result.value.map((entry) => [entry.playerId as string, entry]));
    for (const entry of result.value) this.careerOutcomes.set(entry.playerId, entry);
    const merged = profiles.map((profile) => {
      if (profile.career.length > 0) return profile;
      const entry = byPlayer.get(profile.player.id);
      if (entry === undefined || entry.career.length === 0) return profile;
      // Link career clubs to teams this provider has served, where the names match unambiguously.
      const career = entry.career.map((step) =>
        step.teamId !== null ? step : { ...step, teamId: this.teamNames.resolve(step.teamName) },
      );
      return { ...profile, career };
    });
    const withCareer = merged.filter((profile) => profile.career.length > 0).length;
    const unresolved = result.value.filter((entry) => entry.status !== 'matched').flatMap((entry) => entry.notes);
    return {
      profiles: merged,
      notes: [
        `careers: ${this.careers.source} (${String(withCareer)} of ${String(merged.length)} profiles have a career)`,
        ...result.notes,
        ...unresolved,
      ],
    };
  }
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
