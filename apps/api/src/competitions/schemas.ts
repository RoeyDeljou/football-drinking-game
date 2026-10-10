import { z } from 'zod';

export const competitionIdParamsSchema = z.object({
  id: z.string().min(1).max(64),
});

/**
 * `live`: fixtures in progress right now (LIVE, HALF_TIME, EXTRA_TIME, PENALTIES).
 * `upcoming`: SCHEDULED fixtures kicking off within the next 14 days.
 * `open`: live fixtures plus SCHEDULED ones kicking off within 30 minutes (`OPEN_BEFORE_KICKOFF_MS`) — what a host may
 * pick; served from the provider's current scoreboard like `live`.
 * Omitted (default): both, live first.
 */
export const fixtureWindowSchema = z.enum(['live', 'upcoming', 'open']).optional();

export const fixturesQuerySchema = z.object({
  window: fixtureWindowSchema,
});
