/**
 * `FixtureProvider` — the offline, deterministic implementation of `FootballDataProvider`.
 *
 * It answers every call from the recorded JSON in `packages/football-data/data/`, so the whole app runs with no
 * API key, no network and no live match in progress. Tests use it exclusively.
 *
 * Matchday games are exercised through the replay: configure `replay.fixtureId` and the live fixture's state comes
 * from `MatchReplay` at whatever minute the injected clock (or an explicit `advanceTo`) puts it at.
 */

import type { DataClock } from '../clock.js';
import { systemDataClock } from '../clock.js';
import { competitionConfigById } from '../competitions.js';
import type { DataSource } from '../data-source.js';
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
import type {
  FixtureQuery,
  FixturesByDateQuery,
  FootballDataProvider,
  ProviderKind,
  SeasonStatsQuery,
} from '../provider.js';
import { loadProfilesSequentially } from '../provider.js';
import type { DataResult } from '../result.js';
import { fail, ok } from '../result.js';
import type { RecordedDataset } from './dataset.js';
import { loadRecordedDataset, profileFor } from './dataset.js';
import type { MatchReplayStatus } from './replay.js';
import { MatchReplay } from './replay.js';

export interface FixtureReplayConfig {
  /** Which recorded fixture to replay. Must have a timeline file in the dataset index. */
  readonly fixtureId: FixtureId | string;
  /** Match minutes per real minute. Default 1. */
  readonly speedMultiplier?: number | undefined;
  /** Minute to sit at before starting. Default 0. */
  readonly startMinute?: number | undefined;
  /** Start the replay clock as soon as the dataset loads. Default true. */
  readonly autoStart?: boolean | undefined;
}

export interface FixtureProviderOptions {
  readonly dataSource: DataSource;
  readonly clock?: DataClock | undefined;
  readonly replay?: FixtureReplayConfig | undefined;
  /**
   * Simulated per-call latency in milliseconds, waited through the injected clock. Zero by default so tests are
   * instant; a few hundred ms makes the real loading screen observable in development.
   */
  readonly latencyMs?: number | undefined;
}

export class FixtureProvider implements FootballDataProvider {
  readonly kind: ProviderKind = 'fixture';

  private readonly source: DataSource;
  private readonly clock: DataClock;
  private readonly replayConfig: FixtureReplayConfig | null;
  private readonly latencyMs: number;

  private dataset: RecordedDataset | null = null;
  private loading: Promise<DataResult<RecordedDataset>> | null = null;
  private replay: MatchReplay | null = null;
  /** Set when `replay` was configured but could not be built — surfaced through every `ensureDataset()` result. */
  private replayConfigNotes: readonly string[] = [];

  constructor(options: FixtureProviderOptions) {
    this.source = options.dataSource;
    this.clock = options.clock ?? systemDataClock;
    this.replayConfig = options.replay ?? null;
    this.latencyMs = options.latencyMs ?? 0;
  }

  /** Force the dataset to load (and the replay to be constructed) before the first query. */
  async ready(): Promise<DataResult<RecordedDataset>> {
    return this.ensureDataset();
  }

  /** The replay for the configured fixture, or null when no replay is configured. */
  matchReplay(): MatchReplay | null {
    return this.replay;
  }

  replayStatus(): MatchReplayStatus | null {
    return this.replay === null ? null : this.replay.status();
  }

  /** Move the configured replay to an explicit match minute. Deterministic; no timers. */
  advanceReplayTo(minute: number): void {
    this.replay?.advanceTo(minute);
  }

  async listCompetitions(): Promise<DataResult<readonly Competition[]>> {
    const loaded = await this.ensureDataset();
    if (!loaded.ok) return loaded;
    return ok(loaded.value.competitions, loaded.notes);
  }

  async getFixturesByCompetition(
    competitionId: CompetitionId,
    query: FixtureQuery = {},
  ): Promise<DataResult<readonly Fixture[]>> {
    const loaded = await this.ensureDataset();
    if (!loaded.ok) return loaded;
    const config = competitionConfigById(competitionId);
    if (config === null) {
      return fail('BAD_REQUEST', `unsupported competition id: ${competitionId}`, { retryable: false });
    }
    const season = query.season ?? config.currentSeason;
    let fixtures: readonly Fixture[] = loaded.value.fixtures.filter(
      (fixture) => fixture.competitionId === competitionId && fixture.season === season,
    );
    fixtures = applyDateWindow(fixtures, query.from, query.to);
    fixtures = fixtures.map((fixture) => this.project(fixture));
    const limited = query.limit === undefined ? fixtures : fixtures.slice(0, Math.max(0, query.limit));
    const notes =
      limited.length === 0 ? [...loaded.notes, `No recorded fixtures for ${config.name} in ${season}.`] : loaded.notes;
    return ok(limited, notes);
  }

  async getFixturesByDate(query: FixturesByDateQuery): Promise<DataResult<readonly Fixture[]>> {
    const loaded = await this.ensureDataset();
    if (!loaded.ok) return loaded;
    const allowed =
      query.competitions === undefined
        ? null
        : new Set(
            query.competitions
              .map((code) => loaded.value.competitions.find((competition) => competition.code === code)?.id)
              .filter((id): id is CompetitionId => id !== undefined),
          );
    const fixtures = loaded.value.fixtures
      .filter((fixture) => fixture.kickoff.slice(0, 10) === query.date)
      .filter((fixture) => allowed === null || allowed.has(fixture.competitionId))
      .map((fixture) => this.project(fixture));
    const notes =
      fixtures.length === 0 ? [...loaded.notes, `No recorded fixtures kicking off on ${query.date}.`] : loaded.notes;
    return ok(fixtures, notes);
  }

  async getFixture(fixtureId: FixtureId): Promise<DataResult<Fixture | null>> {
    const loaded = await this.ensureDataset();
    if (!loaded.ok) return loaded;
    const fixture = loaded.value.fixturesById.get(fixtureId);
    if (fixture === undefined) {
      return ok(null, [...loaded.notes, `Fixture ${fixtureId} is not in the recorded dataset.`]);
    }
    return ok(this.project(fixture), loaded.notes);
  }

  async getLineups(fixtureId: FixtureId): Promise<DataResult<FixtureLineups | null>> {
    const loaded = await this.ensureDataset();
    if (!loaded.ok) return loaded;
    const lineups = loaded.value.lineupsByFixture.get(fixtureId) ?? null;
    if (lineups === null) return ok(null, [...loaded.notes, `No recorded lineups for fixture ${fixtureId}.`]);
    return ok(lineups, lineups.confirmed ? loaded.notes : [...loaded.notes, 'Recorded lineups are projected, not confirmed.']);
  }

  async getSquad(teamId: TeamId): Promise<DataResult<readonly Player[]>> {
    const loaded = await this.ensureDataset();
    if (!loaded.ok) return loaded;
    const squad = loaded.value.playersByTeam.get(teamId) ?? [];
    const notes = squad.length === 0 ? [...loaded.notes, `No recorded squad for team ${teamId}.`] : loaded.notes;
    return ok(squad, notes);
  }

  async getPlayerSeasonStats(query: SeasonStatsQuery): Promise<DataResult<readonly PlayerSeasonStats[]>> {
    const loaded = await this.ensureDataset();
    if (!loaded.ok) return loaded;
    const config = competitionConfigById(query.competitionId);
    if (config === null) {
      return fail('BAD_REQUEST', `unsupported competition id: ${query.competitionId}`, { retryable: false });
    }
    const season = query.season ?? config.currentSeason;
    let rows = loaded.value.seasonStats.filter(
      (row) => row.competitionId === query.competitionId && row.season === season,
    );
    if (query.teamId !== undefined) {
      const teamId = query.teamId;
      rows = rows.filter((row) => row.teamId === teamId);
    }
    const limited = query.limit === undefined ? rows : rows.slice(0, Math.max(0, query.limit));
    const notes =
      limited.length === 0
        ? [...loaded.notes, `No recorded season statistics for ${config.name} ${season}.`]
        : loaded.notes;
    return ok(limited, notes);
  }

  async getPlayerProfile(playerId: FootballPlayerId): Promise<DataResult<PlayerProfile | null>> {
    const loaded = await this.ensureDataset();
    if (!loaded.ok) return loaded;
    const profile = profileFor(loaded.value, playerId);
    if (profile === null) return ok(null, [...loaded.notes, `Player ${playerId} is not in the recorded dataset.`]);
    const notes =
      profile.career.length === 0
        ? [...loaded.notes, `No recorded career history for player ${playerId}.`]
        : loaded.notes;
    return ok(profile, notes);
  }

  getPlayerProfiles(playerIds: readonly FootballPlayerId[]): Promise<DataResult<readonly PlayerProfile[]>> {
    return loadProfilesSequentially(this, playerIds);
  }

  async getLiveMatchState(fixtureId: FixtureId): Promise<DataResult<LiveMatchState | null>> {
    const loaded = await this.ensureDataset();
    if (!loaded.ok) return loaded;
    if (this.replay !== null && this.replay.fixtureId === fixtureId) {
      const snapshot = this.replay.snapshot();
      return ok(snapshot, [
        ...loaded.notes,
        `Replayed from a recorded timeline (elapsed minute ${String(Math.floor(this.replay.currentMinute))}).`,
      ]);
    }
    const live = loaded.value.liveByFixture.get(fixtureId) ?? null;
    if (live === null) return ok(null, [...loaded.notes, `No recorded live state for fixture ${fixtureId}.`]);
    return ok(live, loaded.notes);
  }

  async getMatchEvents(fixtureId: FixtureId): Promise<DataResult<readonly MatchEvent[]>> {
    const live = await this.getLiveMatchState(fixtureId);
    if (!live.ok) return live;
    if (live.value === null) return ok([], live.notes);
    return ok(live.value.events, live.notes);
  }

  /** Swap the live fixture's recorded snapshot for the replay's view of it. */
  private project(fixture: Fixture): Fixture {
    if (this.replay === null) return fixture;
    if (this.replay.fixtureId !== fixture.id) return fixture;
    return this.replay.fixture();
  }

  /** Load once; concurrent callers share the same load (the coalescing the API provider gets from its cache). */
  private async ensureDataset(): Promise<DataResult<RecordedDataset>> {
    if (this.latencyMs > 0) await this.clock.sleep(this.latencyMs);
    if (this.dataset !== null) return ok(this.dataset, [...this.dataset.loadNotes, ...this.replayConfigNotes]);
    if (this.loading !== null) return this.loading;

    this.loading = (async (): Promise<DataResult<RecordedDataset>> => {
      const result = await loadRecordedDataset(this.source);
      if (result.ok) {
        this.dataset = result.value;
        this.replay = this.buildReplay(result.value);
        return ok(result.value, [...result.value.loadNotes, ...this.replayConfigNotes], result.fromCache);
      }
      return result;
    })();

    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  /**
   * Builds the configured replay, or records exactly why it could not be built. A typo'd `replay.fixtureId` is a
   * real, discoverable configuration mistake — silently falling back to a non-replaying provider (as if no
   * replay had been requested at all) would hide it, so it is surfaced as a note on every subsequent call
   * instead, naming the bad id and every fixture id that *does* have a replayable timeline.
   */
  private buildReplay(dataset: RecordedDataset): MatchReplay | null {
    if (this.replayConfig === null) return null;
    const fixtureId = String(this.replayConfig.fixtureId);
    const timeline = dataset.timelinesByFixture.get(fixtureId);
    const fixture = dataset.fixturesById.get(fixtureId);
    if (timeline !== undefined && fixture !== undefined) {
      this.replayConfigNotes = [];
      return new MatchReplay({
        timeline,
        fixture,
        clock: this.clock,
        speedMultiplier: this.replayConfig.speedMultiplier,
        startMinute: this.replayConfig.startMinute,
        autoStart: this.replayConfig.autoStart ?? true,
      });
    }

    const available = replayableFixtureIds(dataset);
    const reason = fixture === undefined ? 'is not a fixture in the recorded dataset' : 'has no recorded timeline';
    this.replayConfigNotes = [
      `Configured replay fixture "${fixtureId}" ${reason}; no replay is active. ` +
        (available.length > 0
          ? `Replayable fixture ids: ${available.join(', ')}.`
          : 'No fixture in the recorded dataset has a timeline.'),
    ];
    return null;
  }
}

function applyDateWindow(
  fixtures: readonly Fixture[],
  from: string | undefined,
  to: string | undefined,
): readonly Fixture[] {
  return fixtures.filter((fixture) => {
    const date = fixture.kickoff.slice(0, 10);
    if (from !== undefined && date < from) return false;
    if (to !== undefined && date > to) return false;
    return true;
  });
}

/** Which fixtures in the recorded dataset have a replayable timeline. */
export function replayableFixtureIds(dataset: RecordedDataset): readonly string[] {
  return [...dataset.timelinesByFixture.keys()];
}
