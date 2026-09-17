/**
 * ESPN → normalized domain mapping. Pure functions, no I/O.
 *
 * Tested directly against real payloads recorded into `data/raw-samples/espn/`. Past this file nothing knows ESPN
 * exists: ids are ESPN's own numeric ids as strings, wrapped in the domain's branded types.
 *
 * Conventions worth knowing:
 * - `SUBSTITUTION` events carry the player going **off** as `playerId` and the player coming **on** as
 *   `relatedPlayerId` (ESPN lists them the other way round; this matches the rest of the data layer).
 * - `FOUL` events carry the offender as `playerId` and the fouled player as `relatedPlayerId`.
 * - The second-half kick-off is reported at minute 46, so a replay can tell half time apart from first-half
 *   stoppage time.
 * - ESPN has no market values; `marketValueEur` is always null and `DataQuality.hasMarketValues` stays false.
 */

import type { CompetitionConfig } from '../competitions.js';
import { seasonLabel } from '../competitions.js';
import type {
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
  TeamId,
  TeamLineup,
  TeamMatchStats,
} from '../domain.js';
import { asFixtureId, asFootballPlayerId, asSeasonId, asTeamId } from '../domain.js';
import type { Normalized } from '../api-football/normalize.js';
import type {
  EspnAthlete,
  EspnCommentary,
  EspnKeyEvent,
  EspnRoster,
  EspnRosterAthlete,
  EspnScoreboard,
  EspnScoreboardEvent,
  EspnStatEntry,
  EspnSummary,
  EspnSummaryRoster,
  EspnTeamRef,
  EspnTeams,
} from './schemas.js';

// ---------------------------------------------------------------------------
// Primitive mappings
// ---------------------------------------------------------------------------

/** ESPN status (`STATUS_HALFTIME`, …) plus its coarse state (`pre`/`in`/`post`) → `FixtureStatus`. */
export function normalizeEspnStatus(name: string | null | undefined, state: string | null | undefined): FixtureStatus {
  const value = (name ?? '').toUpperCase();
  if (value.includes('POSTPONED') || value.includes('DELAYED')) return 'POSTPONED';
  if (value.includes('CANCEL') || value.includes('ABANDON') || value.includes('FORFEIT')) return 'CANCELLED';
  if (value.includes('HALFTIME') || value === 'STATUS_HALF_TIME') return 'HALF_TIME';
  if (value.includes('SHOOTOUT') || value.includes('PENALT')) return 'PENALTIES';
  if (value.includes('EXTRA') || value.includes('OVERTIME')) {
    return value.includes('FINAL') || value.includes('FULL') ? 'FINISHED' : 'EXTRA_TIME';
  }
  if (value.includes('FULL_TIME') || value.includes('FINAL') || value.includes('END_OF_GAME')) return 'FINISHED';
  if (value.includes('SCHEDULED')) return 'SCHEDULED';
  if (value.includes('IN_PROGRESS') || value.includes('HALF') || value.includes('END_PERIOD')) return 'LIVE';
  switch ((state ?? '').toLowerCase()) {
    case 'in':
      return 'LIVE';
    case 'post':
      return 'FINISHED';
    default:
      return 'SCHEDULED';
  }
}

/**
 * ESPN position abbreviations come in two vocabularies: the coarse `G/D/M/F` on rosters and detailed ones
 * (`CD-L`, `AM`, `RW`, …) on some lineups. Unknown values normalize to `UNKNOWN`, never to a guess.
 */
export function normalizeEspnPosition(abbreviation: string | null | undefined): PlayerPosition {
  const value = (abbreviation ?? '').trim().toUpperCase();
  if (value.length === 0) return 'UNKNOWN';
  if (value === 'G' || value === 'GK') return 'GK';
  if (['D', 'CD', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'SW', 'CD-L', 'CD-R'].includes(value) || value.startsWith('CD')) {
    return 'DF';
  }
  if (['M', 'DM', 'CM', 'AM', 'LM', 'RM', 'CM-L', 'CM-R', 'AM-L', 'AM-R', 'DM-L', 'DM-R'].includes(value)) return 'MF';
  if (value.startsWith('DM') || value.startsWith('CM') || value.startsWith('AM')) return 'MF';
  if (['F', 'FW', 'CF', 'ST', 'LW', 'RW', 'SS', 'CF-L', 'CF-R'].includes(value) || value.startsWith('CF')) return 'FW';
  return 'UNKNOWN';
}

/** `"45'+2'"` → `{ minute: 45, extraMinute: 2 }`; an empty display value falls back to the clock in seconds. */
export function parseEspnClock(
  displayValue: string | null | undefined,
  seconds: number | null | undefined,
): { minute: number; extraMinute: number | null } | null {
  const text = (displayValue ?? '').trim();
  const match = /^(\d+)'?(?:\s*\+\s*(\d+)'?)?/.exec(text);
  if (match !== null && match[1] !== undefined) {
    const minute = Number.parseInt(match[1], 10);
    const extra = match[2] === undefined ? null : Number.parseInt(match[2], 10);
    return { minute, extraMinute: extra };
  }
  if (typeof seconds === 'number' && Number.isFinite(seconds)) {
    return { minute: Math.floor(seconds / 60), extraMinute: null };
  }
  return null;
}

/** ESPN play-type slug (`corner-awarded`, `penalty---scored`, …) → domain event type, or null to skip. */
export function normalizeEspnPlayType(slug: string | null | undefined, text?: string | null): MatchEventType | null {
  const value = (slug ?? '').toLowerCase();
  const label = (text ?? '').toLowerCase();
  if (value.length === 0) return null;
  if (value.includes('own-goal') || value.includes('own goal')) return 'OWN_GOAL';
  if (value.includes('penalty')) {
    if (value.includes('scored') || value.includes('goal')) return 'PENALTY_SCORED';
    if (value.includes('miss') || value.includes('saved')) return 'PENALTY_MISSED';
    return 'PENALTY_AWARDED';
  }
  if (value.startsWith('goal')) return 'GOAL';
  if (value.includes('yellow-red') || value.includes('second-yellow')) return 'SECOND_YELLOW';
  if (value.includes('red-card')) return 'RED_CARD';
  if (value.includes('yellow-card')) return 'YELLOW_CARD';
  if (value.includes('substitution')) return 'SUBSTITUTION';
  if (value.includes('corner')) return 'CORNER';
  if (value.includes('offside')) return 'OFFSIDE';
  if (value === 'foul' || value.includes('handball') || value.startsWith('foul')) return 'FOUL';
  if (value.includes('shot-on-target')) return 'SHOT_ON_TARGET';
  if (value.includes('shot') || value.includes('woodwork') || value.includes('post')) return 'SHOT_OFF_TARGET';
  if (value.includes('save')) return 'SAVE';
  if (value.includes('var') || value.includes('video-review')) return 'VAR_CHECK';
  if (value.includes('throw')) return 'THROW_IN';
  if (value.includes('goal-kick')) return 'GOAL_KICK';
  if (value === 'kickoff' || value.startsWith('start-')) return 'KICK_OFF';
  if (value === 'halftime' || value === 'half-time' || label === 'halftime') return 'HALF_TIME';
  if (value.startsWith('end-regular') || value.startsWith('end-extra') || value === 'full-time' || value === 'end-game') {
    return 'FULL_TIME';
  }
  return null;
}

function toInt(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function inchesToCm(inches: number | null | undefined): number | null {
  if (inches === null || inches === undefined || !Number.isFinite(inches) || inches <= 0) return null;
  return Math.round(inches * 2.54);
}

function isoDate(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match?.[1] ?? null;
}

function statValue(stats: readonly EspnStatEntry[] | null | undefined, ...keys: readonly string[]): number | null {
  if (stats === null || stats === undefined) return null;
  for (const key of keys) {
    const entry = stats.find((stat) => stat.name === key || stat.abbreviation === key);
    if (entry === undefined) continue;
    if (typeof entry.value === 'number' && Number.isFinite(entry.value)) return entry.value;
    const parsed = Number.parseFloat((entry.displayValue ?? '').replace('%', ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Teams and fixtures
// ---------------------------------------------------------------------------

export function normalizeEspnTeam(ref: EspnTeamRef, country: string | null = null): Team {
  const name = ref.displayName ?? ref.name ?? ref.shortDisplayName ?? `Team ${ref.id}`;
  const crest = ref.logo ?? ref.logos?.find((logo) => typeof logo.href === 'string')?.href ?? null;
  return {
    id: asTeamId(ref.id),
    name,
    shortName: ref.abbreviation ?? name.slice(0, 3).toUpperCase(),
    crestUrl: crest,
    country,
  };
}

function seasonFor(config: CompetitionConfig, year: number | null | undefined): SeasonId {
  return typeof year === 'number' ? asSeasonId(seasonLabel(year)) : config.currentSeason;
}

function scoreFromCompetitors(
  competitors: readonly { homeAway?: string | null | undefined; score?: number | string | null | undefined }[],
): Score | null {
  const home = competitors.find((entry) => entry.homeAway === 'home');
  const away = competitors.find((entry) => entry.homeAway === 'away');
  const homeGoals = toInt(home?.score);
  const awayGoals = toInt(away?.score);
  if (homeGoals === null || awayGoals === null) return null;
  return { home: homeGoals, away: awayGoals };
}

/** One scoreboard event → `Fixture`. Half-time score is not on the scoreboard, so it is null here. */
export function normalizeEspnScoreboardEvent(
  event: EspnScoreboardEvent,
  config: CompetitionConfig,
): Normalized<Fixture | null> {
  const notes: string[] = [];
  const competition = event.competitions[0];
  if (competition === undefined) return { value: null, notes: [`ESPN event ${event.id} has no competition block.`] };
  const home = competition.competitors.find((entry) => entry.homeAway === 'home');
  const away = competition.competitors.find((entry) => entry.homeAway === 'away');
  if (home === undefined || away === undefined) {
    return { value: null, notes: [`ESPN event ${event.id} is missing a home or away competitor; dropped.`] };
  }
  const status = competition.status ?? event.status ?? null;
  const fixtureStatus = normalizeEspnStatus(status?.type?.name, status?.type?.state);
  const live = fixtureStatus === 'LIVE' || fixtureStatus === 'HALF_TIME' || fixtureStatus === 'EXTRA_TIME';
  const clock = live ? parseEspnClock(status?.displayClock, status?.clock) : null;
  const score = fixtureStatus === 'SCHEDULED' ? null : scoreFromCompetitors(competition.competitors);
  if (score === null && fixtureStatus !== 'SCHEDULED' && fixtureStatus !== 'POSTPONED' && fixtureStatus !== 'CANCELLED') {
    notes.push(`ESPN event ${event.id} is ${fixtureStatus} but has no score.`);
  }
  const venue = competition.venue?.fullName ?? null;
  if (venue === null) notes.push(`ESPN event ${event.id} has no venue.`);

  return {
    value: {
      id: asFixtureId(event.id),
      competitionId: config.id,
      season: seasonFor(config, event.season?.year),
      kickoff: normalizeKickoff(event.date),
      status: fixtureStatus,
      minute: clock === null ? null : clock.minute + (clock.extraMinute ?? 0),
      homeTeam: normalizeEspnTeam(home.team, config.isCup ? null : config.country),
      awayTeam: normalizeEspnTeam(away.team, config.isCup ? null : config.country),
      score,
      halfTimeScore: null,
      venue,
      round: event.season?.slug ?? null,
    },
    notes,
  };
}

/** ESPN dates omit seconds (`2026-09-16T17:00Z`); normalize to full ISO 8601. */
function normalizeKickoff(date: string): string {
  const parsed = Date.parse(date);
  return Number.isNaN(parsed) ? date : new Date(parsed).toISOString();
}

export function normalizeEspnScoreboard(
  scoreboard: EspnScoreboard,
  config: CompetitionConfig,
): Normalized<readonly Fixture[]> {
  const notes: string[] = [];
  const fixtures: Fixture[] = [];
  for (const event of scoreboard.events) {
    const normalized = normalizeEspnScoreboardEvent(event, config);
    notes.push(...normalized.notes);
    if (normalized.value !== null) fixtures.push(normalized.value);
  }
  fixtures.sort((left, right) => left.kickoff.localeCompare(right.kickoff));
  return { value: fixtures, notes };
}

export function normalizeEspnTeams(teams: EspnTeams, config: CompetitionConfig): Normalized<readonly Team[]> {
  const rows = teams.sports?.flatMap((sport) => sport.leagues ?? []).flatMap((league) => league.teams ?? []) ?? [];
  const value = rows.map((row) => normalizeEspnTeam(row.team, config.isCup ? null : config.country));
  return { value, notes: value.length === 0 ? [`ESPN returned no teams for ${config.name}.`] : [] };
}

// ---------------------------------------------------------------------------
// Match summary: fixture, lineups, events, stats
// ---------------------------------------------------------------------------

/** Maps display names (commentary has no ids) back to team and athlete ids using the summary's own rosters. */
export interface SummaryIndex {
  readonly homeTeamId: string | null;
  readonly awayTeamId: string | null;
  teamIdByName(name: string | null | undefined): string | null;
  athleteId(name: string | null | undefined, teamId: string | null): string | null;
  teamOfAthlete(athleteId: string | null): string | null;
}

export function foldName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function buildSummaryIndex(summary: EspnSummary): SummaryIndex {
  const competitors = summary.header.competitions[0]?.competitors ?? [];
  const home = competitors.find((entry) => entry.homeAway === 'home');
  const away = competitors.find((entry) => entry.homeAway === 'away');

  const teamNames = new Map<string, string>();
  for (const competitor of competitors) {
    const team = competitor.team;
    for (const name of [team.displayName, team.shortDisplayName, team.name, team.location, team.abbreviation]) {
      if (typeof name === 'string' && name.length > 0) teamNames.set(foldName(name), team.id);
    }
  }

  const athletesByTeam = new Map<string, Map<string, string>>();
  const teamByAthlete = new Map<string, string>();
  for (const roster of summary.rosters ?? []) {
    const byName = new Map<string, string>();
    for (const entry of roster.roster ?? []) {
      const id = entry.athlete.id;
      if (typeof id !== 'string') continue;
      teamByAthlete.set(id, roster.team.id);
      for (const name of [entry.athlete.displayName, entry.athlete.fullName]) {
        if (typeof name === 'string' && name.length > 0) byName.set(foldName(name), id);
      }
    }
    athletesByTeam.set(roster.team.id, byName);
  }

  return {
    homeTeamId: home?.team.id ?? null,
    awayTeamId: away?.team.id ?? null,
    teamIdByName: (name) => (typeof name === 'string' ? (teamNames.get(foldName(name)) ?? null) : null),
    athleteId: (name, teamId) => {
      if (typeof name !== 'string') return null;
      const key = foldName(name);
      if (teamId !== null) {
        const hit = athletesByTeam.get(teamId)?.get(key);
        if (hit !== undefined) return hit;
      }
      for (const byName of athletesByTeam.values()) {
        const hit = byName.get(key);
        if (hit !== undefined) return hit;
      }
      return null;
    },
    teamOfAthlete: (athleteId) => (athleteId === null ? null : (teamByAthlete.get(athleteId) ?? null)),
  };
}

/** Summary header → `Fixture`, with a half-time score derived from the first-half goal events. */
export function normalizeEspnSummaryFixture(
  summary: EspnSummary,
  config: CompetitionConfig,
  events: readonly MatchEvent[],
): Normalized<Fixture | null> {
  const competition = summary.header.competitions[0];
  const id = summary.header.id ?? competition?.id ?? null;
  if (competition === undefined || id === null) {
    return { value: null, notes: ['ESPN summary has no event id or competition; dropped.'] };
  }
  const base = normalizeEspnScoreboardEvent(
    {
      id,
      date: competition.date ?? '',
      season: { year: summary.header.season?.year ?? null, slug: null },
      status: competition.status ?? null,
      competitions: [competition],
    },
    config,
  );
  if (base.value === null) return base;
  const notes = [...base.notes];
  const venue = base.value.venue ?? summary.gameInfo?.venue?.fullName ?? null;
  const index = buildSummaryIndex(summary);

  let halfTimeScore: Score | null = null;
  const halfTimeAt = events.findIndex((event) => event.type === 'HALF_TIME');
  if (halfTimeAt >= 0) {
    halfTimeScore = scoreFromEvents(events.slice(0, halfTimeAt), index);
  } else if (base.value.status === 'FINISHED') {
    notes.push(`ESPN summary ${id} has no half-time marker; half-time score unavailable.`);
  }

  return {
    value: {
      ...base.value,
      venue,
      // Summary headers carry no round slug; keep null rather than inventing one.
      round: null,
      halfTimeScore,
    },
    notes: venue === null ? notes : notes.filter((note) => !note.includes('has no venue')),
  };
}

function scoreFromEvents(events: readonly MatchEvent[], index: SummaryIndex): Score {
  let home = 0;
  let away = 0;
  for (const event of events) {
    const goal = event.type === 'GOAL' || event.type === 'PENALTY_SCORED';
    const own = event.type === 'OWN_GOAL';
    if (!goal && !own) continue;
    const forHome = event.teamId === index.homeTeamId;
    if ((goal && forHome) || (own && !forHome)) home += 1;
    else away += 1;
  }
  return { home, away };
}

function lineupEntry(entry: NonNullable<EspnSummaryRoster['roster']>[number]): LineupPlayer | null {
  const id = entry.athlete.id;
  const name = entry.athlete.displayName ?? entry.athlete.fullName;
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  return {
    playerId: asFootballPlayerId(id),
    name,
    shirtNumber: toInt(entry.jersey),
    position: normalizeEspnPosition(entry.position?.abbreviation),
    // ESPN gives a formation slot number, not API-Football's "line:slot" grid, so there is no honest mapping.
    gridPosition: null,
    isStarter: entry.starter === true,
  };
}

/** Summary rosters → `FixtureLineups`. Empty rosters (lineups not yet published) → null with a note. */
export function normalizeEspnLineups(summary: EspnSummary, fixtureId: FixtureId): Normalized<FixtureLineups | null> {
  const notes: string[] = [];
  const rosters = summary.rosters ?? [];
  const homeRoster = rosters.find((roster) => roster.homeAway === 'home') ?? rosters[0];
  const awayRoster = rosters.find((roster) => roster.homeAway === 'away') ?? rosters[1];
  if (homeRoster === undefined || awayRoster === undefined) {
    return { value: null, notes: [`ESPN has not published lineups for fixture ${fixtureId}.`] };
  }

  const build = (roster: EspnSummaryRoster): TeamLineup => {
    const entries = [...(roster.roster ?? [])];
    entries.sort((left, right) => (toInt(left.formationPlace) ?? 99) - (toInt(right.formationPlace) ?? 99));
    const starters: LineupPlayer[] = [];
    const substitutes: LineupPlayer[] = [];
    for (const entry of entries) {
      const player = lineupEntry(entry);
      if (player === null) {
        notes.push(`Dropped an unidentified roster entry for ${roster.team.displayName ?? roster.team.id}.`);
        continue;
      }
      if (player.shirtNumber === null) notes.push(`No shirt number for ${player.name}.`);
      (player.isStarter ? starters : substitutes).push(player);
    }
    return {
      teamId: asTeamId(roster.team.id),
      formation: roster.formation ?? null,
      coachName: null,
      startingXI: starters,
      substitutes,
    };
  };

  const home = build(homeRoster);
  const away = build(awayRoster);
  if (home.startingXI.length === 0 && away.startingXI.length === 0) {
    return { value: null, notes: [...notes, `ESPN has not published lineups for fixture ${fixtureId}.`] };
  }
  const confirmed = home.startingXI.length === 11 && away.startingXI.length === 11;
  if (!confirmed) notes.push(`Lineups for fixture ${fixtureId} are incomplete; treating them as unconfirmed.`);
  notes.push('ESPN does not publish coach names in match summaries.');
  return { value: { fixtureId, home, away, confirmed }, notes };
}

interface RawPlay {
  readonly id: string;
  readonly order: number;
  readonly slug: string | null;
  readonly label: string | null;
  readonly period: number | null;
  readonly clockText: string | null;
  readonly clockSeconds: number | null;
  readonly teamId: string | null;
  readonly teamName: string | null;
  readonly participants: readonly { id: string | null; name: string | null }[];
  readonly text: string | null;
}

function fromKeyEvent(event: EspnKeyEvent, order: number): RawPlay {
  return {
    id: event.id,
    order,
    slug: event.type?.type ?? null,
    label: event.type?.text ?? null,
    period: event.period?.number ?? null,
    clockText: event.clock?.displayValue ?? null,
    clockSeconds: event.clock?.value ?? null,
    teamId: event.team?.id ?? null,
    teamName: event.team?.displayName ?? null,
    participants: (event.participants ?? []).map((entry) => ({
      id: entry.athlete?.id ?? null,
      name: entry.athlete?.displayName ?? entry.athlete?.fullName ?? null,
    })),
    text: event.shortText ?? event.text ?? null,
  };
}

function fromCommentary(entry: EspnCommentary, order: number): RawPlay | null {
  const play = entry.play;
  if (play === null || play === undefined) return null;
  return {
    id: play.id,
    order,
    slug: play.type?.type ?? null,
    label: play.type?.text ?? null,
    period: play.period?.number ?? null,
    clockText: play.clock?.displayValue ?? entry.time?.displayValue ?? null,
    clockSeconds: play.clock?.value ?? entry.time?.value ?? null,
    teamId: play.team?.id ?? null,
    teamName: play.team?.displayName ?? null,
    participants: (play.participants ?? []).map((participant) => ({
      id: participant.athlete?.id ?? null,
      name: participant.athlete?.displayName ?? participant.athlete?.fullName ?? null,
    })),
    text: play.text ?? entry.text ?? null,
  };
}

/**
 * Key events plus play-by-play commentary → one chronological, de-duplicated `MatchEvent[]`.
 *
 * Commentary is the complete stream (corners, offsides, fouls, shots) but only names people; key events share the
 * same play ids and carry real team/athlete ids. Plays are merged by id — key-event data wins field by field —
 * and names are resolved to ids through the summary's rosters. Event ids are `espn:<playId>`, so repeated polls of
 * a live match are idempotent.
 */
export function normalizeEspnEvents(summary: EspnSummary, fixtureId: FixtureId): Normalized<readonly MatchEvent[]> {
  const notes: string[] = [];
  const index = buildSummaryIndex(summary);
  const plays = new Map<string, RawPlay>();

  (summary.commentary ?? []).forEach((entry, order) => {
    const play = fromCommentary(entry, order);
    if (play !== null) plays.set(play.id, play);
  });
  const commentaryCount = plays.size;
  (summary.keyEvents ?? []).forEach((event, order) => {
    const keyPlay = fromKeyEvent(event, order);
    const existing = plays.get(keyPlay.id);
    if (existing === undefined) {
      // Key events missing from commentary slot in by clock; `order` is only a tie-breaker.
      plays.set(keyPlay.id, { ...keyPlay, order: commentaryCount + order });
      return;
    }
    plays.set(keyPlay.id, {
      ...existing,
      slug: keyPlay.slug ?? existing.slug,
      label: keyPlay.label ?? existing.label,
      period: keyPlay.period ?? existing.period,
      teamId: keyPlay.teamId ?? existing.teamId,
      teamName: keyPlay.teamName ?? existing.teamName,
      participants: keyPlay.participants.length > 0 ? keyPlay.participants : existing.participants,
    });
  });

  const unknownTypes = new Map<string, number>();
  const events: { event: MatchEvent; period: number; at: number; order: number }[] = [];

  for (const play of plays.values()) {
    const type = normalizeEspnPlayType(play.slug, play.label);
    if (type === null) {
      const key = play.slug ?? '(none)';
      unknownTypes.set(key, (unknownTypes.get(key) ?? 0) + 1);
      continue;
    }
    const clock = parseEspnClock(play.clockText, play.clockSeconds);
    if (clock === null) {
      notes.push(`Dropped ESPN play ${play.id} (${type}) with no clock.`);
      continue;
    }
    const period = play.period ?? (clock.minute > 45 ? 2 : 1);
    let minute = clock.minute;
    let extraMinute = clock.extraMinute;
    if (type === 'KICK_OFF' && period === 2) {
      minute = 46;
      extraMinute = null;
    }

    const teamId = play.teamId ?? index.teamIdByName(play.teamName);
    const resolved = play.participants.map((participant) => participant.id ?? index.athleteId(participant.name, teamId));
    const names = play.participants.map((participant) => participant.name);

    let playerId: string | null = resolved[0] ?? null;
    let playerName: string | null = names[0] ?? null;
    let relatedId: string | null = resolved[1] ?? null;
    if (type === 'SUBSTITUTION') {
      // ESPN lists [coming on, going off]; the domain convention is player = off, related = on.
      playerId = resolved[1] ?? null;
      playerName = names[1] ?? null;
      relatedId = resolved[0] ?? null;
    }
    const eventTeamId = type === 'OWN_GOAL' ? (index.teamOfAthlete(playerId) ?? teamId) : teamId;

    events.push({
      period,
      at: minute + (extraMinute ?? 0) / 100,
      order: play.order,
      event: {
        id: `espn:${play.id}`,
        fixtureId,
        type,
        minute,
        extraMinute,
        teamId: eventTeamId === null ? null : asTeamId(eventTeamId),
        playerId: playerId === null ? null : asFootballPlayerId(playerId),
        playerName,
        relatedPlayerId: relatedId === null ? null : asFootballPlayerId(relatedId),
        detail: play.text,
      },
    });
  }

  for (const [slug, count] of unknownTypes) {
    if (slug === '(none)') continue;
    notes.push(`Skipped ${String(count)} ESPN play(s) of unmapped type "${slug}".`);
  }

  events.sort((left, right) => left.period - right.period || left.at - right.at || left.order - right.order);
  return { value: events.map((entry) => entry.event), notes };
}

/** Boxscore → `TeamMatchStats[]`. ESPN reports pass accuracy as a 0–1 fraction; the domain wants percent. */
export function normalizeEspnTeamStats(summary: EspnSummary): Normalized<readonly TeamMatchStats[]> {
  const notes: string[] = [];
  const teams = summary.boxscore?.teams ?? [];
  if (teams.length === 0) notes.push('ESPN summary has no boxscore team statistics.');
  const value = teams.map((entry) => {
    const stats = entry.statistics ?? [];
    const passPct = statValue(stats, 'passPct');
    return {
      teamId: asTeamId(entry.team.id),
      possession: statValue(stats, 'possessionPct'),
      shots: statValue(stats, 'totalShots'),
      shotsOnTarget: statValue(stats, 'shotsOnTarget'),
      corners: statValue(stats, 'wonCorners'),
      offsides: statValue(stats, 'offsides'),
      fouls: statValue(stats, 'foulsCommitted'),
      yellowCards: statValue(stats, 'yellowCards'),
      redCards: statValue(stats, 'redCards'),
      passes: statValue(stats, 'totalPasses'),
      passAccuracy: passPct === null ? null : Math.round((passPct <= 1 ? passPct * 100 : passPct) * 10) / 10,
    };
  });
  return { value, notes };
}

/**
 * Per-player match statistics from the summary rosters. ESPN gives goals, assists, shots, shots on target and
 * fouls per player; minutes are reconstructed from starter/substitution data. Passes, tackles, duels and ratings
 * are not published and stay null.
 */
export function normalizeEspnPlayerMatchStats(
  summary: EspnSummary,
  fixture: Fixture,
): Normalized<readonly PlayerMatchStats[]> {
  const endMinute =
    fixture.status === 'FINISHED' ? 90 : fixture.status === 'SCHEDULED' ? 0 : Math.min(90, fixture.minute ?? 0);
  const value: PlayerMatchStats[] = [];
  for (const roster of summary.rosters ?? []) {
    for (const entry of roster.roster ?? []) {
      const id = entry.athlete.id;
      if (typeof id !== 'string') continue;
      const subMinute = (entry.plays ?? [])
        .filter((play) => play.substitution === true)
        .map((play) => parseEspnClock(play.clock?.displayValue, play.clock?.value)?.minute ?? null)
        .find((minute): minute is number => minute !== null);
      let minutes = 0;
      if (entry.starter === true) {
        minutes = entry.subbedOut === true && subMinute !== undefined ? Math.min(subMinute, endMinute) : endMinute;
      } else if (entry.subbedIn === true && subMinute !== undefined) {
        minutes = Math.max(0, endMinute - subMinute);
      }
      const stats = entry.stats ?? [];
      value.push({
        playerId: asFootballPlayerId(id),
        teamId: asTeamId(roster.team.id),
        minutesPlayed: minutes,
        goals: statValue(stats, 'totalGoals', 'G') ?? 0,
        assists: statValue(stats, 'goalAssists', 'A') ?? 0,
        shots: statValue(stats, 'totalShots', 'SHOT'),
        shotsOnTarget: statValue(stats, 'shotsOnTarget', 'SOG'),
        passes: null,
        passAccuracy: null,
        tackles: null,
        duelsWon: null,
        foulsCommitted: statValue(stats, 'foulsCommitted', 'FC'),
        rating: null,
      });
    }
  }
  const notes =
    value.length === 0
      ? ['ESPN summary has no roster statistics for this fixture.']
      : ['ESPN per-player match stats omit passes, tackles, duels and ratings; those fields are null.'];
  return { value, notes };
}

// ---------------------------------------------------------------------------
// Rosters: squads, bios and season statistics
// ---------------------------------------------------------------------------

export function normalizeEspnRosterAthlete(athlete: EspnRosterAthlete, teamId: TeamId): Player {
  return {
    id: asFootballPlayerId(athlete.id),
    name: athlete.displayName,
    fullName: athlete.fullName ?? null,
    nationality: athlete.citizenship ?? null,
    dateOfBirth: isoDate(athlete.dateOfBirth),
    age: typeof athlete.age === 'number' ? athlete.age : null,
    heightCm: inchesToCm(athlete.height),
    position: normalizeEspnPosition(athlete.position?.abbreviation),
    shirtNumber: toInt(athlete.jersey),
    teamId,
    photoUrl: athlete.headshot?.href ?? null,
    marketValueEur: null,
  };
}

export function normalizeEspnRosterPlayers(roster: EspnRoster, teamId: string): Normalized<readonly Player[]> {
  const id = asTeamId(roster.team?.id ?? teamId);
  const value = roster.athletes.map((athlete) => normalizeEspnRosterAthlete(athlete, id));
  const notes: string[] = [];
  if (value.length === 0) notes.push(`ESPN roster for team ${teamId} is empty.`);
  const missingDob = value.filter((player) => player.dateOfBirth === null).length;
  if (missingDob > 0) notes.push(`${String(missingDob)} players in team ${teamId} have no date of birth.`);
  notes.push('ESPN carries no market values; marketValueEur is null.');
  return { value, notes };
}

function seasonSplitStats(athlete: EspnRosterAthlete): EspnStatEntry[] {
  return (athlete.statistics?.splits?.categories ?? []).flatMap((category) => category.stats ?? []);
}

/**
 * Season statistics embedded in a team roster (scoped to the competition the roster was requested for).
 *
 * ESPN's roster splits carry appearances, substitute appearances, goals, assists, shots, shots on target and cards
 * — but not minutes, pass accuracy, tackles or ratings. The nullable fields stay null. `minutesPlayed` is required
 * by the domain type, so it is **estimated** as `starts × 90 + subIns × 20`, and every result says so in its notes.
 * Players with no appearances produce no row.
 */
export function normalizeEspnRosterSeasonStats(
  roster: EspnRoster,
  teamId: string,
  config: CompetitionConfig,
): Normalized<readonly PlayerSeasonStats[]> {
  const season = seasonFor(config, roster.season?.year);
  const id = asTeamId(roster.team?.id ?? teamId);
  const value: PlayerSeasonStats[] = [];
  let withoutStats = 0;
  for (const athlete of roster.athletes) {
    const stats = seasonSplitStats(athlete);
    const appearances = statValue(stats, 'appearances', 'APP');
    if (appearances === null) {
      withoutStats += 1;
      continue;
    }
    if (appearances <= 0) continue;
    const subIns = statValue(stats, 'subIns', 'SUB') ?? 0;
    const starts = Math.max(0, appearances - subIns);
    const yellow = statValue(stats, 'yellowCards', 'YC') ?? 0;
    value.push({
      playerId: asFootballPlayerId(athlete.id),
      teamId: id,
      competitionId: config.id,
      season,
      appearances,
      minutesPlayed: starts * 90 + subIns * 20,
      goals: statValue(stats, 'totalGoals', 'G') ?? 0,
      assists: statValue(stats, 'goalAssists', 'A') ?? 0,
      yellowCards: yellow,
      redCards: statValue(stats, 'redCards', 'RC') ?? 0,
      shots: statValue(stats, 'totalShots', 'SHOT'),
      shotsOnTarget: statValue(stats, 'shotsOnTarget', 'SOG'),
      passAccuracy: null,
      tackles: null,
      rating: null,
    });
  }
  const notes = [
    `ESPN season stats for team ${teamId}: minutesPlayed is estimated (starts × 90 + sub appearances × 20); ` +
      'pass accuracy, tackles and ratings are not published.',
  ];
  if (withoutStats > 0) notes.push(`${String(withoutStats)} roster players in team ${teamId} have no season statistics.`);
  return { value, notes };
}

/** Standalone athlete endpoint → a partial bio (no date of birth or height on this endpoint). */
export function normalizeEspnAthlete(payload: EspnAthlete): Normalized<Player | null> {
  const athlete = payload.athlete;
  const teamId = athlete.team?.id ?? null;
  if (teamId === null) return { value: null, notes: [`ESPN athlete ${athlete.id} has no team; dropped.`] };
  return {
    value: {
      id: asFootballPlayerId(athlete.id),
      name: athlete.displayName,
      fullName: athlete.fullName ?? null,
      nationality: athlete.citizenship ?? null,
      dateOfBirth: null,
      age: typeof athlete.age === 'number' ? athlete.age : null,
      heightCm: null,
      position: normalizeEspnPosition(athlete.position?.abbreviation),
      shirtNumber: toInt(athlete.jersey),
      teamId: asTeamId(teamId),
      photoUrl: null,
      marketValueEur: null,
    },
    notes: [`ESPN athlete ${athlete.id}: bio from the athlete endpoint has no date of birth or height.`],
  };
}

/** Athlete ids referenced by a roster, for linking squads to profiles. */
export function rosterAthleteIds(roster: EspnRoster): readonly FootballPlayerId[] {
  return roster.athletes.map((athlete) => asFootballPlayerId(athlete.id));
}
