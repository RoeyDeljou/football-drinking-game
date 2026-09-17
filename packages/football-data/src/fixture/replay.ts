/**
 * Deterministic match-timeline replay.
 *
 * This is what makes matchday games testable with no real match in progress. A recorded timeline is projected to
 * any point in the match and the replay derives everything a live feed would give you there: fixture status,
 * score, half-time score, the events so far, and progressively accumulating team/player stats.
 *
 * ## The replay clock
 *
 * Match minutes on a scoreboard overlap: `45'+2'` happens *before* the second half's `46'`. The replay therefore
 * runs on an **elapsed** axis that includes stoppage time. First-half events sit at `minute + extra`; every event
 * after the half-time whistle is shifted by the first half's stoppage, so ordering is always chronological. A match
 * with two minutes of first-half and five of second-half stoppage runs from elapsed 0 to 97.
 *
 * Two ways to move the clock, both fully controlled by the caller:
 *
 * - `advanceTo(elapsedMinute)` — jump straight there. No timers involved; this is how tests drive it.
 * - `start()` plus a `DataClock` — elapsed minutes = real elapsed time × `speedMultiplier`, so a match replays in a
 *   tenth of the time at `speedMultiplier: 10`. With `createManualClock()` even this path involves no real waiting.
 *
 * There is deliberately no `setTimeout`-driven mode: the replay's position is a pure function of the injected clock.
 */

import type { DataClock } from '../clock.js';
import type {
  Fixture,
  FixtureStatus,
  LiveMatchState,
  MatchEvent,
  PlayerMatchStats,
  Score,
  TeamMatchStats,
} from '../domain.js';
import type { RecordedMatchTimeline } from './recorded-schema.js';

export interface MatchReplayOptions {
  readonly timeline: RecordedMatchTimeline;
  /** The recorded fixture the timeline belongs to; used for teams, venue and kickoff. */
  readonly fixture: Fixture;
  readonly clock: DataClock;
  /** Elapsed match minutes per real minute. 1 = real time, 10 = ten times faster. Must be > 0. Default 1. */
  readonly speedMultiplier?: number | undefined;
  /** Elapsed minute the replay sits at before `start()` is called. Default 0 (pre-kickoff). */
  readonly startMinute?: number | undefined;
  /** Begin the clock immediately instead of waiting for `start()`. Default false. */
  readonly autoStart?: boolean | undefined;
}

export interface MatchReplayStatus {
  readonly fixtureId: string;
  /** Position on the elapsed axis (includes stoppage time). */
  readonly elapsedMinute: number;
  /** The minute a scoreboard would show, e.g. 45 during first-half stoppage. Null before kick-off and after full time. */
  readonly matchMinute: number | null;
  readonly running: boolean;
  readonly finished: boolean;
  readonly speedMultiplier: number;
  /** Elapsed minute of the final whistle. */
  readonly finalMinute: number;
  readonly eventsEmitted: number;
  readonly totalEvents: number;
}

interface TimedEvent {
  readonly event: MatchEvent;
  readonly elapsed: number;
  readonly secondHalf: boolean;
}

export class MatchReplay {
  private readonly timeline: RecordedMatchTimeline;
  private readonly baseFixture: Fixture;
  private readonly clock: DataClock;
  private readonly speed: number;
  private readonly timed: readonly TimedEvent[];
  private readonly finalMinute: number;
  private readonly firstHalfStoppage: number;

  private startedAtMs: number | null = null;
  private anchorMinute: number;

  constructor(options: MatchReplayOptions) {
    this.timeline = options.timeline;
    this.baseFixture = options.fixture;
    this.clock = options.clock;
    const speed = options.speedMultiplier ?? 1;
    this.speed = speed > 0 ? speed : 1;

    const { timed, firstHalfStoppage } = buildElapsedAxis(options.timeline.events);
    this.timed = timed;
    this.firstHalfStoppage = firstHalfStoppage;
    this.finalMinute = timed.reduce(
      (latest, entry) => Math.max(latest, entry.elapsed),
      options.timeline.regulationMinutes + firstHalfStoppage,
    );
    this.anchorMinute = clampMinute(options.startMinute ?? 0, this.finalMinute);
    if (options.autoStart === true) this.start();
  }

  /** Start (or resume) the clock-driven replay from the current position. */
  start(): void {
    this.anchorMinute = this.currentMinute;
    this.startedAtMs = this.clock.now();
  }

  /** Freeze the replay where it is. */
  pause(): void {
    this.anchorMinute = this.currentMinute;
    this.startedAtMs = null;
  }

  /** Jump to an elapsed minute, clamped to `[0, finalMinute]`. Keeps running if it was running. */
  advanceTo(elapsedMinute: number): void {
    this.anchorMinute = clampMinute(elapsedMinute, this.finalMinute);
    if (this.startedAtMs !== null) this.startedAtMs = this.clock.now();
  }

  /** Back to pre-kickoff, stopped. */
  reset(): void {
    this.startedAtMs = null;
    this.anchorMinute = 0;
  }

  /** The fixture this replay plays back. */
  get fixtureId(): string {
    return this.timeline.fixtureId;
  }

  get speedMultiplier(): number {
    return this.speed;
  }

  get running(): boolean {
    return this.startedAtMs !== null && !this.isFinished();
  }

  /** Current position on the elapsed axis. A pure function of the injected clock. */
  get currentMinute(): number {
    if (this.startedAtMs === null) return this.anchorMinute;
    const elapsedMs = Math.max(0, this.clock.now() - this.startedAtMs);
    return clampMinute(this.anchorMinute + (elapsedMs / 60_000) * this.speed, this.finalMinute);
  }

  isFinished(): boolean {
    return this.currentMinute >= this.finalMinute;
  }

  status(): MatchReplayStatus {
    const fixture = this.fixture();
    return {
      fixtureId: this.timeline.fixtureId,
      elapsedMinute: this.currentMinute,
      matchMinute: fixture.minute,
      running: this.running,
      finished: this.isFinished(),
      speedMultiplier: this.speed,
      finalMinute: this.finalMinute,
      eventsEmitted: this.eventsSoFar().length,
      totalEvents: this.timed.length,
    };
  }

  /** Every event at or before the current position, in chronological order. Stable ids, so polls are idempotent. */
  eventsSoFar(): readonly MatchEvent[] {
    return this.firedAt(this.currentMinute).map((entry) => entry.event);
  }

  /** The fixture as a live feed would report it right now. */
  fixture(): Fixture {
    const fired = this.firedAt(this.currentMinute);
    const status = deriveStatus(fired, this.currentMinute, this.finalMinute);
    const halfTimeFired = fired.some((entry) => entry.event.type === 'HALF_TIME');
    const events = fired.map((entry) => entry.event);
    return {
      ...this.baseFixture,
      status,
      minute: status === 'SCHEDULED' || status === 'FINISHED' ? null : this.matchMinute(fired),
      score: status === 'SCHEDULED' ? null : scoreFromEvents(events, this.baseFixture),
      halfTimeScore: halfTimeFired
        ? scoreFromEvents(
            fired.filter((entry) => !entry.secondHalf).map((entry) => entry.event),
            this.baseFixture,
          )
        : null,
    };
  }

  /** Full live snapshot: fixture, events so far, and stats accumulated to this point. */
  snapshot(): LiveMatchState {
    const fired = this.firedAt(this.currentMinute);
    const events = fired.map((entry) => entry.event);
    return {
      fixture: this.fixture(),
      events,
      teamStats: this.teamStatsAt(events),
      playerStats: this.playerStatsAt(events, this.matchMinute(fired)),
      updatedAt: new Date(this.clock.now()).toISOString(),
    };
  }

  private firedAt(elapsed: number): readonly TimedEvent[] {
    return this.timed.filter((entry) => entry.elapsed <= elapsed);
  }

  /** What a scoreboard shows: capped at 45 in first-half stoppage and 90 in second-half stoppage. */
  private matchMinute(fired: readonly TimedEvent[]): number {
    const inSecondHalf = fired.some((entry) => entry.secondHalf);
    const elapsed = Math.floor(this.currentMinute);
    if (!inSecondHalf) return Math.min(elapsed, 45);
    return Math.min(Math.max(46, elapsed - this.firstHalfStoppage), this.timeline.regulationMinutes);
  }

  /**
   * Counting stats (corners, cards, shots, offsides, fouls) come from the events that have actually fired, so they
   * agree exactly with `eventsSoFar()`. Rate stats (possession, passes, pass accuracy) have no per-event source and
   * converge linearly on the recorded full-time values.
   */
  private teamStatsAt(events: readonly MatchEvent[]): readonly TeamMatchStats[] {
    const fraction = this.finalMinute === 0 ? 0 : Math.min(1, this.currentMinute / this.finalMinute);
    return this.timeline.finalTeamStats.map((final) => {
      const own = events.filter((event) => event.teamId === final.teamId);
      return {
        teamId: final.teamId,
        possession: interpolate(final.possession, fraction, 50),
        shots: countTypes(own, ['SHOT_ON_TARGET', 'SHOT_OFF_TARGET', 'GOAL', 'PENALTY_SCORED', 'PENALTY_MISSED']),
        shotsOnTarget: countTypes(own, ['SHOT_ON_TARGET', 'GOAL', 'PENALTY_SCORED']),
        corners: countTypes(own, ['CORNER']),
        offsides: countTypes(own, ['OFFSIDE']),
        fouls: countTypes(own, ['FOUL']),
        yellowCards: countTypes(own, ['YELLOW_CARD', 'SECOND_YELLOW']),
        redCards: countTypes(own, ['RED_CARD', 'SECOND_YELLOW']),
        passes: scaleCount(final.passes, fraction),
        passAccuracy: interpolate(final.passAccuracy, fraction, 70),
      };
    });
  }

  /**
   * Goals, assists and fouls come from events; minutes played honour substitutions; the remaining counting stats
   * scale with the share of the player's match that has been played.
   */
  private playerStatsAt(events: readonly MatchEvent[], minute: number): readonly PlayerMatchStats[] {
    return this.timeline.finalPlayerStats.map((final) => {
      const played = minutesPlayedAt(final, minute, events);
      const share = final.minutesPlayed === null || final.minutesPlayed === 0 ? 0 : played / final.minutesPlayed;
      const fraction = Math.max(0, Math.min(1, share));
      const own = events.filter((event) => event.playerId === final.playerId);
      const assists = events.filter((event) => event.relatedPlayerId === final.playerId && isGoal(event.type));
      return {
        playerId: final.playerId,
        teamId: final.teamId,
        minutesPlayed: played,
        goals: countTypes(own, ['GOAL', 'PENALTY_SCORED']),
        assists: assists.length,
        shots: scaleCount(final.shots, fraction),
        shotsOnTarget: scaleCount(final.shotsOnTarget, fraction),
        passes: scaleCount(final.passes, fraction),
        passAccuracy: final.passAccuracy === null ? null : interpolate(final.passAccuracy, fraction, 70),
        tackles: scaleCount(final.tackles, fraction),
        duelsWon: scaleCount(final.duelsWon, fraction),
        foulsCommitted: countTypes(own, ['FOUL']),
        rating: final.rating === null ? null : roundTo(6 + (final.rating - 6) * fraction, 1),
      };
    });
  }
}

/**
 * Place every event on the elapsed axis. Events are taken in recorded order (the recording is chronological); the
 * first `HALF_TIME` marker splits the halves, and the first half's stoppage shifts everything after it.
 */
export function buildElapsedAxis(events: readonly MatchEvent[]): {
  timed: readonly TimedEvent[];
  firstHalfStoppage: number;
} {
  const halfTimeIndex = events.findIndex((event) => event.type === 'HALF_TIME');
  const firstHalf = halfTimeIndex < 0 ? events : events.slice(0, halfTimeIndex + 1);
  const firstHalfStoppage = firstHalf.reduce(
    (stoppage, event) => (event.minute >= 45 ? Math.max(stoppage, event.extraMinute ?? 0) : stoppage),
    0,
  );
  const timed = events.map((event, index) => {
    const secondHalf = halfTimeIndex >= 0 && index > halfTimeIndex;
    const base = event.minute + (event.extraMinute ?? 0);
    return { event, secondHalf, elapsed: secondHalf ? base + firstHalfStoppage : base };
  });
  // Stable sort: ties keep recorded order, so a goal and the kick-off that follows it never swap.
  const ordered = timed
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => left.entry.elapsed - right.entry.elapsed || left.index - right.index)
    .map(({ entry }) => entry);
  return { timed: ordered, firstHalfStoppage };
}

function deriveStatus(fired: readonly TimedEvent[], elapsed: number, finalMinute: number): FixtureStatus {
  let status: FixtureStatus = 'SCHEDULED';
  for (const { event } of fired) {
    if (event.type === 'KICK_OFF') status = 'LIVE';
    else if (event.type === 'HALF_TIME') status = 'HALF_TIME';
    else if (event.type === 'FULL_TIME') status = 'FINISHED';
  }
  if (status === 'SCHEDULED' && elapsed > 0 && fired.length > 0) status = 'LIVE';
  if (status !== 'FINISHED' && elapsed >= finalMinute && fired.length > 0) status = 'FINISHED';
  return status;
}

function minutesPlayedAt(final: PlayerMatchStats, minute: number, events: readonly MatchEvent[]): number {
  const cameOn = events.find((event) => event.type === 'SUBSTITUTION' && event.relatedPlayerId === final.playerId);
  const wentOff = events.find((event) => event.type === 'SUBSTITUTION' && event.playerId === final.playerId);
  if (cameOn !== undefined) {
    const off = wentOff === undefined ? minute : wentOff.minute;
    return Math.max(0, off - cameOn.minute);
  }
  if (wentOff !== undefined) return wentOff.minute;
  if (final.minutesPlayed === null || final.minutesPlayed === 0) return 0;
  return Math.min(minute, final.minutesPlayed);
}

function clampMinute(value: number, finalMinute: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(finalMinute, value));
}

function isGoal(type: MatchEvent['type']): boolean {
  return type === 'GOAL' || type === 'PENALTY_SCORED';
}

function countTypes(events: readonly MatchEvent[], types: readonly MatchEvent['type'][]): number {
  return events.filter((event) => types.includes(event.type)).length;
}

function scaleCount(final: number | null, fraction: number): number | null {
  if (final === null) return null;
  return Math.round(final * fraction);
}

function interpolate(final: number | null, fraction: number, neutral: number): number | null {
  if (final === null) return null;
  if (fraction <= 0) return neutral;
  return roundTo(neutral + (final - neutral) * fraction, 1);
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function scoreFromEvents(events: readonly MatchEvent[], fixture: Fixture): Score {
  let home = 0;
  let away = 0;
  for (const event of events) {
    const goal = isGoal(event.type);
    const own = event.type === 'OWN_GOAL';
    if ((!goal && !own) || event.teamId === null) continue;
    const byHome = event.teamId === fixture.homeTeam.id;
    if ((goal && byHome) || (own && !byHome)) home += 1;
    else away += 1;
  }
  return { home, away };
}
