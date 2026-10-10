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
 *
 * `runGameday` builds on the same `run()` to serve a whole live matchday: one `MatchdayBundle` per fixture in a
 * competition that is currently live, for "gameday mode" (one room, rounds rotating across every live match in a
 * competition). See the type doc on `GamedayBundle` below for the failure/concurrency policy.
 */

import { assessFixtureDataQuality, evaluateGameAvailability } from './data-quality.js';
import type { GameAvailability } from './data-quality.js';
import type {
  CompetitionId,
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

/**
 * Data for a whole live matchday in one competition: one full `MatchdayBundle` per fixture that is currently live.
 * This is what backs "gameday mode" — one room, rounds rotating across `fixtures[0]`, `fixtures[1]`, … for as long
 * as those games stay live. `apps/api` is expected to re-poll `FootballDataProvider.listLiveFixtures` on its own
 * schedule and diff against `fixtures.map(b => b.fixture.id)` to notice a match finishing or a new one kicking off
 * mid-session — that polling/diffing lives there, not here.
 */
export interface GamedayBundle {
  readonly competitionId: CompetitionId;
  /** One bundle per live fixture that could be prefetched, in the same order `listLiveFixtures` returned them. */
  readonly fixtures: readonly MatchdayBundle[];
  /** Live fixtures whose prefetch failed outright (no fixture, step 1) and were skipped rather than failing the batch. */
  readonly skipped: readonly { readonly fixtureId: FixtureId; readonly error: DataError }[];
}

export interface GamedayPrefetchOptions extends MatchdayPrefetchOptions {
  /**
   * How many fixtures' prefetch pipelines run at once. Default 3. This bounds *pipeline* concurrency, not raw HTTP
   * concurrency — every fixture's `run()` still goes through the same provider instance, so its own per-endpoint
   * TTL cache, request coalescing and rate limiter (e.g. `EspnProvider`'s 5-requests-per-5-seconds / 2-in-flight
   * limiter) still gate the actual upstream calls. A small number here just caps how many fixtures are mid-flight
   * (and therefore how many concurrent step-1 fixture calls, step-3 squad calls, etc. queue up at once) so a
   * ten-fixture Champions League night doesn't fire all ten prefetch pipelines' worth of requests simultaneously.
   */
  readonly concurrency?: number | undefined;
  /** Called once per live fixture as its own `MatchdayPrefetcher.run()` reports progress. */
  readonly onFixtureProgress?: ((fixtureId: FixtureId, progress: MatchdayPrefetchProgress) => void) | undefined;
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
    // Step 4 is non-fatal. Before kickoff there is no live state by design, so missing season stats alone must not
    // fail it (a failed step blocks the host from starting); games that need stats are gated by data quality instead.
    const notKickedOff = fixture.status === 'SCHEDULED';
    this.mark('stats', seasonStats.length === 0 && live === null && !notKickedOff ? 'failed' : 'done', statsNotes);

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

  /**
   * Build one `MatchdayBundle` per fixture currently live in `competitionId` — the data behind gameday mode.
   *
   * Failure policy:
   *  - `listLiveFixtures` itself failing (upstream down) propagates as this call's failure.
   *  - Zero live fixtures is not a failure: `ok: true` with an empty `fixtures` array, so `apps/api` can offer
   *    "nothing live right now" instead of an error screen.
   *  - One fixture's `run()` failing (its step-1 fixture fetch failed) is *not* fatal to the batch: that fixture is
   *    recorded in `skipped` and every other live fixture's bundle still comes back. This mirrors the general
   *    dataset's "skip a competition that failed to load rather than failing the whole build" policy.
   *  - The whole call only fails if every live fixture's prefetch failed (nothing to serve at all).
   *
   * Runs with bounded concurrency (`options.concurrency`, default 3) — see `GamedayPrefetchOptions.concurrency`
   * for why that bound is about pipeline count, not raw request count. Each fixture gets its own `MatchdayPrefetcher`
   * instance (this instance's own step/progress state is untouched), so `options.onFixtureProgress` can distinguish
   * which live fixture is reporting.
   */
  async runGameday(competitionId: CompetitionId, options: GamedayPrefetchOptions = {}): Promise<DataResult<GamedayBundle>> {
    const liveResult = await this.provider.listLiveFixtures(competitionId);
    if (!liveResult.ok) return liveResult;
    const liveFixtures = liveResult.value;
    if (liveFixtures.length === 0) {
      return ok({ competitionId, fixtures: [], skipped: [] }, liveResult.notes);
    }

    const concurrency = Math.max(1, options.concurrency ?? 3);
    const perFixtureOptions: MatchdayPrefetchOptions = {
      profileCount: options.profileCount,
      seasonStatsLimit: options.seasonStatsLimit,
    };

    const outcomes = await mapWithConcurrency(liveFixtures, concurrency, async (fixture) => {
      const sub = new MatchdayPrefetcher(this.provider, {
        ...perFixtureOptions,
        onProgress:
          options.onFixtureProgress === undefined
            ? undefined
            : (progress) => options.onFixtureProgress?.(fixture.id, progress),
      });
      return sub.run(fixture.id);
    });

    const bundles: MatchdayBundle[] = [];
    const skipped: { fixtureId: FixtureId; error: DataError }[] = [];
    const notes: string[] = [...liveResult.notes];
    for (const [index, result] of outcomes.entries()) {
      const fixture = liveFixtures[index];
      if (fixture === undefined) continue;
      if (result.ok) {
        bundles.push(result.value);
        notes.push(...result.notes);
      } else {
        skipped.push({ fixtureId: fixture.id, error: result.error });
        notes.push(`Gameday: fixture ${fixture.id} skipped — ${result.error.message}`);
      }
    }

    if (bundles.length === 0) {
      return fail('UPSTREAM', `gameday prefetch for competition ${competitionId} failed for every live fixture`, {
        retryable: true,
      });
    }

    return ok({ competitionId, fixtures: bundles, skipped }, [...new Set(notes)]);
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

/**
 * Run `task` over `items` with at most `concurrency` in flight at once, preserving input order in the returned
 * array regardless of completion order (a fast fixture finishing before a slow one must not reshuffle round order).
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await task(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}
