/**
 * `GuessableStatFact` — one player, one number, ready for a "closest guess wins" round.
 *
 * Built for `G7` **Guess the Number** (a player and a stat — season goals, appearances, assists, minutes, age,
 * height or shirt number — everyone guesses the value, closest wins), but generic enough that any game wanting
 * "pick a number about a player" can use it without re-deriving it from raw `PlayerSeasonStats` rows.
 *
 * Two kinds of fact:
 * - **Bio facts** (age, height, shirt number) — one per player, not season-scoped (`season: null`).
 * - **Season facts** (goals, assists, appearances, minutes played, yellow cards) — one per
 *   `PlayerSeasonStats` row, so a player who appears in two competitions (e.g. league + UEFA Champions League)
 *   contributes one fact per competition, each correctly labelled with its own season and competition.
 *
 * A metric is only produced when the source value is present — a season-stat row's `null` fields (this package
 * does not fabricate a number for a game to guess) and a player's `null` bio fields are simply skipped.
 */

import type {
  CompetitionId,
  FootballPlayerId,
  Player,
  PlayerSeasonStats,
  SeasonId,
  Team,
  TeamId,
} from './domain.js';

export type GuessableStatMetric =
  | 'GOALS'
  | 'ASSISTS'
  | 'APPEARANCES'
  | 'MINUTES_PLAYED'
  | 'YELLOW_CARDS'
  | 'AGE'
  | 'HEIGHT_CM'
  | 'SHIRT_NUMBER';

/** Bio metrics apply to the player as they are now; season metrics belong to one competition and season. */
export const BIO_GUESSABLE_METRICS: readonly GuessableStatMetric[] = ['AGE', 'HEIGHT_CM', 'SHIRT_NUMBER'];
export const SEASON_GUESSABLE_METRICS: readonly GuessableStatMetric[] = [
  'GOALS',
  'ASSISTS',
  'APPEARANCES',
  'MINUTES_PLAYED',
  'YELLOW_CARDS',
];

export type GuessableStatUnit = 'goals' | 'assists' | 'appearances' | 'minutes' | 'cards' | 'years' | 'cm' | 'number';

const METRIC_UNIT: Readonly<Record<GuessableStatMetric, GuessableStatUnit>> = {
  GOALS: 'goals',
  ASSISTS: 'assists',
  APPEARANCES: 'appearances',
  MINUTES_PLAYED: 'minutes',
  YELLOW_CARDS: 'cards',
  AGE: 'years',
  HEIGHT_CM: 'cm',
  SHIRT_NUMBER: 'number',
};

/** Host-facing label for the round prompt, e.g. "season goals". */
export const METRIC_LABEL: Readonly<Record<GuessableStatMetric, string>> = {
  GOALS: 'season goals',
  ASSISTS: 'season assists',
  APPEARANCES: 'season appearances',
  MINUTES_PLAYED: 'minutes played this season',
  YELLOW_CARDS: 'yellow cards this season',
  AGE: 'age',
  HEIGHT_CM: 'height in centimetres',
  SHIRT_NUMBER: 'shirt number',
};

export interface GuessableStatFact {
  readonly playerId: FootballPlayerId;
  readonly playerName: string;
  readonly teamId: TeamId;
  readonly teamName: string;
  readonly metric: GuessableStatMetric;
  readonly value: number;
  readonly unit: GuessableStatUnit;
  /** `null` for a bio fact; the season a season-stat fact was recorded in otherwise. */
  readonly season: SeasonId | null;
  readonly competitionId: CompetitionId | null;
}

function teamName(teams: ReadonlyMap<string, Team>, teamId: TeamId): string {
  return teams.get(teamId)?.name ?? `Team ${teamId}`;
}

/** Bio facts (age, height, shirt number) for every player that actually has the field. */
export function buildBioGuessableStats(
  players: readonly Player[],
  teams: ReadonlyMap<string, Team>,
): readonly GuessableStatFact[] {
  const facts: GuessableStatFact[] = [];
  for (const player of players) {
    const base = {
      playerId: player.id,
      playerName: player.name,
      teamId: player.teamId,
      teamName: teamName(teams, player.teamId),
      season: null,
      competitionId: null,
    } as const;
    if (player.age !== null) facts.push({ ...base, metric: 'AGE', value: player.age, unit: METRIC_UNIT.AGE });
    if (player.heightCm !== null) {
      facts.push({ ...base, metric: 'HEIGHT_CM', value: player.heightCm, unit: METRIC_UNIT.HEIGHT_CM });
    }
    if (player.shirtNumber !== null) {
      facts.push({ ...base, metric: 'SHIRT_NUMBER', value: player.shirtNumber, unit: METRIC_UNIT.SHIRT_NUMBER });
    }
  }
  return facts;
}

/** Season facts (goals, assists, appearances, minutes, yellow cards) for every stats row. */
export function buildSeasonGuessableStats(
  seasonStats: readonly PlayerSeasonStats[],
  players: ReadonlyMap<string, Player>,
  teams: ReadonlyMap<string, Team>,
): readonly GuessableStatFact[] {
  const facts: GuessableStatFact[] = [];
  for (const row of seasonStats) {
    const player = players.get(row.playerId);
    const base = {
      playerId: row.playerId,
      playerName: player?.name ?? `Player ${row.playerId}`,
      teamId: row.teamId,
      teamName: teamName(teams, row.teamId),
      season: row.season,
      competitionId: row.competitionId,
    } as const;
    facts.push({ ...base, metric: 'GOALS', value: row.goals, unit: METRIC_UNIT.GOALS });
    facts.push({ ...base, metric: 'ASSISTS', value: row.assists, unit: METRIC_UNIT.ASSISTS });
    facts.push({ ...base, metric: 'APPEARANCES', value: row.appearances, unit: METRIC_UNIT.APPEARANCES });
    facts.push({ ...base, metric: 'MINUTES_PLAYED', value: row.minutesPlayed, unit: METRIC_UNIT.MINUTES_PLAYED });
    facts.push({ ...base, metric: 'YELLOW_CARDS', value: row.yellowCards, unit: METRIC_UNIT.YELLOW_CARDS });
  }
  return facts;
}

/** All guessable facts — bio plus season — for a player pool. */
export function buildGuessableStats(
  players: readonly Player[],
  seasonStats: readonly PlayerSeasonStats[],
  teams: readonly Team[],
): readonly GuessableStatFact[] {
  const teamsById = new Map(teams.map((team) => [team.id, team]));
  const playersById = new Map(players.map((player) => [player.id, player]));
  return [
    ...buildBioGuessableStats(players, teamsById),
    ...buildSeasonGuessableStats(seasonStats, playersById, teamsById),
  ];
}

export function groupGuessableStatsByPlayer(
  facts: readonly GuessableStatFact[],
): ReadonlyMap<string, readonly GuessableStatFact[]> {
  const byPlayer = new Map<string, GuessableStatFact[]>();
  for (const fact of facts) {
    const bucket = byPlayer.get(fact.playerId);
    if (bucket === undefined) byPlayer.set(fact.playerId, [fact]);
    else bucket.push(fact);
  }
  return byPlayer;
}
