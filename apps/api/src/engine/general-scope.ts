/**
 * Scopes the process-wide `GeneralDataset` down to one competition, for a general room whose host
 * picked `generalCompetitionId` (see `rooms/store.ts`'s `RoomMeta` and `rooms/schemas.ts`). Leaving
 * it unset keeps today's behaviour byte-for-byte: `buildRoundDataContext`'s `general` branch only
 * ever calls into this module when a scope was actually requested.
 *
 * This is a pure in-memory filter of the dataset `ctx.generalDataset()` already built/cached —
 * never a re-fetch, never a rebuild, and never anything written back to `@fdg/football-data` (that
 * package stays untouched; filtering a shared cached resource per room is an apps/api concern, the
 * same shape of problem `matchday-cache.ts`/`gameday-cache.ts` already solve for matchday rooms).
 *
 * One wrinkle worth documenting: `Team` (unlike `PlayerSeasonStats`, `SeasonLeaderboard` and
 * `GuessableStatFact`) carries no `competitionId` of its own — a team's competition is only ever
 * recoverable by joining through something that *does* carry one. `PlayerSeasonStats` rows are the
 * most complete source of that join (every team the general dataset cares about has stats rows;
 * `SeasonLeaderboard` entries are used as a fallback for the rare team that doesn't). Once teams are
 * resolved to a competition this way, players and profiles fall out by `player.teamId` membership,
 * exactly as the task's "join through its team" framing describes.
 */

import type {
  CompetitionId,
  GeneralDataset,
  GuessableStatFact,
  Player,
  PlayerProfile,
  PlayerSeasonStats,
  SeasonLeaderboard,
  Team,
} from '@fdg/football-data';
import { assessGeneralDataQuality, evaluateGameAvailability, groupGuessableStatsByPlayer } from '@fdg/football-data';

const groupStatsByPlayer = (rows: readonly PlayerSeasonStats[]): ReadonlyMap<string, readonly PlayerSeasonStats[]> => {
  const byPlayer = new Map<string, PlayerSeasonStats[]>();
  for (const row of rows) {
    const bucket = byPlayer.get(row.playerId);
    if (bucket === undefined) byPlayer.set(row.playerId, [row]);
    else bucket.push(row);
  }
  return byPlayer;
};

/**
 * `teamId -> Set<competitionId>`, derived from whatever already carries both — never from `Team`
 * itself. A team can legitimately appear in multiple competitions at once (e.g. a domestic league
 * plus the Champions League), so every competition a team has `PlayerSeasonStats` rows in is kept —
 * not just the first one encountered. `SeasonLeaderboard` entries are only consulted as a fallback,
 * and only for a team that has NO stats rows at all.
 */
const resolveTeamCompetitions = (dataset: GeneralDataset): ReadonlyMap<string, ReadonlySet<CompetitionId>> => {
  const byTeam = new Map<string, Set<CompetitionId>>();
  for (const row of dataset.seasonStats) {
    let bucket = byTeam.get(row.teamId);
    if (bucket === undefined) {
      bucket = new Set();
      byTeam.set(row.teamId, bucket);
    }
    bucket.add(row.competitionId);
  }
  for (const board of dataset.leaderboards) {
    for (const entry of board.entries) {
      if (!byTeam.has(entry.teamId)) byTeam.set(entry.teamId, new Set([board.competitionId]));
    }
  }
  return byTeam;
};

/**
 * Recompute every derived field the same way `@fdg/football-data`'s own dataset assembly does
 * (`general-dataset-core.ts`'s `assembleGeneralDataset`, not exported publicly — this is the
 * "minimal grouping logic directly here" fallback the task calls for), plus `quality`/
 * `gameAvailability`, recomputed from the *filtered* slice so a thin competition correctly shows up
 * as thin (e.g. too few profiled careers disables G1/G3 for this room even though the combined
 * dataset would show them as playable).
 */
const assemble = (source: {
  readonly builtAt: string;
  readonly competitions: GeneralDataset['competitions'];
  readonly teams: readonly Team[];
  readonly players: readonly Player[];
  readonly seasonStats: readonly PlayerSeasonStats[];
  readonly profiles: readonly PlayerProfile[];
  readonly leaderboards: readonly SeasonLeaderboard[];
  readonly guessableStats: readonly GuessableStatFact[];
}): GeneralDataset => {
  const quality = assessGeneralDataQuality({
    players: source.players,
    seasonStats: source.seasonStats,
    profiles: source.profiles,
  });
  return {
    ...source,
    quality,
    gameAvailability: evaluateGameAvailability(quality),
    playersById: new Map(source.players.map((player) => [player.id, player])),
    statsByPlayer: groupStatsByPlayer(source.seasonStats),
    profilesByPlayer: new Map(source.profiles.map((profile) => [profile.player.id, profile])),
    guessableStatsByPlayer: groupGuessableStatsByPlayer(source.guessableStats),
  };
};

const scope = (dataset: GeneralDataset, competitionId: CompetitionId): GeneralDataset => {
  const teamCompetitions = resolveTeamCompetitions(dataset);
  const teams = dataset.teams.filter((team) => teamCompetitions.get(team.id)?.has(competitionId) === true);
  const teamIds = new Set(teams.map((team) => team.id));

  const players = dataset.players.filter((player) => teamIds.has(player.teamId));
  const playerIds = new Set(players.map((player) => player.id));

  const seasonStats = dataset.seasonStats.filter((row) => row.competitionId === competitionId);
  const profiles = dataset.profiles.filter((profile) => teamIds.has(profile.player.teamId));
  const leaderboards = dataset.leaderboards.filter((board) => board.competitionId === competitionId);
  const guessableStats = dataset.guessableStats.filter((fact) =>
    fact.competitionId === null ? playerIds.has(fact.playerId) : fact.competitionId === competitionId,
  );
  const competitions = dataset.competitions.filter((competition) => competition.id === competitionId);

  return assemble({
    builtAt: dataset.builtAt,
    competitions,
    teams,
    players,
    seasonStats,
    profiles,
    leaderboards,
    guessableStats,
  });
};

/**
 * Per-competition cache of the scoped view, keyed off the source `GeneralDataset` object identity
 * (a `WeakMap` so it is dropped for free once that dataset is superseded by a rebuild/refresh —
 * `createGeneralDatasetLoader` swaps in a brand-new object on every successful refresh, never
 * mutates in place). Cheap in-memory filtering does not need per-room state or rotation/pinning —
 * unlike `gameday-cache.ts`, there is nothing here that drifts between dispatches, so one cache
 * entry per (dataset, competitionId) is shared safely across every room scoped to that competition,
 * and never crosses over to a different competitionId's rooms.
 */
const cache = new WeakMap<GeneralDataset, Map<CompetitionId, GeneralDataset>>();

/** The dataset scoped to `competitionId`, built once per (dataset, competitionId) and cached. */
export const getScopedGeneralDataset = (dataset: GeneralDataset, competitionId: CompetitionId): GeneralDataset => {
  let byCompetition = cache.get(dataset);
  if (byCompetition === undefined) {
    byCompetition = new Map();
    cache.set(dataset, byCompetition);
  }
  const existing = byCompetition.get(competitionId);
  if (existing !== undefined) return existing;

  const scoped = scope(dataset, competitionId);
  byCompetition.set(competitionId, scoped);
  return scoped;
};
