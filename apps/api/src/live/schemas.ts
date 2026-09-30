/**
 * Zod boundary for the live-ingestion loop. Provider data is normalised by `@fdg/football-data`
 * already, but this loop is the point where it becomes an engine action, so each event is
 * re-validated here: one malformed event is dropped (and reported), never allowed to poison a
 * whole batch or reach the reducer.
 */

import { z } from 'zod';

export const matchEventShapeSchema = z.object({
  id: z.string().min(1),
  fixtureId: z.string().min(1),
  type: z.enum([
    'GOAL',
    'OWN_GOAL',
    'PENALTY_SCORED',
    'PENALTY_MISSED',
    'PENALTY_AWARDED',
    'ASSIST',
    'YELLOW_CARD',
    'SECOND_YELLOW',
    'RED_CARD',
    'SUBSTITUTION',
    'CORNER',
    'OFFSIDE',
    'FOUL',
    'THROW_IN',
    'GOAL_KICK',
    'SHOT_ON_TARGET',
    'SHOT_OFF_TARGET',
    'SAVE',
    'VAR_CHECK',
    'HALF_TIME',
    'FULL_TIME',
    'KICK_OFF',
  ]),
  minute: z.number().int().min(0),
  extraMinute: z.number().int().min(0).nullable(),
  teamId: z.string().nullable(),
  playerId: z.string().nullable(),
  playerName: z.string().nullable(),
  relatedPlayerId: z.string().nullable(),
  detail: z.string().nullable(),
});

export const fixtureStatusSchema = z.enum([
  'SCHEDULED',
  'LIVE',
  'HALF_TIME',
  'EXTRA_TIME',
  'PENALTIES',
  'FINISHED',
  'POSTPONED',
  'CANCELLED',
]);

export const liveIngestionConfigSchema = z
  .object({
    /** Poll cadence while a fixture is live. Matches the provider's documented live-event TTL. */
    liveIntervalMs: z.number().int().min(1).default(15_000),
    /** Poll cadence while a watched fixture has not kicked off yet. */
    preKickoffIntervalMs: z.number().int().min(1).default(60_000),
    /** From this long before scheduled kickoff, poll at the live cadence (catches kickoff promptly). */
    kickoffLeadMs: z.number().int().min(0).default(120_000),
    /** How often a stopped (finished/postponed) watcher re-checks that its rooms still exist. */
    reapIntervalMs: z.number().int().min(1).default(60_000),
    /** Longest to keep slowly polling a FINISHED fixture that still has no FULL_TIME event. */
    finishedWithoutFullTimeMaxMs: z.number().int().min(1).default(4 * 60 * 60 * 1000),
    /** Ceiling for the exponential error backoff. */
    maxBackoffMs: z.number().int().min(1).default(120_000),
    /** Multiplier applied per consecutive failure. */
    backoffFactor: z.number().min(1).default(2),
    /** +/- fraction of random spread on every delay, so fixtures do not poll in lockstep. */
    jitterRatio: z.number().min(0).max(0.5).default(0.1),
  })
  .strict();

export type LiveIngestionConfig = z.infer<typeof liveIngestionConfigSchema>;
export type LiveIngestionConfigInput = z.input<typeof liveIngestionConfigSchema>;

export const DEFAULT_LIVE_INGESTION_CONFIG: LiveIngestionConfig = liveIngestionConfigSchema.parse({});
