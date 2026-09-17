/**
 * Zod schemas for raw API-Football v3 (RapidAPI) responses.
 *
 * These are the *only* place API-Football's shapes are named. Nothing here is exported past the adapter: the
 * normalizers in `normalize.ts` consume these types and emit normalized domain types.
 *
 * Schemas are deliberately lenient about fields the app does not use and about nulls API-Football sprinkles
 * through its payloads (a fixture with no venue, a player with no height, a lineup with no formation). Anything
 * genuinely required is strict, so a shape change becomes an `INVALID_RESPONSE` rather than a silent zero.
 */

import { z } from 'zod';

/** API-Football wraps everything in `{ get, parameters, errors, results, paging, response }`. */
function envelope<T extends z.ZodTypeAny>(response: T) {
  return z.object({
    /** `errors` is `[]` on success and an object of messages on failure. */
    errors: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
    results: z.number().optional(),
    paging: z.object({ current: z.number(), total: z.number() }).optional(),
    response: z.array(response),
  });
}

const nullableString = z.string().nullable().optional();
const nullableNumber = z.number().nullable().optional();

export const rawTeamSchema = z.object({
  id: z.number(),
  name: z.string(),
  code: nullableString,
  logo: nullableString,
  country: nullableString,
  winner: z.boolean().nullable().optional(),
});

export const rawFixtureSchema = z.object({
  fixture: z.object({
    id: z.number(),
    date: z.string(),
    timestamp: z.number().optional(),
    venue: z
      .object({ id: nullableNumber, name: nullableString, city: nullableString })
      .nullable()
      .optional(),
    status: z.object({
      long: z.string(),
      short: z.string(),
      elapsed: z.number().nullable().optional(),
    }),
  }),
  league: z.object({
    id: z.number(),
    name: z.string().optional(),
    season: z.number().optional(),
    round: nullableString,
  }),
  teams: z.object({ home: rawTeamSchema, away: rawTeamSchema }),
  goals: z.object({ home: z.number().nullable(), away: z.number().nullable() }).optional(),
  score: z
    .object({
      halftime: z.object({ home: z.number().nullable(), away: z.number().nullable() }).nullable().optional(),
      fulltime: z.object({ home: z.number().nullable(), away: z.number().nullable() }).nullable().optional(),
    })
    .optional(),
});

export const fixturesResponseSchema = envelope(rawFixtureSchema);

const rawLineupPlayerSchema = z.object({
  player: z.object({
    id: z.number().nullable(),
    name: z.string().nullable(),
    number: z.number().nullable().optional(),
    pos: nullableString,
    grid: nullableString,
  }),
});

export const rawLineupSchema = z.object({
  team: rawTeamSchema,
  formation: nullableString,
  coach: z.object({ id: nullableNumber, name: nullableString }).nullable().optional(),
  startXI: z.array(rawLineupPlayerSchema),
  substitutes: z.array(rawLineupPlayerSchema),
});

export const lineupsResponseSchema = envelope(rawLineupSchema);

export const rawEventSchema = z.object({
  time: z.object({ elapsed: z.number().nullable(), extra: z.number().nullable().optional() }),
  team: z.object({ id: z.number().nullable(), name: nullableString }).nullable().optional(),
  player: z.object({ id: z.number().nullable(), name: nullableString }).nullable().optional(),
  assist: z.object({ id: z.number().nullable(), name: nullableString }).nullable().optional(),
  type: z.string(),
  detail: nullableString,
  comments: nullableString,
});

export const eventsResponseSchema = envelope(rawEventSchema);

export const rawTeamStatisticsSchema = z.object({
  team: rawTeamSchema,
  statistics: z.array(
    z.object({
      type: z.string(),
      /** API-Football sends `"52%"` for possession and `null` for anything it has no value for. */
      value: z.union([z.number(), z.string(), z.null()]),
    }),
  ),
});

export const teamStatisticsResponseSchema = envelope(rawTeamStatisticsSchema);

const rawPlayerMatchStatSchema = z.object({
  games: z
    .object({ minutes: nullableNumber, position: nullableString, rating: nullableString })
    .nullable()
    .optional(),
  shots: z.object({ total: nullableNumber, on: nullableNumber }).nullable().optional(),
  goals: z.object({ total: nullableNumber, assists: nullableNumber }).nullable().optional(),
  passes: z.object({ total: nullableNumber, accuracy: z.union([z.number(), z.string(), z.null()]).optional() }).nullable().optional(),
  tackles: z.object({ total: nullableNumber }).nullable().optional(),
  duels: z.object({ total: nullableNumber, won: nullableNumber }).nullable().optional(),
  fouls: z.object({ committed: nullableNumber }).nullable().optional(),
});

export const rawFixturePlayersSchema = z.object({
  team: rawTeamSchema,
  players: z.array(
    z.object({
      player: z.object({ id: z.number().nullable(), name: nullableString }),
      statistics: z.array(rawPlayerMatchStatSchema),
    }),
  ),
});

export const fixturePlayersResponseSchema = envelope(rawFixturePlayersSchema);

export const rawSquadPlayerSchema = z.object({
  id: z.number().nullable(),
  name: z.string().nullable(),
  age: nullableNumber,
  number: nullableNumber,
  position: nullableString,
  photo: nullableString,
});

export const squadsResponseSchema = envelope(
  z.object({
    team: rawTeamSchema,
    players: z.array(rawSquadPlayerSchema),
  }),
);

const rawPlayerBioSchema = z.object({
  id: z.number().nullable(),
  name: z.string().nullable(),
  firstname: nullableString,
  lastname: nullableString,
  age: nullableNumber,
  birth: z.object({ date: nullableString, country: nullableString }).nullable().optional(),
  nationality: nullableString,
  height: nullableString,
  weight: nullableString,
  photo: nullableString,
});

const rawPlayerSeasonStatSchema = z.object({
  team: rawTeamSchema,
  league: z.object({ id: z.number().nullable(), season: nullableNumber }).nullable().optional(),
  games: z
    .object({
      appearences: nullableNumber,
      minutes: nullableNumber,
      position: nullableString,
      rating: nullableString,
    })
    .nullable()
    .optional(),
  shots: z.object({ total: nullableNumber, on: nullableNumber }).nullable().optional(),
  goals: z.object({ total: nullableNumber, assists: nullableNumber }).nullable().optional(),
  passes: z.object({ total: nullableNumber, accuracy: z.union([z.number(), z.string(), z.null()]).optional() }).nullable().optional(),
  tackles: z.object({ total: nullableNumber }).nullable().optional(),
  cards: z.object({ yellow: nullableNumber, yellowred: nullableNumber, red: nullableNumber }).nullable().optional(),
});

export const rawPlayerSchema = z.object({
  player: rawPlayerBioSchema,
  statistics: z.array(rawPlayerSeasonStatSchema),
});

export const playersResponseSchema = envelope(rawPlayerSchema);

export const rawTransferSchema = z.object({
  player: z.object({ id: z.number().nullable(), name: nullableString }).nullable().optional(),
  transfers: z.array(
    z.object({
      date: nullableString,
      type: nullableString,
      teams: z
        .object({ in: rawTeamSchema.nullable().optional(), out: rawTeamSchema.nullable().optional() })
        .nullable()
        .optional(),
    }),
  ),
});

export const transfersResponseSchema = envelope(rawTransferSchema);

export type RawFixture = z.infer<typeof rawFixtureSchema>;
export type RawLineup = z.infer<typeof rawLineupSchema>;
export type RawEvent = z.infer<typeof rawEventSchema>;
export type RawTeamStatistics = z.infer<typeof rawTeamStatisticsSchema>;
export type RawFixturePlayers = z.infer<typeof rawFixturePlayersSchema>;
export type RawSquad = z.infer<typeof squadsResponseSchema>['response'][number];
export type RawPlayer = z.infer<typeof rawPlayerSchema>;
export type RawTransfer = z.infer<typeof rawTransferSchema>;

/** API-Football answers HTTP 200 with a populated `errors` object for application-level failures. */
export function envelopeErrorMessage(errors: unknown): string | null {
  if (errors === undefined || errors === null) return null;
  if (Array.isArray(errors)) return errors.length === 0 ? null : errors.map((entry) => String(entry)).join('; ');
  if (typeof errors === 'object') {
    const entries = Object.entries(errors as Record<string, unknown>);
    if (entries.length === 0) return null;
    return entries.map(([key, value]) => `${key}: ${String(value)}`).join('; ');
  }
  return String(errors);
}
