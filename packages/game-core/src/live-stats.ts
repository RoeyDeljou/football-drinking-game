/**
 * Live match statistics: the `MATCH_STATS` system action and its validation.
 *
 * ## Contract (for the transport)
 *
 * Each live poll already yields `LiveMatchState.playerStats` / `teamStats` next to the events. The
 * ingestion loop dispatches, for every room whose current round is `open` and whose module
 * `supportsLiveStats`:
 *
 * ```ts
 * { type: 'MATCH_STATS', fixtureId, asOf: state.updatedAt, playerStats: state.playerStats, teamStats: state.teamStats }
 * ```
 *
 * - **Snapshots, not deltas.** Each action is the fixture's full cumulative stat line at `asOf`
 *   (ISO 8601). The latest snapshot wins: the reducer ignores one whose `asOf` is not strictly later
 *   than the last one the round accepted (`RoundRecord.statsAsOf`), so re-sends, reconnects and
 *   out-of-order deliveries are no-ops (no state change, no broadcast). Send it *after* the same
 *   poll's `MATCH_EVENTS`, so a module that settles "on the first snapshot after the whistle" gets
 *   the final line.
 * - **Validated here** with Zod (`matchStatsActionSchema`, also exported for the transport); a
 *   malformed action is rejected with `INVALID_STATS`. Unknown keys are stripped.
 * - **What ESPN really provides live per player:** goals, assists, shots, shotsOnTarget,
 *   foulsCommitted and (reconstructed) minutesPlayed. passes / passAccuracy / tackles / duelsWon /
 *   rating are `null` — modules must not build rules on them. A `null` counts as 0 in every rule
 *   shipped so far, and so does a footballer missing from the list.
 * - Rejected (`ROUND_CLOSED`) once the round is no longer `open`, like `MATCH_EVENTS`; ignored
 *   (unchanged state) by modules without `observeStats`.
 */

import type { FixtureId, FootballPlayerId, PlayerMatchStats, TeamId, TeamMatchStats } from '@fdg/football-data';
import { z } from 'zod';

const count = z.number().int().min(0).nullable();
const percent = z.number().min(0).max(100).nullable();
const footballerId = z.string().min(1).transform((value) => value as FootballPlayerId);
const teamId = z.string().min(1).transform((value) => value as TeamId);

export const playerMatchStatsSchema = z.object({
  playerId: footballerId,
  teamId,
  minutesPlayed: z.number().int().min(0).max(200).nullable(),
  goals: z.number().int().min(0),
  assists: z.number().int().min(0),
  shots: count,
  shotsOnTarget: count,
  passes: count,
  passAccuracy: percent,
  tackles: count,
  duelsWon: count,
  foulsCommitted: count,
  rating: z.number().min(0).max(10).nullable(),
}) satisfies z.ZodType<PlayerMatchStats, z.ZodTypeDef, unknown>;

export const teamMatchStatsSchema = z.object({
  teamId,
  possession: percent,
  shots: count,
  shotsOnTarget: count,
  corners: count,
  offsides: count,
  fouls: count,
  yellowCards: count,
  redCards: count,
  passes: count,
  passAccuracy: percent,
}) satisfies z.ZodType<TeamMatchStats, z.ZodTypeDef, unknown>;

export const matchStatsActionSchema = z.object({
  type: z.literal('MATCH_STATS'),
  fixtureId: z
    .string()
    .min(1)
    .transform((value) => value as FixtureId),
  asOf: z.string().refine((value) => Number.isFinite(Date.parse(value)), 'asOf must be an ISO 8601 timestamp'),
  playerStats: z.array(playerMatchStatsSchema).max(200),
  teamStats: z.array(teamMatchStatsSchema).max(2),
});

/** The engine's view of one accepted snapshot, as `observeStats` receives it. */
export interface LiveStatsSnapshot {
  readonly fixtureId: FixtureId;
  /** `Date.parse(asOf)`: epoch milliseconds of the provider snapshot. */
  readonly asOf: number;
  readonly playerStats: readonly PlayerMatchStats[];
  readonly teamStats: readonly TeamMatchStats[];
}
