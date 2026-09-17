/**
 * Loads and indexes the recorded sample dataset.
 *
 * One `data/index.json` names the six competition files, the career file and the match timelines. Everything is
 * validated on load and then indexed by id so the `FixtureProvider` answers every query from memory in O(1).
 */

import type { z } from 'zod';

import { COMPETITIONS, competitionConfigByCode, toCompetition } from '../competitions.js';
import type { DataSource } from '../data-source.js';
import type {
  CareerEntry,
  Competition,
  CompetitionCode,
  CompetitionId,
  Fixture,
  FixtureId,
  FixtureLineups,
  FootballPlayerId,
  LiveMatchState,
  Player,
  PlayerProfile,
  PlayerSeasonStats,
  TeamId,
} from '../domain.js';
import type { DataResult } from '../result.js';
import { describeThrown, fail, ok } from '../result.js';
import type { RecordedMatchTimeline } from './recorded-schema.js';
import {
  careerDatasetSchema,
  competitionDatasetSchema,
  datasetIndexSchema,
  formatZodIssues,
  matchTimelineSchema,
} from './recorded-schema.js';

export interface RecordedDataset {
  readonly provenance: string;
  readonly competitions: readonly Competition[];
  readonly fixtures: readonly Fixture[];
  readonly players: readonly Player[];
  readonly seasonStats: readonly PlayerSeasonStats[];
  readonly lineupsByFixture: ReadonlyMap<string, FixtureLineups>;
  readonly liveByFixture: ReadonlyMap<string, LiveMatchState>;
  readonly playersById: ReadonlyMap<string, Player>;
  readonly playersByTeam: ReadonlyMap<string, readonly Player[]>;
  readonly fixturesById: ReadonlyMap<string, Fixture>;
  readonly careersByPlayer: ReadonlyMap<string, readonly CareerEntry[]>;
  readonly timelinesByFixture: ReadonlyMap<string, RecordedMatchTimeline>;
  /** Files that were listed but could not be read or validated. Surfaced as `DataQuality` notes. */
  readonly loadNotes: readonly string[];
}

export const DATASET_INDEX_FILE = 'index.json';

/** Read, validate and index the whole recorded dataset. Never throws; a bad file becomes a `DataResult` failure. */
export async function loadRecordedDataset(source: DataSource): Promise<DataResult<RecordedDataset>> {
  const indexResult = await readValidated(source, DATASET_INDEX_FILE, datasetIndexSchema);
  if (!indexResult.ok) return indexResult;
  const index = indexResult.value;

  const loadNotes: string[] = [];
  const competitions: Competition[] = [];
  const fixtures: Fixture[] = [];
  const players: Player[] = [];
  const seasonStats: PlayerSeasonStats[] = [];
  const lineupsByFixture = new Map<string, FixtureLineups>();
  const liveByFixture = new Map<string, LiveMatchState>();
  const playersById = new Map<string, Player>();
  const fixturesById = new Map<string, Fixture>();
  const seenCompetitionCodes = new Set<CompetitionCode>();

  for (const entry of index.competitions) {
    const fileResult = await readValidated(source, entry.file, competitionDatasetSchema);
    if (!fileResult.ok) {
      loadNotes.push(`Competition file ${entry.file} could not be loaded: ${fileResult.error.message}`);
      continue;
    }
    const dataset = fileResult.value;
    if (dataset.competitionCode !== entry.code) {
      loadNotes.push(
        `Competition file ${entry.file} declares ${dataset.competitionCode} but the index says ${entry.code}.`,
      );
      continue;
    }
    seenCompetitionCodes.add(dataset.competitionCode);
    competitions.push(toCompetition(competitionConfigByCode(dataset.competitionCode)));

    for (const player of dataset.players) {
      if (!playersById.has(player.id)) {
        playersById.set(player.id, player);
        players.push(player);
      }
    }
    seasonStats.push(...dataset.seasonStats);
    for (const fixture of dataset.fixtures) {
      if (fixturesById.has(fixture.id)) {
        loadNotes.push(`Duplicate fixture id ${fixture.id} in ${entry.file}; keeping the first.`);
        continue;
      }
      fixturesById.set(fixture.id, fixture);
      fixtures.push(fixture);
    }
    for (const lineup of dataset.lineups) {
      lineupsByFixture.set(lineup.fixtureId, lineup);
    }
    for (const live of dataset.liveStates) {
      const fixture = fixturesById.get(live.fixtureId);
      if (fixture === undefined) {
        loadNotes.push(`Live state in ${entry.file} references unknown fixture ${live.fixtureId}.`);
        continue;
      }
      liveByFixture.set(live.fixtureId, {
        fixture,
        events: live.events,
        teamStats: live.teamStats,
        playerStats: live.playerStats,
        updatedAt: live.updatedAt,
      });
    }
  }

  for (const code of Object.keys(COMPETITIONS) as CompetitionCode[]) {
    if (!seenCompetitionCodes.has(code)) {
      loadNotes.push(`Recorded dataset has no data for ${code}.`);
    }
  }

  const careersByPlayer = new Map<string, readonly CareerEntry[]>();
  const careerResult = await readValidated(source, index.careersFile, careerDatasetSchema);
  if (careerResult.ok) {
    for (const row of careerResult.value.careers) {
      careersByPlayer.set(row.playerId, row.entries);
    }
  } else {
    loadNotes.push(`Career file ${index.careersFile} could not be loaded: ${careerResult.error.message}`);
  }

  const timelinesByFixture = new Map<string, RecordedMatchTimeline>();
  for (const entry of index.timelines) {
    if (!(await source.exists(entry.file))) {
      loadNotes.push(`Timeline file ${entry.file} is listed in the index but missing.`);
      continue;
    }
    const timelineResult = await readValidated(source, entry.file, matchTimelineSchema);
    if (!timelineResult.ok) {
      loadNotes.push(`Timeline file ${entry.file} could not be loaded: ${timelineResult.error.message}`);
      continue;
    }
    timelinesByFixture.set(timelineResult.value.fixtureId, timelineResult.value);
  }

  if (fixtures.length === 0) {
    return fail('INVALID_RESPONSE', `recorded dataset at ${source.description} contains no fixtures`, {
      retryable: false,
    });
  }

  const playersByTeam = new Map<string, Player[]>();
  for (const player of players) {
    const bucket = playersByTeam.get(player.teamId);
    if (bucket === undefined) {
      playersByTeam.set(player.teamId, [player]);
    } else {
      bucket.push(player);
    }
  }

  fixtures.sort((left, right) => left.kickoff.localeCompare(right.kickoff));

  return ok(
    {
      provenance: index.provenance.description,
      competitions,
      fixtures,
      players,
      seasonStats,
      lineupsByFixture,
      liveByFixture,
      playersById,
      playersByTeam,
      fixturesById,
      careersByPlayer,
      timelinesByFixture,
      loadNotes,
    },
    loadNotes,
  );
}

/** Generic over the schema itself, so branded outputs of `z.transform` survive inference. */
async function readValidated<S extends z.ZodTypeAny>(
  source: DataSource,
  relativePath: string,
  schema: S,
): Promise<DataResult<z.infer<S>>> {
  let raw: unknown;
  try {
    raw = await source.read(relativePath);
  } catch (thrown) {
    return fail('NETWORK', `could not read ${relativePath} from ${source.description}: ${describeThrown(thrown)}`, {
      retryable: false,
    });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return fail('INVALID_RESPONSE', `${relativePath} is not valid recorded data — ${formatZodIssues(parsed.error)}`, {
      retryable: false,
    });
  }
  return ok(parsed.data);
}

/** Build a `PlayerProfile` from the indexed dataset. Returns null for an unknown player. */
export function profileFor(dataset: RecordedDataset, playerId: FootballPlayerId): PlayerProfile | null {
  const player = dataset.playersById.get(playerId);
  if (player === undefined) return null;
  return { player, career: dataset.careersByPlayer.get(playerId) ?? [] };
}

export function fixturesForCompetition(dataset: RecordedDataset, competitionId: CompetitionId): readonly Fixture[] {
  return dataset.fixtures.filter((fixture) => fixture.competitionId === competitionId);
}

export function squadFor(dataset: RecordedDataset, teamId: TeamId): readonly Player[] {
  return dataset.playersByTeam.get(teamId) ?? [];
}

export function lineupsFor(dataset: RecordedDataset, fixtureId: FixtureId): FixtureLineups | null {
  return dataset.lineupsByFixture.get(fixtureId) ?? null;
}
