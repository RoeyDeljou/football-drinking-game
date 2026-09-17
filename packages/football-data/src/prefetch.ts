/**
 * `MatchdayPrefetcher` — the loading screen's engine.
 *
 * Four ordered steps, `fixture → lineups → squads → stats`, each reported as it starts and finishes so
 * `apps/web` can render real progress rather than a fake spinner. The order is a genuine dependency chain:
 * the fixture names the two teams, the lineups name the players, the squads fill in bios, the stats need both.
 *
 * Failure policy: only the first step is fatal (with no fixture there is nothing to play). Every later failure
 * marks its step `failed`, adds a `DataQuality` note and lets the bundle through partially filled — the engine
 * then disables the games that needed the missing piece instead of the whole session collapsing.
 */

import { assessFixtureDataQuality, evaluateGameAvailability } from './data-quality.js';
import type { GameAvailability } from './data-quality.js';
import type {
  DataQuality,
  Fixture,
  FixtureId,
  FixtureLineups,
  LiveMatchState,
  Player,
  PlayerProfile,
  PlayerSeasonStats,
  TeamId,
} from './domain.js';
import type { FootballDataProvider } from './provider.js';
import type { DataError, DataResult } from './result.js';
import { fail, ok } from './result.js';

export type PrefetchStepId = 'fixture' | 'lineups' | 'squads' | 'stats';

/** Canonical step order. Tests assert progress arrives in exactly this sequence. */
export const PREFETCH_STEP_ORDER: readonly PrefetchStepId[] = ['fixture', 'lineups', 'squads', 'stats'];

export const PREFETCH_STEP_LABELS: Readonly<Record<PrefetchStepId, string>> = {
  fixture: 'Loading the fixture',
  lineups: 'Fetching confirmed lineups',
  squads: 'Loading both squads',
  stats: 'Pulling season and live stats',
};

export type PrefetchStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface PrefetchStep {
  readonly id: PrefetchStepId;
  readonly label: string;
  readonly status: PrefetchStepStatus;
  /** Notes for this step only — e.g. "lineups are projected, not confirmed". */
  readonly notes: readonly string[];
  readonly error: DataError | null;
}

export interface MatchdayPrefetchProgress {
  readonly steps: readonly PrefetchStep[];
  readonly completedSteps: number;
  readonly totalSteps: number;
  /** 0–1, for a progress bar. */
  readonly ratio: number;
  readonly status: 'idle' | 'running' | 'complete' | 'failed';
  /** The step currently running, or null. */
  readonly currentStep: PrefetchStepId | null;
}

export interface TeamSquad {
  readonly teamId: TeamId;
  readonly players: readonly Player[];
}

/** Everything the matchday games need, fetched once before the session starts. */
export interface MatchdayBundle {
  readonly fixture: Fixture;
  readonly lineups: FixtureLineups | null;
  readonly squads: readonly TeamSquad[];
  readonly seasonStats: readonly PlayerSeasonStats[];
  readonly profiles: readonly PlayerProfile[];
  readonly live: LiveMatchState | null;
  readonly quality: DataQuality;
  /** Per-game availability derived from `quality`, ready for the host's game picker. */
  readonly gameAvailability: readonly GameAvailability[];
}

export interface MatchdayPrefetchOptions {
  /** Called after every status transition, with an immutable snapshot. */
  readonly onProgress?: ((progress: MatchdayPrefetchProgress) => void) | undefined;
  /** How many lineup players to resolve full profiles (and therefore career history) for. Default 8. */
  readonly profileCount?: number | undefined;
  /** Cap on season-stat rows fetched per team. Default 40. */
  readonly seasonStatsLimit?: number | undefined;
}

export class MatchdayPrefetcher {
  private readonly provider: FootballDataProvider;
  private readonly options: MatchdayPrefetchOptions;
  private steps: PrefetchStep[];
  private running = false;
  private finished = false;
  private failed = false;

  constructor(provider: FootballDataProvider, options: MatchdayPrefetchOptions = {}) {
    this.provider = provider;
    this.options = options;
    this.steps = PREFETCH_STEP_ORDER.map((id) => ({
      id,
      label: PREFETCH_STEP_LABELS[id],
      status: 'pending',
      notes: [],
      error: null,
    }));
  }

  progress(): MatchdayPrefetchProgress {
    const steps = this.steps.map((step) => ({ ...step, notes: [...step.notes] }));
    const completedSteps = steps.filter(
      (step) => step.status === 'done' || step.status === 'failed' || step.status === 'skipped',
    ).length;
    const status: MatchdayPrefetchProgress['status'] = this.failed
      ? 'failed'
      : this.finished
        ? 'complete'
        : this.running
          ? 'running'
          : 'idle';
    return {
      steps,
      completedSteps,
      totalSteps: steps.length,
      ratio: steps.length === 0 ? 1 : completedSteps / steps.length,
      status,
      currentStep: steps.find((step) => step.status === 'running')?.id ?? null,
    };
  }

  /** Run the four steps in order. Resolves with the bundle, or a failure if the fixture itself is unavailable. */
  async run(fixtureId: FixtureId): Promise<DataResult<MatchdayBundle>> {
    this.reset();
    this.running = true;
    this.emit();

    // ---- Step 1: fixture (fatal on failure) -------------------------------
    this.mark('fixture', 'running');
    const fixtureResult = await this.provider.getFixture(fixtureId);
    if (!fixtureResult.ok) {
      this.mark('fixture', 'failed', [], fixtureResult.error);
      this.skipFrom('lineups');
      this.failed = true;
      this.running = false;
      this.emit();
      return fixtureResult;
    }
    const fixture = fixtureResult.value;
    if (fixture === null) {
      const error = fail('BAD_REQUEST', `fixture ${fixtureId} does not exist`, { retryable: false });
      this.mark('fixture', 'failed', fixtureResult.notes, error.error);
      this.skipFrom('lineups');
      this.failed = true;
      this.running = false;
      this.emit();
      return error;
    }
    this.mark('fixture', 'done', fixtureResult.notes);

    // ---- Step 2: lineups (non-fatal) -------------------------------------
    this.mark('lineups', 'running');
    let lineups: FixtureLineups | null = null;
    const lineupResult = await this.provider.getLineups(fixture.id);
    if (lineupResult.ok) {
      lineups = lineupResult.value;
      this.mark('lineups', 'done', lineupResult.notes);
    } else {
      this.mark('lineups', 'failed', [`Lineups unavailable: ${lineupResult.error.message}`], lineupResult.error);
    }

    // ---- Step 3: squads for both teams (non-fatal) -----------------------
    this.mark('squads', 'running');
    const squads: TeamSquad[] = [];
    const squadNotes: string[] = [];
    let squadError: DataError | null = null;
    for (const teamId of [fixture.homeTeam.id, fixture.awayTeam.id]) {
      const squadResult = await this.provider.getSquad(teamId);
      if (squadResult.ok) {
        squads.push({ teamId, players: squadResult.value });
        squadNotes.push(...squadResult.notes);
      } else {
        squadError = squadResult.error;
        squadNotes.push(`Squad for team ${teamId} unavailable: ${squadResult.error.message}`);
      }
    }
    this.mark('squads', squads.length === 0 ? 'failed' : 'done', squadNotes, squads.length === 0 ? squadError : null);

    // ---- Step 4: season stats, live state and player profiles (non-fatal) -
    this.mark('stats', 'running');
    const statsNotes: string[] = [];
    const seasonStats: PlayerSeasonStats[] = [];
    const limit = this.options.seasonStatsLimit ?? 40;
    for (const teamId of [fixture.homeTeam.id, fixture.awayTeam.id]) {
      const statsResult = await this.provider.getPlayerSeasonStats({
        competitionId: fixture.competitionId,
        season: fixture.season,
        teamId,
        limit,
      });
      if (statsResult.ok) {
        seasonStats.push(...statsResult.value);
        statsNotes.push(...statsResult.notes);
      } else {
        statsNotes.push(`Season stats for team ${teamId} unavailable: ${statsResult.error.message}`);
      }
    }

    let live: LiveMatchState | null = null;
    if (fixture.status !== 'SCHEDULED' && fixture.status !== 'POSTPONED' && fixture.status !== 'CANCELLED') {
      const liveResult = await this.provider.getLiveMatchState(fixture.id);
      if (liveResult.ok) {
        live = liveResult.value;
        statsNotes.push(...liveResult.notes);
      } else {
        statsNotes.push(`Live match state unavailable: ${liveResult.error.message}`);
      }
    } else {
      statsNotes.push('Fixture has not kicked off; no live state fetched yet.');
    }

    const profiles = await this.loadProfiles(lineups, statsNotes);
    this.mark('stats', seasonStats.length === 0 && live === null ? 'failed' : 'done', statsNotes);

    // ---- Assemble -------------------------------------------------------
    const quality = assessFixtureDataQuality({
      lineups,
      live,
      squadPlayers: squads.flatMap((squad) => squad.players),
      seasonStats,
      profiles,
      notes: this.steps.flatMap((step) => step.notes),
    });

    this.running = false;
    this.finished = true;
    this.emit();

    return ok(
      {
        fixture,
        lineups,
        squads,
        seasonStats,
        profiles,
        live,
        quality,
        gameAvailability: evaluateGameAvailability(quality),
      },
      quality.notes,
    );
  }

  /** Profiles (and therefore career history) for a handful of starters, which is what `G1`/`G3` need. */
  private async loadProfiles(
    lineups: FixtureLineups | null,
    notes: string[],
  ): Promise<readonly PlayerProfile[]> {
    if (lineups === null) return [];
    const count = this.options.profileCount ?? 8;
    const candidates = [...lineups.home.startingXI, ...lineups.away.startingXI].slice(0, Math.max(0, count));
    const profiles: PlayerProfile[] = [];
    for (const candidate of candidates) {
      const result = await this.provider.getPlayerProfile(candidate.playerId);
      if (!result.ok) {
        notes.push(`Profile for ${candidate.name} unavailable: ${result.error.message}`);
        continue;
      }
      if (result.value === null) {
        notes.push(`No profile found for ${candidate.name}.`);
        continue;
      }
      profiles.push(result.value);
    }
    return profiles;
  }

  private reset(): void {
    this.steps = PREFETCH_STEP_ORDER.map((id) => ({
      id,
      label: PREFETCH_STEP_LABELS[id],
      status: 'pending',
      notes: [],
      error: null,
    }));
    this.running = false;
    this.finished = false;
    this.failed = false;
  }

  private mark(
    id: PrefetchStepId,
    status: PrefetchStepStatus,
    notes: readonly string[] = [],
    error: DataError | null = null,
  ): void {
    this.steps = this.steps.map((step) =>
      step.id === id ? { ...step, status, notes: [...step.notes, ...notes], error: error ?? step.error } : step,
    );
    this.emit();
  }

  private skipFrom(id: PrefetchStepId): void {
    const start = PREFETCH_STEP_ORDER.indexOf(id);
    if (start < 0) return;
    this.steps = this.steps.map((step, index) =>
      index >= start && step.status === 'pending' ? { ...step, status: 'skipped' } : step,
    );
  }

  private emit(): void {
    this.options.onProgress?.(this.progress());
  }
}
