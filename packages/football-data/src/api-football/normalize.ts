/**
 * API-Football → normalized domain mapping.
 *
 * Pure functions, no I/O, so they are tested directly against the recorded raw payloads in
 * `data/raw-samples/`. This is the only translation layer: past this file, nothing knows API-Football exists.
 *
 * Partial upstream data is normalized, never rejected — a player with no `pos` becomes `position: 'UNKNOWN'`,
 * a fixture with no venue becomes `venue: null`, an event with no minute is dropped and noted.
 */

import type { CompetitionConfig } from '../competitions.js';
import { seasonLabel } from '../competitions.js';
import type {
  CareerEntry,
  Fixture,
  FixtureId,
  FixtureLineups,
  FixtureStatus,
  FootballPlayerId,
  LineupPlayer,
  MatchEvent,
  MatchEventType,
  Player,
  PlayerMatchStats,
  PlayerPosition,
  PlayerSeasonStats,
  Score,
  SeasonId,
  Team,
  TeamLineup,
  TeamMatchStats,
} from '../domain.js';
import { asFixtureId, asFootballPlayerId, asSeasonId, asTeamId } from '../domain.js';
import type {
  RawEvent,
  RawFixture,
  RawFixturePlayers,
  RawLineup,
  RawPlayer,
  RawSquad,
  RawTeamStatistics,
  RawTransfer,
} from './schemas.js';

/** Result of a normalization pass: the value plus any data-quality notes produced along the way. */
export interface Normalized<T> {
  readonly value: T;
  readonly notes: readonly string[];
}

type RawTeamLike = {
  id: number;
  name: string;
  code?: string | null | undefined;
  logo?: string | null | undefined;
  country?: string | null | undefined;
};

export function normalizeTeam(raw: RawTeamLike): Team {
  return {
    id: asTeamId(String(raw.id)),
    name: raw.name,
    shortName: raw.code ?? abbreviate(raw.name),
    crestUrl: raw.logo ?? null,
    country: raw.country ?? null,
  };
}

/** API-Football's three-letter status codes mapped onto the domain's `FixtureStatus`. */
export function normalizeFixtureStatus(short: string): FixtureStatus {
  switch (short.toUpperCase()) {
    case 'TBD':
    case 'NS':
      return 'SCHEDULED';
    case '1H':
    case '2H':
    case 'LIVE':
    case 'INT':
      return 'LIVE';
    case 'HT':
      return 'HALF_TIME';
    case 'ET':
    case 'BT':
      return 'EXTRA_TIME';
    case 'P':
      return 'PENALTIES';
    case 'FT':
    case 'AET':
    case 'PEN':
      return 'FINISHED';
    case 'PST':
      return 'POSTPONED';
    case 'CANC':
    case 'ABD':
    case 'AWD':
    case 'WO':
      return 'CANCELLED';
    default:
      return 'SCHEDULED';
  }
}

export function normalizePosition(raw: string | null | undefined): PlayerPosition {
  if (raw === null || raw === undefined) return 'UNKNOWN';
  const value = raw.trim().toUpperCase();
  if (value.startsWith('G')) return 'GK';
  if (value.startsWith('D')) return 'DF';
  if (value.startsWith('M')) return 'MF';
  if (value.startsWith('F') || value.startsWith('A') || value.startsWith('S')) return 'FW';
  return 'UNKNOWN';
}

export function normalizeFixture(raw: RawFixture, config: CompetitionConfig): Normalized<Fixture> {
  const notes: string[] = [];
  const status = normalizeFixtureStatus(raw.fixture.status.short);
  const season = raw.league.season === undefined ? config.currentSeason : asSeasonId(seasonLabel(raw.league.season));

  const goalsHome = raw.goals?.home ?? null;
  const goalsAway = raw.goals?.away ?? null;
  const score: Score | null = goalsHome === null || goalsAway === null ? null : { home: goalsHome, away: goalsAway };
  if (score === null && (status === 'LIVE' || status === 'FINISHED')) {
    notes.push(`Fixture ${String(raw.fixture.id)} is ${status} but the upstream score is missing.`);
  }

  const halftime = raw.score?.halftime ?? null;
  const halfTimeScore: Score | null =
    halftime === null || halftime.home === null || halftime.away === null
      ? null
      : { home: halftime.home, away: halftime.away };

  const venueName = raw.fixture.venue?.name ?? null;
  if (venueName === null) notes.push(`Fixture ${String(raw.fixture.id)} has no venue in the upstream payload.`);

  return {
    value: {
      id: asFixtureId(String(raw.fixture.id)),
      competitionId: config.id,
      season,
      kickoff: raw.fixture.date,
      status,
      minute: raw.fixture.status.elapsed ?? null,
      homeTeam: normalizeTeam(raw.teams.home),
      awayTeam: normalizeTeam(raw.teams.away),
      score,
      halfTimeScore,
      venue: venueName,
      round: raw.league.round ?? null,
    },
    notes,
  };
}

export function normalizeFixtures(
  rows: readonly RawFixture[],
  resolveConfig: (leagueId: number) => CompetitionConfig | null,
): Normalized<readonly Fixture[]> {
  const notes: string[] = [];
  const fixtures: Fixture[] = [];
  for (const row of rows) {
    const config = resolveConfig(row.league.id);
    if (config === null) {
      notes.push(`Dropped fixture ${String(row.fixture.id)} from unsupported league ${String(row.league.id)}.`);
      continue;
    }
    const normalized = normalizeFixture(row, config);
    fixtures.push(normalized.value);
    notes.push(...normalized.notes);
  }
  fixtures.sort((left, right) => left.kickoff.localeCompare(right.kickoff));
  return { value: fixtures, notes };
}

function normalizeLineupPlayer(
  raw: RawLineup['startXI'][number],
  isStarter: boolean,
  index: number,
  teamName: string,
): { player: LineupPlayer | null; note: string | null } {
  const id = raw.player.id;
  const name = raw.player.name;
  if (id === null || name === null) {
    return {
      player: null,
      note: `Dropped an unidentified ${isStarter ? 'starter' : 'substitute'} (slot ${String(index + 1)}) for ${teamName}.`,
    };
  }
  const shirtNumber = raw.player.number ?? null;
  return {
    player: {
      playerId: asFootballPlayerId(String(id)),
      name,
      shirtNumber,
      position: normalizePosition(raw.player.pos),
      gridPosition: raw.player.grid ?? null,
      isStarter,
    },
    note: shirtNumber === null ? `No shirt number for ${name} (${teamName}).` : null,
  };
}

function normalizeTeamLineup(raw: RawLineup): Normalized<TeamLineup> {
  const notes: string[] = [];
  const team = normalizeTeam(raw.team);
  const starters: LineupPlayer[] = [];
  const substitutes: LineupPlayer[] = [];

  raw.startXI.forEach((entry, index) => {
    const { player, note } = normalizeLineupPlayer(entry, true, index, team.name);
    if (player !== null) starters.push(player);
    if (note !== null) notes.push(note);
  });
  raw.substitutes.forEach((entry, index) => {
    const { player, note } = normalizeLineupPlayer(entry, false, index, team.name);
    if (player !== null) substitutes.push(player);
    if (note !== null) notes.push(note);
  });

  if (starters.length < 11) notes.push(`${team.name} lineup has only ${String(starters.length)} starters.`);

  return {
    value: {
      teamId: team.id,
      formation: raw.formation ?? null,
      coachName: raw.coach?.name ?? null,
      startingXI: starters,
      substitutes,
    },
    notes,
  };
}

/**
 * Lineups arrive as a two-element array, home first. API-Football has no "confirmed" flag, so we infer it:
 * a payload with two full XIs is a published lineup, anything less is treated as unconfirmed.
 */
export function normalizeLineups(
  fixtureId: FixtureId,
  rows: readonly RawLineup[],
  homeTeamId: string,
): Normalized<FixtureLineups | null> {
  if (rows.length < 2) {
    return {
      value: null,
      notes: [`Upstream returned ${String(rows.length)} lineup blocks for fixture ${fixtureId}; need two.`],
    };
  }
  const normalized = rows.map(normalizeTeamLineup);
  const notes = normalized.flatMap((entry) => entry.notes);
  const home = normalized.find((entry) => entry.value.teamId === homeTeamId)?.value ?? normalized[0]?.value;
  const away = normalized.find((entry) => entry.value.teamId !== homeTeamId)?.value ?? normalized[1]?.value;
  if (home === undefined || away === undefined) {
    return { value: null, notes: [...notes, `Could not match lineup blocks to teams for fixture ${fixtureId}.`] };
  }
  const confirmed = home.startingXI.length >= 11 && away.startingXI.length >= 11;
  if (!confirmed) notes.push(`Treating lineups for fixture ${fixtureId} as unconfirmed (incomplete XI).`);
  return { value: { fixtureId, home, away, confirmed }, notes };
}

/** API-Football's `type`/`detail` pair collapsed into the domain's flat `MatchEventType`. */
export function normalizeEventType(type: string, detail: string | null | undefined): MatchEventType {
  const kind = type.trim().toLowerCase();
  const info = (detail ?? '').trim().toLowerCase();
  if (kind === 'goal') {
    if (info.includes('own goal')) return 'OWN_GOAL';
    if (info.includes('penalty')) return 'PENALTY_SCORED';
    if (info.includes('missed penalty')) return 'PENALTY_MISSED';
    return 'GOAL';
  }
  if (kind === 'card') {
    if (info.includes('second yellow')) return 'SECOND_YELLOW';
    if (info.includes('red')) return 'RED_CARD';
    return 'YELLOW_CARD';
  }
  if (kind === 'subst') return 'SUBSTITUTION';
  if (kind === 'var') {
    if (info.includes('penalty confirmed') || info.includes('penalty awarded')) return 'PENALTY_AWARDED';
    return 'VAR_CHECK';
  }
  if (kind === 'penalty') {
    if (info.includes('missed')) return 'PENALTY_MISSED';
    if (info.includes('scored')) return 'PENALTY_SCORED';
    return 'PENALTY_AWARDED';
  }
  if (kind === 'corner') return 'CORNER';
  if (kind === 'offside') return 'OFFSIDE';
  if (kind === 'foul') return 'FOUL';
  if (kind === 'throw in' || kind === 'throw_in') return 'THROW_IN';
  if (kind === 'goal kick' || kind === 'goal_kick') return 'GOAL_KICK';
  if (kind === 'shot') return info.includes('off') ? 'SHOT_OFF_TARGET' : 'SHOT_ON_TARGET';
  if (kind === 'save') return 'SAVE';
  if (kind === 'half time' || kind === 'halftime') return 'HALF_TIME';
  if (kind === 'full time' || kind === 'fulltime') return 'FULL_TIME';
  if (kind === 'kick off' || kind === 'kickoff') return 'KICK_OFF';
  return 'FOUL';
}

export function normalizeEvents(fixtureId: FixtureId, rows: readonly RawEvent[]): Normalized<readonly MatchEvent[]> {
  const notes: string[] = [];
  const events: MatchEvent[] = [];
  rows.forEach((row, index) => {
    const minute = row.time.elapsed;
    if (minute === null) {
      notes.push(`Dropped an event with no minute (index ${String(index)}) for fixture ${fixtureId}.`);
      return;
    }
    const type = normalizeEventType(row.type, row.detail);
    const teamId = row.team?.id ?? null;
    const playerId = row.player?.id ?? null;
    const assistId = row.assist?.id ?? null;
    events.push({
      // Deterministic id so repeated polls of the same feed are idempotent.
      id: `${fixtureId}:${String(minute)}:${String(row.time.extra ?? 0)}:${type}:${String(playerId ?? 'none')}:${String(index)}`,
      fixtureId,
      type,
      minute,
      extraMinute: row.time.extra ?? null,
      teamId: teamId === null ? null : asTeamId(String(teamId)),
      playerId: playerId === null ? null : asFootballPlayerId(String(playerId)),
      playerName: row.player?.name ?? null,
      relatedPlayerId: assistId === null ? null : asFootballPlayerId(String(assistId)),
      detail: row.detail ?? null,
    });
  });
  events.sort((left, right) => left.minute + (left.extraMinute ?? 0) - (right.minute + (right.extraMinute ?? 0)));
  return { value: events, notes };
}

/** API-Football's statistics arrays are `{ type, value }` pairs with human-readable type names. */
function statValue(raw: RawTeamStatistics, type: string): number | null {
  const entry = raw.statistics.find((item) => item.type.toLowerCase() === type.toLowerCase());
  if (entry === undefined) return null;
  return coerceNumber(entry.value);
}

export function normalizeTeamStats(rows: readonly RawTeamStatistics[]): Normalized<readonly TeamMatchStats[]> {
  const notes: string[] = [];
  const stats = rows.map((row) => {
    const team = normalizeTeam(row.team);
    const possession = statValue(row, 'Ball Possession');
    if (possession === null) notes.push(`No possession statistic for ${team.name}.`);
    return {
      teamId: team.id,
      possession,
      shots: statValue(row, 'Total Shots'),
      shotsOnTarget: statValue(row, 'Shots on Goal'),
      corners: statValue(row, 'Corner Kicks'),
      offsides: statValue(row, 'Offsides'),
      fouls: statValue(row, 'Fouls'),
      yellowCards: statValue(row, 'Yellow Cards'),
      redCards: statValue(row, 'Red Cards'),
      passes: statValue(row, 'Total passes'),
      passAccuracy: statValue(row, 'Passes %'),
    };
  });
  return { value: stats, notes };
}

export function normalizePlayerMatchStats(
  rows: readonly RawFixturePlayers[],
): Normalized<readonly PlayerMatchStats[]> {
  const notes: string[] = [];
  const stats: PlayerMatchStats[] = [];
  for (const block of rows) {
    const team = normalizeTeam(block.team);
    for (const entry of block.players) {
      const id = entry.player.id;
      if (id === null) {
        notes.push(`Dropped unidentified player match stats for ${team.name}.`);
        continue;
      }
      const first = entry.statistics[0];
      if (first === undefined) {
        notes.push(`No match statistics block for player ${String(id)} (${team.name}).`);
        continue;
      }
      stats.push({
        playerId: asFootballPlayerId(String(id)),
        teamId: team.id,
        minutesPlayed: first.games?.minutes ?? null,
        goals: first.goals?.total ?? 0,
        assists: first.goals?.assists ?? 0,
        shots: first.shots?.total ?? null,
        shotsOnTarget: first.shots?.on ?? null,
        passes: first.passes?.total ?? null,
        passAccuracy: coerceNumber(first.passes?.accuracy ?? null),
        tackles: first.tackles?.total ?? null,
        duelsWon: first.duels?.won ?? null,
        foulsCommitted: first.fouls?.committed ?? null,
        rating: coerceNumber(first.games?.rating ?? null),
      });
    }
  }
  return { value: stats, notes };
}

export function normalizeSquad(row: RawSquad): Normalized<readonly Player[]> {
  const notes: string[] = [];
  const team = normalizeTeam(row.team);
  const players: Player[] = [];
  for (const raw of row.players) {
    if (raw.id === null || raw.name === null) {
      notes.push(`Dropped an unidentified squad member for ${team.name}.`);
      continue;
    }
    players.push({
      id: asFootballPlayerId(String(raw.id)),
      name: raw.name,
      fullName: null,
      nationality: null,
      dateOfBirth: null,
      age: raw.age ?? null,
      heightCm: null,
      position: normalizePosition(raw.position),
      shirtNumber: raw.number ?? null,
      teamId: team.id,
      photoUrl: raw.photo ?? null,
      // API-Football carries no market values; `hasMarketValues` in `DataQuality` reflects that.
      marketValueEur: null,
    });
  }
  if (players.length === 0) notes.push(`Squad for ${team.name} came back empty.`);
  return { value: players, notes };
}

/** `/players` carries both the bio and one statistics block per competition the player appeared in. */
export function normalizePlayerBio(raw: RawPlayer): Normalized<Player | null> {
  const notes: string[] = [];
  const id = raw.player.id;
  const name = raw.player.name;
  if (id === null || name === null) {
    return { value: null, notes: ['Dropped a player with no id or name.'] };
  }
  const first = raw.statistics[0];
  const teamId = first === undefined ? null : asTeamId(String(first.team.id));
  if (teamId === null) {
    return { value: null, notes: [`Player ${name} has no team in the upstream payload; dropped.`] };
  }
  const heightCm = parseHeightCm(raw.player.height);
  if (heightCm === null && raw.player.height !== null && raw.player.height !== undefined) {
    notes.push(`Could not parse height "${raw.player.height}" for ${name}.`);
  }
  const fullName =
    raw.player.firstname !== null && raw.player.firstname !== undefined
      ? `${raw.player.firstname} ${raw.player.lastname ?? ''}`.trim()
      : null;

  return {
    value: {
      id: asFootballPlayerId(String(id)),
      name,
      fullName,
      nationality: raw.player.nationality ?? null,
      dateOfBirth: raw.player.birth?.date ?? null,
      age: raw.player.age ?? null,
      heightCm,
      position: normalizePosition(first?.games?.position),
      shirtNumber: null,
      teamId,
      photoUrl: raw.player.photo ?? null,
      marketValueEur: null,
    },
    notes,
  };
}

export function normalizePlayerSeasonStats(
  raw: RawPlayer,
  resolveConfig: (leagueId: number) => CompetitionConfig | null,
): Normalized<readonly PlayerSeasonStats[]> {
  const notes: string[] = [];
  const id = raw.player.id;
  if (id === null) return { value: [], notes: ['Dropped season statistics for a player with no id.'] };
  const playerId = asFootballPlayerId(String(id));
  const rows: PlayerSeasonStats[] = [];

  for (const block of raw.statistics) {
    const leagueId = block.league?.id ?? null;
    const config = leagueId === null ? null : resolveConfig(leagueId);
    if (config === null) continue;
    const seasonYear = block.league?.season ?? config.currentSeasonYear;
    const season: SeasonId = asSeasonId(seasonLabel(seasonYear));
    const yellow = block.cards?.yellow ?? 0;
    const yellowRed = block.cards?.yellowred ?? 0;
    rows.push({
      playerId,
      teamId: asTeamId(String(block.team.id)),
      competitionId: config.id,
      season,
      appearances: block.games?.appearences ?? 0,
      minutesPlayed: block.games?.minutes ?? 0,
      goals: block.goals?.total ?? 0,
      assists: block.goals?.assists ?? 0,
      yellowCards: yellow + yellowRed,
      redCards: (block.cards?.red ?? 0) + yellowRed,
      shots: block.shots?.total ?? null,
      shotsOnTarget: block.shots?.on ?? null,
      passAccuracy: coerceNumber(block.passes?.accuracy ?? null),
      tackles: block.tackles?.total ?? null,
      rating: coerceNumber(block.games?.rating ?? null),
    });
  }
  if (rows.length === 0) {
    notes.push(`Player ${String(id)} has no season statistics in a supported competition.`);
  }
  return { value: rows, notes };
}

/**
 * Career history from `/transfers`. API-Football lists transfers newest-first with `teams.in`/`teams.out`, so the
 * career is rebuilt by walking backwards: the newest `in` club is current, and each older transfer's `out` club is
 * the previous stop. Appearances and goals per club are not available from this endpoint and stay null.
 */
export function normalizeCareer(raw: RawTransfer): Normalized<readonly CareerEntry[]> {
  const notes: string[] = [];
  const transfers = raw.transfers.filter((entry) => entry.date !== null && entry.date !== undefined);
  if (transfers.length === 0) {
    return { value: [], notes: ['No transfer history available for this player.'] };
  }
  const ordered = [...transfers].sort((left, right) => (left.date ?? '').localeCompare(right.date ?? ''));

  const entries: CareerEntry[] = [];
  const firstOut = ordered[0]?.teams?.out ?? null;
  if (firstOut !== null && firstOut !== undefined) {
    entries.push({
      teamId: asTeamId(String(firstOut.id)),
      teamName: firstOut.name,
      fromSeason: 'unknown',
      toSeason: seasonFromDate(ordered[0]?.date ?? null),
      appearances: null,
      goals: null,
    });
  }

  ordered.forEach((transfer, index) => {
    const joined = transfer.teams?.in ?? null;
    if (joined === null || joined === undefined) {
      notes.push(`Skipped a transfer with no destination club (${transfer.date ?? 'unknown date'}).`);
      return;
    }
    const nextDate = ordered[index + 1]?.date ?? null;
    entries.push({
      teamId: asTeamId(String(joined.id)),
      teamName: joined.name,
      fromSeason: seasonFromDate(transfer.date ?? null) ?? 'unknown',
      toSeason: seasonFromDate(nextDate),
      appearances: null,
      goals: null,
    });
  });

  return { value: entries, notes };
}

function seasonFromDate(date: string | null): string | null {
  if (date === null) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  if (Number.isNaN(year)) return null;
  const month = Number.parseInt(date.slice(5, 7), 10);
  // A transfer in January belongs to the season that started the previous calendar year.
  const startYear = Number.isNaN(month) || month >= 7 ? year : year - 1;
  return seasonLabel(startYear);
}

function parseHeightCm(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const match = /(\d+)/.exec(raw);
  if (match === null) return null;
  const digits = match[1];
  if (digits === undefined) return null;
  const value = Number.parseInt(digits, 10);
  return Number.isNaN(value) ? null : value;
}

/** API-Football mixes numbers, `"52%"`, `"7.2"` and `null` in the same field. */
export function coerceNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = value.replace('%', '').trim();
  if (cleaned.length === 0) return null;
  const parsed = Number.parseFloat(cleaned);
  return Number.isNaN(parsed) ? null : parsed;
}

function abbreviate(name: string): string {
  const words = name.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 1) {
    const only = words[0] ?? name;
    return only.slice(0, 3).toUpperCase();
  }
  return words
    .map((word) => word[0] ?? '')
    .join('')
    .slice(0, 3)
    .toUpperCase();
}

/** Player ids referenced by an event feed, used to decide whether player-level data is worth fetching. */
export function playerIdsInEvents(events: readonly MatchEvent[]): readonly FootballPlayerId[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.playerId !== null) ids.add(event.playerId);
    if (event.relatedPlayerId !== null) ids.add(event.relatedPlayerId);
  }
  return [...ids].map(asFootballPlayerId);
}
