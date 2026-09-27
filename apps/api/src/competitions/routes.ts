import type { FastifyInstance } from 'fastify';
import type { Fixture, FixtureStatus } from '@fdg/football-data';
import { allCompetitions, asCompetitionId, competitionConfigById } from '@fdg/football-data';
import type { AppContext } from '../context.js';
import { competitionIdParamsSchema, fixturesQuerySchema } from './schemas.js';

/** Fixtures in one of these statuses are happening right now. */
const LIVE_STATUSES: readonly FixtureStatus[] = ['LIVE', 'HALF_TIME', 'EXTRA_TIME', 'PENALTIES'];

/**
 * How far ahead "upcoming" looks. 14 days comfortably spans a domestic matchday's midweek/weekend
 * pairing and a Champions League group/knockout gap, without the list filling up with fixtures so
 * far out a host would never realistically wait for them.
 */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const UPCOMING_WINDOW_MS = 14 * ONE_DAY_MS;

/** Cap on the returned list, applied after filtering and sorting. */
const MAX_FIXTURES = 20;

export interface FixtureSummary {
  readonly fixtureId: string;
  readonly kickoff: string;
  readonly status: FixtureStatus;
  readonly minute: number | null;
  readonly competitionId: string;
  readonly homeTeam: { readonly name: string; readonly crestUrl: string | null };
  readonly awayTeam: { readonly name: string; readonly crestUrl: string | null };
}

/** `YYYY-MM-DD`, as `FootballDataProvider.getFixturesByCompetition`'s `from`/`to` expect. */
const toDateOnly = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const summarizeFixture = (fixture: Fixture): FixtureSummary => ({
  fixtureId: fixture.id,
  kickoff: fixture.kickoff,
  status: fixture.status,
  minute: fixture.minute,
  competitionId: fixture.competitionId,
  homeTeam: { name: fixture.homeTeam.name, crestUrl: fixture.homeTeam.crestUrl },
  awayTeam: { name: fixture.awayTeam.name, crestUrl: fixture.awayTeam.crestUrl },
});

/**
 * Filters and orders fixtures for the room-host picker: live fixtures first (soonest-kicked-off
 * first), then scheduled fixtures kicking off within `UPCOMING_WINDOW_MS`, soonest first. Anything
 * finished, postponed, cancelled, or too far in the future is dropped. `window` narrows to just one
 * half of that list; omitted, both are combined.
 */
export function selectRelevantFixtures(
  fixtures: readonly Fixture[],
  window: 'live' | 'upcoming' | undefined,
  nowMs: number,
): readonly Fixture[] {
  const live = fixtures.filter((fixture) => LIVE_STATUSES.includes(fixture.status));
  const upcoming = fixtures.filter((fixture) => {
    if (fixture.status !== 'SCHEDULED') return false;
    const kickoffMs = Date.parse(fixture.kickoff);
    if (Number.isNaN(kickoffMs)) return false;
    return kickoffMs >= nowMs && kickoffMs <= nowMs + UPCOMING_WINDOW_MS;
  });

  const byKickoffAsc = (a: Fixture, b: Fixture): number => Date.parse(a.kickoff) - Date.parse(b.kickoff);
  live.sort(byKickoffAsc);
  upcoming.sort(byKickoffAsc);

  const combined = window === 'live' ? live : window === 'upcoming' ? upcoming : [...live, ...upcoming];
  return combined.slice(0, MAX_FIXTURES);
}

export const registerCompetitionRoutes = (app: FastifyInstance, ctx: AppContext): void => {
  // Static config, straight from COMPETITION_CONFIGS — no provider call, so this is instant.
  app.get('/competitions', async (_request, reply) => reply.send({ competitions: allCompetitions() }));

  app.get('/competitions/:id/fixtures', async (request, reply) => {
    const parsedParams = competitionIdParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ error: { code: 'INVALID_PARAMS', message: parsedParams.error.message } });
    }
    const parsedQuery = fixturesQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({ error: { code: 'INVALID_QUERY', message: parsedQuery.error.message } });
    }

    const config = competitionConfigById(parsedParams.data.id);
    if (config === null) {
      return reply.code(400).send({
        error: { code: 'UNKNOWN_COMPETITION', message: `${parsedParams.data.id} is not a supported competition.` },
      });
    }
    const competitionId = asCompetitionId(config.id);
    const nowMs = Date.now();

    let result: Awaited<ReturnType<typeof ctx.footballData.getFixturesByCompetition>>;
    try {
      result = await ctx.fixtureListCache.get(competitionId, () =>
        ctx.footballData.getFixturesByCompetition(competitionId, {
          season: config.currentSeason,
          // The provider contract only guarantees "the six supported competitions' fixtures",
          // not "everything upcoming" — against ESPN in particular, an unbounded call returns
          // only a single day's scoreboard. Bound it explicitly to the documented 14-day
          // upcoming window so the list this endpoint filters from actually contains what
          // `selectRelevantFixtures` expects to find.
          //
          // `to` is one day short of the full window, not `nowMs + UPCOMING_WINDOW_MS`: `toDateOnly`
          // truncates to a calendar day, so `[today, today+14d]` is actually 15 calendar days
          // inclusive whenever `nowMs` isn't exactly midnight, and ESPN's own 14-day cap
          // (`ESPN_MAX_DATE_WINDOW_DAYS`) would then silently drop the last day rather than serve
          // it — a fixture kicking off on day 14 before the current time of day would vanish even
          // though `selectRelevantFixtures` would happily accept it.
          from: toDateOnly(nowMs),
          to: toDateOnly(nowMs + UPCOMING_WINDOW_MS - ONE_DAY_MS),
        }),
      );
    } catch (error) {
      // Providers are contractually never supposed to throw (everything is a `DataResult`), but a
      // bug or an unexpected upstream shape must still surface as a clean 503, never a raw 500 with
      // the exception's message leaking to the client.
      console.error(`[competitions] provider threw fetching fixtures for ${competitionId}:`, error);
      return reply.code(503).send({
        error: { code: 'DATA_UNAVAILABLE', message: `Could not load fixtures for ${config.name}.` },
      });
    }
    if (!result.ok) {
      console.error(
        `[competitions] provider returned an error fetching fixtures for ${competitionId}:`,
        result.error,
      );
      return reply.code(503).send({
        error: { code: 'DATA_UNAVAILABLE', message: `Could not load fixtures for ${config.name}.` },
      });
    }

    const selected = selectRelevantFixtures(result.value, parsedQuery.data.window, nowMs);
    return reply.send({ fixtures: selected.map(summarizeFixture) });
  });
};
