/**
 * Zod schemas for the ESPN public site API (`site.api.espn.com/apis/site/v2/sports/soccer/...`).
 *
 * The API is unofficial and undocumented, so these schemas are lenient by design: every object passes unknown keys
 * through, and almost every field is optional or nullable. Only the handful of fields without which a payload is
 * meaningless (an event id, a team id, a roster athlete id) are required. A harmless ESPN shape change therefore
 * degrades to `null` fields plus notes in the normalizer instead of an `INVALID_RESPONSE` failure.
 *
 * Nothing in this file is exported past the ESPN adapter.
 */

import { z } from 'zod';

const str = z.string().nullable().optional();
const num = z.number().nullable().optional();
const bool = z.boolean().nullable().optional();
/** ESPN sends some numbers as strings (`score: "2"`, `jersey: "13"`). */
const numOrStr = z.union([z.number(), z.string()]).nullable().optional();

export const espnTeamRefSchema = z
  .object({
    id: z.string(),
    displayName: str,
    shortDisplayName: str,
    name: str,
    abbreviation: str,
    location: str,
    logo: str,
    logos: z.array(z.object({ href: str }).passthrough()).nullable().optional(),
  })
  .passthrough();

const statusSchema = z
  .object({
    clock: num,
    displayClock: str,
    period: num,
    type: z
      .object({
        name: str,
        state: str,
        completed: bool,
        detail: str,
        shortDetail: str,
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const competitorSchema = z
  .object({
    id: str,
    homeAway: str,
    score: numOrStr,
    winner: bool,
    team: espnTeamRefSchema,
  })
  .passthrough();

const venueSchema = z
  .object({
    fullName: str,
    address: z.object({ city: str, country: str }).passthrough().nullable().optional(),
  })
  .passthrough();

const competitionSchema = z
  .object({
    id: str,
    date: str,
    status: statusSchema.nullable().optional(),
    venue: venueSchema.nullable().optional(),
    competitors: z.array(competitorSchema),
  })
  .passthrough();

export const espnScoreboardEventSchema = z
  .object({
    id: z.string(),
    date: z.string(),
    name: str,
    shortName: str,
    season: z.object({ year: num, slug: str }).passthrough().nullable().optional(),
    status: statusSchema.nullable().optional(),
    competitions: z.array(competitionSchema).min(1),
  })
  .passthrough();

export const espnScoreboardSchema = z
  .object({
    leagues: z
      .array(z.object({ slug: str, season: z.object({ year: num }).passthrough().nullable().optional() }).passthrough())
      .nullable()
      .optional(),
    events: z.array(espnScoreboardEventSchema),
  })
  .passthrough();

const statEntrySchema = z
  .object({
    name: str,
    abbreviation: str,
    value: num,
    displayValue: str,
  })
  .passthrough();

const athleteRefSchema = z
  .object({
    id: str,
    displayName: str,
    fullName: str,
  })
  .passthrough();

const participantSchema = z.object({ athlete: athleteRefSchema.nullable().optional() }).passthrough();

const clockSchema = z.object({ value: num, displayValue: str }).passthrough();

const playTypeSchema = z.object({ id: str, text: str, type: str }).passthrough();

export const espnKeyEventSchema = z
  .object({
    id: z.string(),
    type: playTypeSchema.nullable().optional(),
    text: str,
    shortText: str,
    period: z.object({ number: num }).passthrough().nullable().optional(),
    clock: clockSchema.nullable().optional(),
    team: z.object({ id: str, displayName: str }).passthrough().nullable().optional(),
    participants: z.array(participantSchema).nullable().optional(),
    scoringPlay: bool,
  })
  .passthrough();

export const espnCommentarySchema = z
  .object({
    sequence: num,
    text: str,
    time: clockSchema.nullable().optional(),
    play: z
      .object({
        id: z.string(),
        type: playTypeSchema.nullable().optional(),
        text: str,
        period: z.object({ number: num }).passthrough().nullable().optional(),
        clock: clockSchema.nullable().optional(),
        team: z.object({ id: str, displayName: str }).passthrough().nullable().optional(),
        participants: z.array(participantSchema).nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const rosterEntrySchema = z
  .object({
    starter: bool,
    active: bool,
    jersey: numOrStr,
    subbedIn: bool,
    subbedOut: bool,
    formationPlace: numOrStr,
    athlete: athleteRefSchema,
    position: z.object({ name: str, abbreviation: str }).passthrough().nullable().optional(),
    stats: z.array(statEntrySchema).nullable().optional(),
    plays: z
      .array(z.object({ clock: clockSchema.nullable().optional(), substitution: bool }).passthrough())
      .nullable()
      .optional(),
  })
  .passthrough();

const summaryRosterSchema = z
  .object({
    homeAway: str,
    formation: str,
    team: espnTeamRefSchema,
    roster: z.array(rosterEntrySchema).nullable().optional(),
  })
  .passthrough();

const boxscoreTeamSchema = z
  .object({
    team: espnTeamRefSchema,
    statistics: z.array(statEntrySchema).nullable().optional(),
  })
  .passthrough();

export const espnSummarySchema = z
  .object({
    header: z
      .object({
        id: str,
        season: z.object({ year: num, name: str }).passthrough().nullable().optional(),
        league: z.object({ slug: str }).passthrough().nullable().optional(),
        competitions: z.array(competitionSchema).min(1),
      })
      .passthrough(),
    gameInfo: z.object({ venue: venueSchema.nullable().optional() }).passthrough().nullable().optional(),
    boxscore: z.object({ teams: z.array(boxscoreTeamSchema).nullable().optional() }).passthrough().nullable().optional(),
    rosters: z.array(summaryRosterSchema).nullable().optional(),
    keyEvents: z.array(espnKeyEventSchema).nullable().optional(),
    commentary: z.array(espnCommentarySchema).nullable().optional(),
  })
  .passthrough();

export const espnTeamsSchema = z
  .object({
    sports: z
      .array(
        z
          .object({
            leagues: z
              .array(
                z
                  .object({
                    slug: str,
                    teams: z.array(z.object({ team: espnTeamRefSchema }).passthrough()).nullable().optional(),
                  })
                  .passthrough(),
              )
              .nullable()
              .optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
  })
  .passthrough();

const splitsSchema = z
  .object({
    categories: z
      .array(z.object({ name: str, stats: z.array(statEntrySchema).nullable().optional() }).passthrough())
      .nullable()
      .optional(),
  })
  .passthrough();

export const espnRosterAthleteSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    fullName: str,
    firstName: str,
    lastName: str,
    age: num,
    dateOfBirth: str,
    /** Inches. */
    height: num,
    citizenship: str,
    jersey: numOrStr,
    position: z.object({ name: str, abbreviation: str }).passthrough().nullable().optional(),
    headshot: z.object({ href: str }).passthrough().nullable().optional(),
    statistics: z.object({ splits: splitsSchema.nullable().optional() }).passthrough().nullable().optional(),
  })
  .passthrough();

export const espnRosterSchema = z
  .object({
    season: z.object({ year: num, displayName: str }).passthrough().nullable().optional(),
    team: z.object({ id: z.string(), displayName: str, abbreviation: str }).passthrough().nullable().optional(),
    athletes: z.array(espnRosterAthleteSchema),
  })
  .passthrough();

export const espnAthleteSchema = z
  .object({
    athlete: z
      .object({
        id: z.string(),
        displayName: z.string(),
        fullName: str,
        jersey: numOrStr,
        age: num,
        displayDOB: str,
        citizenship: str,
        position: z.object({ abbreviation: str }).passthrough().nullable().optional(),
        team: z.object({ id: str, displayName: str }).passthrough().nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type EspnScoreboard = z.infer<typeof espnScoreboardSchema>;
export type EspnScoreboardEvent = z.infer<typeof espnScoreboardEventSchema>;
export type EspnSummary = z.infer<typeof espnSummarySchema>;
export type EspnKeyEvent = z.infer<typeof espnKeyEventSchema>;
export type EspnCommentary = z.infer<typeof espnCommentarySchema>;
export type EspnTeams = z.infer<typeof espnTeamsSchema>;
export type EspnRoster = z.infer<typeof espnRosterSchema>;
export type EspnRosterAthlete = z.infer<typeof espnRosterAthleteSchema>;
export type EspnAthlete = z.infer<typeof espnAthleteSchema>;
export type EspnTeamRef = z.infer<typeof espnTeamRefSchema>;
export type EspnStatEntry = z.infer<typeof statEntrySchema>;
export type EspnSummaryRoster = z.infer<typeof summaryRosterSchema>;
