/**
 * Zod schemas for the recorded sample data in `packages/football-data/data/`.
 *
 * The recorded files are written in the normalized domain shape on purpose: they are a *recording*, not a second
 * provider format. Validating them on load means a hand-edited file fails fast with a path, rather than producing
 * a broken round three screens later.
 */

import { z } from 'zod';

import type {
  CompetitionCode,
  CompetitionId,
  FixtureId,
  FootballPlayerId,
  SeasonId,
  TeamId,
} from '../domain.js';
import { asCompetitionId, asFixtureId, asFootballPlayerId, asSeasonId, asTeamId } from '../domain.js';

const competitionId = z.string().min(1).transform<CompetitionId>(asCompetitionId);
const seasonId = z.string().min(1).transform<SeasonId>(asSeasonId);
const teamId = z.string().min(1).transform<TeamId>(asTeamId);
const fixtureId = z.string().min(1).transform<FixtureId>(asFixtureId);
const playerId = z.string().min(1).transform<FootballPlayerId>(asFootballPlayerId);

const COMPETITION_CODE_VALUES = [
  'PREMIER_LEAGUE',
  'LA_LIGA',
  'SERIE_A',
  'BUNDESLIGA',
  'LIGUE_1',
  'CHAMPIONS_LEAGUE',
] as const satisfies readonly CompetitionCode[];

const competitionCode = z.enum(COMPETITION_CODE_VALUES);

const position = z.enum(['GK', 'DF', 'MF', 'FW', 'UNKNOWN']);

const fixtureStatus = z.enum([
  'SCHEDULED',
  'LIVE',
  'HALF_TIME',
  'EXTRA_TIME',
  'PENALTIES',
  'FINISHED',
  'POSTPONED',
  'CANCELLED',
]);

const matchEventType = z.enum([
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
]);

const scoreSchema = z.object({ home: z.number().int(), away: z.number().int() });

export const teamSchema = z.object({
  id: teamId,
  name: z.string().min(1),
  shortName: z.string().min(1),
  crestUrl: z.string().nullable(),
  country: z.string().nullable(),
});

export const playerSchema = z.object({
  id: playerId,
  name: z.string().min(1),
  fullName: z.string().nullable(),
  nationality: z.string().nullable(),
  dateOfBirth: z.string().nullable(),
  age: z.number().int().nullable(),
  heightCm: z.number().int().nullable(),
  position,
  shirtNumber: z.number().int().nullable(),
  teamId,
  photoUrl: z.string().nullable(),
  marketValueEur: z.number().nullable(),
});

export const playerSeasonStatsSchema = z.object({
  playerId,
  teamId,
  competitionId,
  season: seasonId,
  appearances: z.number().int(),
  minutesPlayed: z.number().int(),
  goals: z.number().int(),
  assists: z.number().int(),
  yellowCards: z.number().int(),
  redCards: z.number().int(),
  shots: z.number().int().nullable(),
  shotsOnTarget: z.number().int().nullable(),
  passAccuracy: z.number().nullable(),
  tackles: z.number().int().nullable(),
  rating: z.number().nullable(),
});

export const fixtureSchema = z.object({
  id: fixtureId,
  competitionId,
  season: seasonId,
  kickoff: z.string().min(1),
  status: fixtureStatus,
  minute: z.number().int().nullable(),
  homeTeam: teamSchema,
  awayTeam: teamSchema,
  score: scoreSchema.nullable(),
  halfTimeScore: scoreSchema.nullable(),
  venue: z.string().nullable(),
  round: z.string().nullable(),
});

const lineupPlayerSchema = z.object({
  playerId,
  name: z.string().min(1),
  shirtNumber: z.number().int().nullable(),
  position,
  gridPosition: z.string().nullable(),
  isStarter: z.boolean(),
});

const teamLineupSchema = z.object({
  teamId,
  formation: z.string().nullable(),
  coachName: z.string().nullable(),
  startingXI: z.array(lineupPlayerSchema),
  substitutes: z.array(lineupPlayerSchema),
});

export const fixtureLineupsSchema = z.object({
  fixtureId,
  home: teamLineupSchema,
  away: teamLineupSchema,
  confirmed: z.boolean(),
});

export const matchEventSchema = z.object({
  id: z.string().min(1),
  fixtureId,
  type: matchEventType,
  minute: z.number().int(),
  extraMinute: z.number().int().nullable(),
  teamId: teamId.nullable(),
  playerId: playerId.nullable(),
  playerName: z.string().nullable(),
  relatedPlayerId: playerId.nullable(),
  detail: z.string().nullable(),
});

export const teamMatchStatsSchema = z.object({
  teamId,
  possession: z.number().nullable(),
  shots: z.number().int().nullable(),
  shotsOnTarget: z.number().int().nullable(),
  corners: z.number().int().nullable(),
  offsides: z.number().int().nullable(),
  fouls: z.number().int().nullable(),
  yellowCards: z.number().int().nullable(),
  redCards: z.number().int().nullable(),
  passes: z.number().int().nullable(),
  passAccuracy: z.number().nullable(),
});

export const playerMatchStatsSchema = z.object({
  playerId,
  teamId,
  minutesPlayed: z.number().int().nullable(),
  goals: z.number().int(),
  assists: z.number().int(),
  shots: z.number().int().nullable(),
  shotsOnTarget: z.number().int().nullable(),
  passes: z.number().int().nullable(),
  passAccuracy: z.number().nullable(),
  tackles: z.number().int().nullable(),
  duelsWon: z.number().int().nullable(),
  foulsCommitted: z.number().int().nullable(),
  rating: z.number().nullable(),
});

export const liveStateSchema = z.object({
  fixtureId,
  updatedAt: z.string().min(1),
  events: z.array(matchEventSchema),
  teamStats: z.array(teamMatchStatsSchema),
  playerStats: z.array(playerMatchStatsSchema),
});

const careerEntrySchema = z.object({
  teamId: teamId.nullable(),
  teamName: z.string().min(1),
  fromSeason: z.string().min(1),
  toSeason: z.string().nullable(),
  appearances: z.number().int().nullable(),
  goals: z.number().int().nullable(),
});

/** Provenance block every recorded file carries, so nobody mistakes the sample data for a live feed. */
const provenanceSchema = z.object({
  kind: z.literal('recorded-sample-data'),
  description: z.string().min(1),
  recordedAt: z.string().min(1),
  disclaimer: z.string().min(1),
});

export const competitionDatasetSchema = z.object({
  provenance: provenanceSchema,
  competitionCode,
  season: seasonId,
  teams: z.array(teamSchema).min(1),
  players: z.array(playerSchema).min(1),
  seasonStats: z.array(playerSeasonStatsSchema),
  fixtures: z.array(fixtureSchema).min(1),
  lineups: z.array(fixtureLineupsSchema),
  liveStates: z.array(liveStateSchema),
});

export const careerDatasetSchema = z.object({
  provenance: provenanceSchema,
  careers: z.array(
    z.object({
      playerId,
      entries: z.array(careerEntrySchema),
    }),
  ),
});

export const matchTimelineSchema = z.object({
  provenance: provenanceSchema,
  fixtureId,
  competitionCode,
  /** Length of normal time in minutes, excluding stoppage. */
  regulationMinutes: z.number().int().positive(),
  /** Minute the second half restarts on, so half-time has a real duration. */
  secondHalfStartMinute: z.number().int().positive(),
  events: z.array(matchEventSchema).min(1),
  finalTeamStats: z.array(teamMatchStatsSchema).length(2),
  finalPlayerStats: z.array(playerMatchStatsSchema).min(1),
});

export const datasetIndexSchema = z.object({
  provenance: provenanceSchema,
  version: z.literal(1),
  competitions: z
    .array(
      z.object({
        code: competitionCode,
        file: z.string().min(1),
      }),
    )
    .min(1),
  careersFile: z.string().min(1),
  timelines: z.array(z.object({ fixtureId, file: z.string().min(1) })),
});

export type RecordedCompetitionDataset = z.infer<typeof competitionDatasetSchema>;
export type RecordedCareerDataset = z.infer<typeof careerDatasetSchema>;
export type RecordedMatchTimeline = z.infer<typeof matchTimelineSchema>;
export type RecordedDatasetIndex = z.infer<typeof datasetIndexSchema>;

/** Flatten Zod issues into one readable line with paths, for a `DataError` message. */
export function formatZodIssues(error: z.ZodError, limit = 5): string {
  return error.issues
    .slice(0, limit)
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}
