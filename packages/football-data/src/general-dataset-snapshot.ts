/**
 * Persistable form of `GeneralDataset`.
 *
 * A snapshot is plain JSON (no Maps) in a versioned envelope, so a scheduled sync job can build the dataset once,
 * store it (Postgres, a file, anything behind `GeneralDatasetStore`) and a server can load it at startup without
 * touching the upstream sources. Derived fields are never stored: `hydrateGeneralDataset` recomputes them with the
 * same helper the live builder uses. Hydration validates the whole payload and never throws.
 */

import { z } from 'zod';

import type { DataClock } from './clock.js';
import type { GeneralDataset, GeneralDatasetSource } from './general-dataset-core.js';
import { assembleGeneralDataset } from './general-dataset-core.js';
import {
  asCompetitionId,
  asFootballPlayerId,
  asSeasonId,
  asTeamId,
  type Competition,
  type DataQuality,
  type Player,
  type PlayerProfile,
  type PlayerSeasonStats,
  type SeasonLeaderboard,
  type Team,
} from './domain.js';
import type { GuessableStatFact } from './guessable-stats.js';
import type { DataResult } from './result.js';
import { fail, ok } from './result.js';

export const GENERAL_DATASET_SCHEMA_VERSION = 1;

export interface GeneralDatasetSnapshot {
  readonly schemaVersion: typeof GENERAL_DATASET_SCHEMA_VERSION;
  readonly builtAt: string;
  readonly competitions: readonly Competition[];
  readonly teams: readonly Team[];
  readonly players: readonly Player[];
  readonly seasonStats: readonly PlayerSeasonStats[];
  readonly profiles: readonly PlayerProfile[];
  readonly leaderboards: readonly SeasonLeaderboard[];
  readonly guessableStats: readonly GuessableStatFact[];
  readonly quality: DataQuality;
}

/** Metadata handed to the store on write. */
export interface GeneralDatasetStoreWriteMeta {
  readonly builtAt: string;
  readonly playerCount: number;
}

/** Storage port; the Prisma/Postgres implementation lives in the API app. */
export interface GeneralDatasetStore {
  /** The latest stored snapshot (unvalidated JSON) and when it was saved, or `null` when nothing is stored. */
  read(): Promise<{ snapshot: unknown; savedAt: string } | null>;
  write(snapshot: GeneralDatasetSnapshot, meta: GeneralDatasetStoreWriteMeta): Promise<void>;
}

export function serializeGeneralDataset(dataset: GeneralDataset): GeneralDatasetSnapshot {
  return {
    schemaVersion: GENERAL_DATASET_SCHEMA_VERSION,
    builtAt: dataset.builtAt,
    competitions: dataset.competitions,
    teams: dataset.teams,
    players: dataset.players,
    seasonStats: dataset.seasonStats,
    profiles: dataset.profiles,
    leaderboards: dataset.leaderboards,
    guessableStats: dataset.guessableStats,
    quality: dataset.quality,
  };
}

const competitionId = z.string().transform(asCompetitionId);
const seasonId = z.string().transform(asSeasonId);
const teamId = z.string().transform(asTeamId);
const playerId = z.string().transform(asFootballPlayerId);
const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();

const competitionSchema = z.object({
  id: competitionId,
  code: z.enum(['PREMIER_LEAGUE', 'LA_LIGA', 'SERIE_A', 'BUNDESLIGA', 'LIGUE_1', 'CHAMPIONS_LEAGUE']),
  name: z.string(),
  country: z.string(),
  logoUrl: nullableString,
  currentSeason: seasonId,
});

const teamSchema = z.object({
  id: teamId,
  name: z.string(),
  shortName: z.string(),
  crestUrl: nullableString,
  country: nullableString,
});

const playerSchema = z.object({
  id: playerId,
  name: z.string(),
  fullName: nullableString,
  nationality: nullableString,
  dateOfBirth: nullableString,
  age: nullableNumber,
  heightCm: nullableNumber,
  position: z.enum(['GK', 'DF', 'MF', 'FW', 'UNKNOWN']),
  shirtNumber: nullableNumber,
  teamId,
  photoUrl: nullableString,
  marketValueEur: nullableNumber,
});

const seasonStatsSchema = z.object({
  playerId,
  teamId,
  competitionId,
  season: seasonId,
  appearances: z.number(),
  minutesPlayed: z.number(),
  goals: z.number(),
  assists: z.number(),
  yellowCards: z.number(),
  redCards: z.number(),
  shots: nullableNumber,
  shotsOnTarget: nullableNumber,
  passAccuracy: nullableNumber,
  tackles: nullableNumber,
  rating: nullableNumber,
});

const careerEntrySchema = z.object({
  teamId: teamId.nullable(),
  teamName: z.string(),
  fromSeason: z.string(),
  toSeason: nullableString,
  appearances: nullableNumber,
  goals: nullableNumber,
});

const profileSchema = z.object({ player: playerSchema, career: z.array(careerEntrySchema) });

const leaderboardSchema = z.object({
  competitionId,
  season: seasonId,
  metric: z.enum(['GOALS', 'ASSISTS', 'APPEARANCES', 'MINUTES_PLAYED', 'YELLOW_CARDS', 'RATING']),
  entries: z.array(
    z.object({
      rank: z.number(),
      playerId,
      playerName: z.string(),
      teamId,
      teamName: z.string(),
      value: z.number(),
    }),
  ),
});

const guessableStatSchema = z.object({
  playerId,
  playerName: z.string(),
  teamId,
  teamName: z.string(),
  metric: z.enum([
    'GOALS',
    'ASSISTS',
    'APPEARANCES',
    'MINUTES_PLAYED',
    'YELLOW_CARDS',
    'AGE',
    'HEIGHT_CM',
    'SHIRT_NUMBER',
  ]),
  value: z.number(),
  unit: z.enum(['goals', 'assists', 'appearances', 'minutes', 'cards', 'years', 'cm', 'number']),
  season: seasonId.nullable(),
  competitionId: competitionId.nullable(),
});

const qualitySchema = z.object({
  hasLineups: z.boolean(),
  hasShirtNumbers: z.boolean(),
  hasLiveEvents: z.boolean(),
  hasPlayerMatchStats: z.boolean(),
  hasPlayerSeasonStats: z.boolean(),
  hasMarketValues: z.boolean(),
  hasCareerHistory: z.boolean(),
  notes: z.array(z.string()),
});

export const generalDatasetSnapshotSchema = z.object({
  schemaVersion: z.literal(GENERAL_DATASET_SCHEMA_VERSION),
  builtAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'builtAt must be an ISO timestamp'),
  competitions: z.array(competitionSchema),
  teams: z.array(teamSchema),
  players: z.array(playerSchema),
  seasonStats: z.array(seasonStatsSchema),
  profiles: z.array(profileSchema),
  leaderboards: z.array(leaderboardSchema),
  guessableStats: z.array(guessableStatSchema),
  quality: qualitySchema,
});

/** Validate an untrusted snapshot and rebuild the full dataset. Never throws. */
export function hydrateGeneralDataset(snapshot: unknown): DataResult<GeneralDataset> {
  try {
    if (typeof snapshot !== 'object' || snapshot === null) {
      return fail('INVALID_RESPONSE', 'general dataset snapshot is not an object', { retryable: false });
    }
    const version = (snapshot as { schemaVersion?: unknown }).schemaVersion;
    if (version !== GENERAL_DATASET_SCHEMA_VERSION) {
      return fail(
        'INVALID_RESPONSE',
        `unsupported general dataset snapshot schemaVersion ${JSON.stringify(version) ?? 'undefined'}`,
        { retryable: false },
      );
    }
    const parsed = generalDatasetSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue === undefined ? '' : ` at ${issue.path.join('.') || '(root)'}: ${issue.message}`;
      return fail('INVALID_RESPONSE', `malformed general dataset snapshot${where}`, { retryable: false });
    }
    const { schemaVersion: _version, ...rest } = parsed.data;
    const source: GeneralDatasetSource = rest;
    return ok(assembleGeneralDataset(source), source.quality.notes);
  } catch (thrown) {
    return fail('INVALID_RESPONSE', `could not hydrate general dataset snapshot: ${String(thrown)}`, {
      retryable: false,
    });
  }
}

/** Whether a dataset built at `builtAt` is still within `maxAgeMs`. An unparseable timestamp is never fresh. */
export function isSnapshotFresh(builtAt: string, maxAgeMs: number, clock: DataClock): boolean {
  const built = Date.parse(builtAt);
  if (Number.isNaN(built)) return false;
  return clock.now() - built <= maxAgeMs;
}
