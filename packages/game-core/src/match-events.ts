/**
 * Engine-level conventions for reading provider `MatchEvent`s. Every module that interprets live
 * events (M1 settlement, M7 goal timing, the reducer's live-event window) goes through these helpers,
 * so a convention is fixed in exactly one place.
 *
 * ## Match clock
 *
 * Events carry a match clock, never a wall-clock time: `minute` plus `extraMinute` for stoppage time.
 * Both providers normalize "45+2'" to `{ minute: 45, extraMinute: 2 }` and "90+4'" to
 * `{ minute: 90, extraMinute: 4 }`; extra time continues at 91..120 (with its own stoppage). Ordering
 * is therefore lexicographic on `(minute, extraMinute ?? 0)`: 45+5 sorts before 46, 90+4 before 91.
 *
 * ## Goal attribution (provider convention)
 *
 * - `GOAL` and `PENALTY_SCORED`: `teamId` is the scoring team, `playerId` the scorer.
 * - `OWN_GOAL`: `teamId` is the team of the player who put the ball into **his own net**, i.e. the
 *   **conceding** team (ESPN `normalize.ts`, the replay provider and `full-time.ts`'s
 *   `goalsMatchScore` all agree). The goal is credited to the *opponent* of `teamId`, and nobody
 *   counts as having scored it.
 * - `PENALTY_MISSED` is not a goal.
 */

import type { MatchEvent, MatchEventType } from '@fdg/football-data';
import { z } from 'zod';

export interface MatchClock {
  readonly minute: number;
  /** Stoppage minutes on top of `minute` (`90+4'` is `{ minute: 90, extraMinute: 4 }`). */
  readonly extraMinute: number | null;
}

export const matchClockSchema = z
  .object({
    minute: z.number().int().min(0).max(200),
    extraMinute: z.number().int().min(0).max(60).nullable(),
  })
  .strict();

export const clockOf = (event: Pick<MatchEvent, 'minute' | 'extraMinute'>): MatchClock => ({
  minute: event.minute,
  extraMinute: event.extraMinute,
});

/** Negative when `a` is earlier than `b`, zero when equal, positive when later. */
export const compareMatchClock = (a: MatchClock, b: MatchClock): number =>
  a.minute - b.minute || (a.extraMinute ?? 0) - (b.extraMinute ?? 0);

/** The latest clock among `events`, or `null` for an empty list. */
export const latestClockOf = (events: readonly Pick<MatchEvent, 'minute' | 'extraMinute'>[]): MatchClock | null => {
  let latest: MatchClock | null = null;
  for (const event of events) {
    const clock = clockOf(event);
    if (latest === null || compareMatchClock(clock, latest) > 0) latest = clock;
  }
  return latest;
};

/** The later of two optional clocks. */
export const laterClock = (a: MatchClock | null, b: MatchClock | null): MatchClock | null => {
  if (a === null) return b;
  if (b === null) return a;
  return compareMatchClock(b, a) > 0 ? b : a;
};

/** Every event type that puts a goal on the scoreboard. */
export const GOAL_EVENT_TYPES: readonly MatchEventType[] = ['GOAL', 'PENALTY_SCORED', 'OWN_GOAL'];

export const isGoalEvent = (event: Pick<MatchEvent, 'type'>): boolean => GOAL_EVENT_TYPES.includes(event.type);

export type GoalSide = 'home' | 'away';

/**
 * Which side a goal event puts a goal on the board for, following the provider convention above
 * (an `OWN_GOAL` counts for the opponent of its `teamId`). `null` for a non-goal event or a goal
 * whose `teamId` is neither side (unattributable).
 */
export const goalCreditedSide = (
  event: Pick<MatchEvent, 'type' | 'teamId'>,
  homeTeamId: string,
  awayTeamId: string,
): GoalSide | null => {
  if (!isGoalEvent(event)) return null;
  const side: GoalSide | null =
    event.teamId === homeTeamId ? 'home' : event.teamId === awayTeamId ? 'away' : null;
  if (side === null) return null;
  if (event.type !== 'OWN_GOAL') return side;
  return side === 'home' ? 'away' : 'home';
};

/** The footballer credited with scoring, or `null` (own goals are nobody's goal). */
export const goalScorerOf = <T extends Pick<MatchEvent, 'type' | 'playerId'>>(
  event: T,
): T['playerId'] | null => (event.type === 'GOAL' || event.type === 'PENALTY_SCORED' ? event.playerId : null);
