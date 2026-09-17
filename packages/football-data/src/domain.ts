/**
 * Normalized football domain types.
 *
 * This file is the contract between the data layer and the game engine. Provider-specific response shapes
 * (API-Football, etc.) are mapped into these types inside an adapter and never escape it.
 *
 * `game-core` imports from here **type-only**, which keeps the engine platform-agnostic.
 */

/** Branded ids so a fixture id can never be passed where a team id is expected. */
export type CompetitionId = string & { readonly __brand: 'CompetitionId' };
export type SeasonId = string & { readonly __brand: 'SeasonId' };
export type TeamId = string & { readonly __brand: 'TeamId' };
export type FixtureId = string & { readonly __brand: 'FixtureId' };
export type FootballPlayerId = string & { readonly __brand: 'FootballPlayerId' };

export const asCompetitionId = (value: string): CompetitionId => value as CompetitionId;
export const asSeasonId = (value: string): SeasonId => value as SeasonId;
export const asTeamId = (value: string): TeamId => value as TeamId;
export const asFixtureId = (value: string): FixtureId => value as FixtureId;
export const asFootballPlayerId = (value: string): FootballPlayerId => value as FootballPlayerId;

/** The six competitions the app supports. */
export type CompetitionCode =
  | 'PREMIER_LEAGUE'
  | 'LA_LIGA'
  | 'SERIE_A'
  | 'BUNDESLIGA'
  | 'LIGUE_1'
  | 'CHAMPIONS_LEAGUE';

export interface Competition {
  readonly id: CompetitionId;
  readonly code: CompetitionCode;
  readonly name: string;
  readonly country: string;
  readonly logoUrl: string | null;
  readonly currentSeason: SeasonId;
}

export interface Team {
  readonly id: TeamId;
  readonly name: string;
  readonly shortName: string;
  readonly crestUrl: string | null;
  readonly country: string | null;
}

export type FixtureStatus =
  | 'SCHEDULED'
  | 'LIVE'
  | 'HALF_TIME'
  | 'EXTRA_TIME'
  | 'PENALTIES'
  | 'FINISHED'
  | 'POSTPONED'
  | 'CANCELLED';

export interface Score {
  readonly home: number;
  readonly away: number;
}

export interface Fixture {
  readonly id: FixtureId;
  readonly competitionId: CompetitionId;
  readonly season: SeasonId;
  readonly kickoff: string; // ISO 8601 UTC
  readonly status: FixtureStatus;
  /** Minutes played, null before kickoff and after the final whistle. */
  readonly minute: number | null;
  readonly homeTeam: Team;
  readonly awayTeam: Team;
  readonly score: Score | null;
  readonly halfTimeScore: Score | null;
  readonly venue: string | null;
  readonly round: string | null;
}

export type PlayerPosition = 'GK' | 'DF' | 'MF' | 'FW' | 'UNKNOWN';

export interface Player {
  readonly id: FootballPlayerId;
  readonly name: string;
  readonly fullName: string | null;
  readonly nationality: string | null;
  readonly dateOfBirth: string | null; // ISO date
  readonly age: number | null;
  readonly heightCm: number | null;
  readonly position: PlayerPosition;
  readonly shirtNumber: number | null;
  readonly teamId: TeamId;
  readonly photoUrl: string | null;
  readonly marketValueEur: number | null;
}

export interface PlayerSeasonStats {
  readonly playerId: FootballPlayerId;
  readonly teamId: TeamId;
  readonly competitionId: CompetitionId;
  readonly season: SeasonId;
  readonly appearances: number;
  readonly minutesPlayed: number;
  readonly goals: number;
  readonly assists: number;
  readonly yellowCards: number;
  readonly redCards: number;
  readonly shots: number | null;
  readonly shotsOnTarget: number | null;
  readonly passAccuracy: number | null; // percent 0-100
  readonly tackles: number | null;
  readonly rating: number | null;
}

/** A career step, used by the Career Path game. */
export interface CareerEntry {
  readonly teamId: TeamId | null;
  readonly teamName: string;
  readonly fromSeason: string;
  readonly toSeason: string | null;
  readonly appearances: number | null;
  readonly goals: number | null;
}

export interface PlayerProfile {
  readonly player: Player;
  readonly career: readonly CareerEntry[];
}

export interface LineupPlayer {
  readonly playerId: FootballPlayerId;
  readonly name: string;
  readonly shirtNumber: number | null;
  readonly position: PlayerPosition;
  readonly gridPosition: string | null; // e.g. "4:2"
  readonly isStarter: boolean;
}

export interface TeamLineup {
  readonly teamId: TeamId;
  readonly formation: string | null;
  readonly coachName: string | null;
  readonly startingXI: readonly LineupPlayer[];
  readonly substitutes: readonly LineupPlayer[];
}

export interface FixtureLineups {
  readonly fixtureId: FixtureId;
  readonly home: TeamLineup;
  readonly away: TeamLineup;
  /** Lineups are published ~1h before kickoff; false means we are serving a projected XI. */
  readonly confirmed: boolean;
}

export type MatchEventType =
  | 'GOAL'
  | 'OWN_GOAL'
  | 'PENALTY_SCORED'
  | 'PENALTY_MISSED'
  | 'PENALTY_AWARDED'
  | 'ASSIST'
  | 'YELLOW_CARD'
  | 'SECOND_YELLOW'
  | 'RED_CARD'
  | 'SUBSTITUTION'
  | 'CORNER'
  | 'OFFSIDE'
  | 'FOUL'
  | 'THROW_IN'
  | 'GOAL_KICK'
  | 'SHOT_ON_TARGET'
  | 'SHOT_OFF_TARGET'
  | 'SAVE'
  | 'VAR_CHECK'
  | 'HALF_TIME'
  | 'FULL_TIME'
  | 'KICK_OFF';

export interface MatchEvent {
  /** Stable id so repeated polls are idempotent. */
  readonly id: string;
  readonly fixtureId: FixtureId;
  readonly type: MatchEventType;
  readonly minute: number;
  readonly extraMinute: number | null;
  readonly teamId: TeamId | null;
  readonly playerId: FootballPlayerId | null;
  readonly playerName: string | null;
  readonly relatedPlayerId: FootballPlayerId | null;
  readonly detail: string | null;
}

export interface TeamMatchStats {
  readonly teamId: TeamId;
  readonly possession: number | null; // percent
  readonly shots: number | null;
  readonly shotsOnTarget: number | null;
  readonly corners: number | null;
  readonly offsides: number | null;
  readonly fouls: number | null;
  readonly yellowCards: number | null;
  readonly redCards: number | null;
  readonly passes: number | null;
  readonly passAccuracy: number | null;
}

export interface PlayerMatchStats {
  readonly playerId: FootballPlayerId;
  readonly teamId: TeamId;
  readonly minutesPlayed: number | null;
  readonly goals: number;
  readonly assists: number;
  readonly shots: number | null;
  readonly shotsOnTarget: number | null;
  readonly passes: number | null;
  readonly passAccuracy: number | null;
  readonly tackles: number | null;
  readonly duelsWon: number | null;
  readonly foulsCommitted: number | null;
  readonly rating: number | null;
}

/** Everything the matchday games need about an in-progress fixture. */
export interface LiveMatchState {
  readonly fixture: Fixture;
  readonly events: readonly MatchEvent[];
  readonly teamStats: readonly TeamMatchStats[];
  readonly playerStats: readonly PlayerMatchStats[];
  /** Server timestamp of this snapshot, ISO 8601. */
  readonly updatedAt: string;
}

/**
 * Whether the data needed by a given game is actually available for a fixture.
 * The engine uses this to disable a game rather than presenting a broken round.
 */
export interface DataQuality {
  readonly hasLineups: boolean;
  readonly hasShirtNumbers: boolean;
  readonly hasLiveEvents: boolean;
  readonly hasPlayerMatchStats: boolean;
  readonly hasPlayerSeasonStats: boolean;
  readonly hasMarketValues: boolean;
  readonly hasCareerHistory: boolean;
  readonly notes: readonly string[];
}

/**
 * ---------------------------------------------------------------------------
 * Additive extensions (Phase 2)
 *
 * Everything above this line is the frozen Phase-1 contract and is unchanged.
 * The types below were added for catalog games that had no home in the
 * original contract; nothing existing was renamed, removed or reshaped.
 * ---------------------------------------------------------------------------
 */

/** Metrics a season leaderboard can be ranked by. Feeds `G4` Name the Top 10 and `G2` Higher or Lower. */
export type SeasonLeaderboardMetric =
  | 'GOALS'
  | 'ASSISTS'
  | 'APPEARANCES'
  | 'MINUTES_PLAYED'
  | 'YELLOW_CARDS'
  | 'RATING';

export interface SeasonLeaderboardEntry {
  readonly rank: number;
  readonly playerId: FootballPlayerId;
  readonly playerName: string;
  readonly teamId: TeamId;
  readonly teamName: string;
  readonly value: number;
}

/** A ranked table for one competition/season/metric, computed from `PlayerSeasonStats`. */
export interface SeasonLeaderboard {
  readonly competitionId: CompetitionId;
  readonly season: SeasonId;
  readonly metric: SeasonLeaderboardMetric;
  readonly entries: readonly SeasonLeaderboardEntry[];
}
