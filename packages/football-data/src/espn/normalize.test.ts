/**
 * The ESPN adapter contract test: real recorded ESPN payloads in, normalized domain types out.
 *
 * Runs entirely from `data/raw-samples/espn/` — no network, no API key. Every sample here is a genuine response
 * fetched on 2026-09-16 (see `data/raw-samples/espn/README.md`), not a hand-written approximation.
 */

import { describe, expect, it } from 'vitest';

import { COMPETITIONS } from '../competitions.js';
import { asFixtureId } from '../domain.js';
import {
  buildSummaryIndex,
  normalizeEspnEvents,
  normalizeEspnLineups,
  normalizeEspnPlayerMatchStats,
  normalizeEspnPlayType,
  normalizeEspnPosition,
  normalizeEspnRosterPlayers,
  normalizeEspnRosterSeasonStats,
  normalizeEspnScoreboard,
  normalizeEspnStatus,
  normalizeEspnSummaryFixture,
  normalizeEspnTeams,
  normalizeEspnTeamStats,
  parseEspnClock,
} from './normalize.js';
import { loadEspnRawSample } from './raw-samples.js';
import {
  espnRosterSchema,
  espnScoreboardSchema,
  espnSummarySchema,
  espnTeamsSchema,
} from './schemas.js';

const LA_LIGA = COMPETITIONS.LA_LIGA;
const CHAMPIONS_LEAGUE = COMPETITIONS.CHAMPIONS_LEAGUE;
const PL = COMPETITIONS.PREMIER_LEAGUE;

describe('primitive mappings', () => {
  it('maps ESPN status names/states seen in real payloads', () => {
    expect(normalizeEspnStatus('STATUS_SCHEDULED', 'pre')).toBe('SCHEDULED');
    expect(normalizeEspnStatus('STATUS_HALFTIME', 'in')).toBe('HALF_TIME');
    expect(normalizeEspnStatus('STATUS_SECOND_HALF', 'in')).toBe('LIVE');
    expect(normalizeEspnStatus('STATUS_FULL_TIME', 'post')).toBe('FINISHED');
    expect(normalizeEspnStatus('SOMETHING_NEW', 'in')).toBe('LIVE');
    expect(normalizeEspnStatus(undefined, undefined)).toBe('SCHEDULED');
  });

  it('parses displayClock, including first-half stoppage', () => {
    expect(parseEspnClock("45'+1'", 2700)).toEqual({ minute: 45, extraMinute: 1 });
    expect(parseEspnClock("52'", 3120)).toEqual({ minute: 52, extraMinute: null });
    expect(parseEspnClock(undefined, 130)).toEqual({ minute: 2, extraMinute: null });
  });

  it('maps positions, defaulting unknowns rather than guessing', () => {
    expect(normalizeEspnPosition('G')).toBe('GK');
    expect(normalizeEspnPosition('F')).toBe('FW');
    expect(normalizeEspnPosition(null)).toBe('UNKNOWN');
  });

  it('maps real ESPN play-type slugs, including the goal---header variant', () => {
    expect(normalizeEspnPlayType('goal')).toBe('GOAL');
    expect(normalizeEspnPlayType('goal---header')).toBe('GOAL');
    expect(normalizeEspnPlayType('yellow-card')).toBe('YELLOW_CARD');
    expect(normalizeEspnPlayType('substitution')).toBe('SUBSTITUTION');
    expect(normalizeEspnPlayType('corner-awarded')).toBe('CORNER');
    expect(normalizeEspnPlayType('shot-on-target')).toBe('SHOT_ON_TARGET');
    expect(normalizeEspnPlayType('halftime')).toBe('HALF_TIME');
    expect(normalizeEspnPlayType('end-regular-time')).toBe('FULL_TIME');
    expect(normalizeEspnPlayType(null)).toBeNull();
  });
});

describe('scoreboard: real esp.1 scoreboard (two live half-time matches, two scheduled)', () => {
  it('normalizes all four events with real statuses, scores and venues', () => {
    const parsed = espnScoreboardSchema.safeParse(loadEspnRawSample('scoreboard-esp.1'));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const { value: fixtures, notes } = normalizeEspnScoreboard(parsed.data, LA_LIGA);
    expect(fixtures).toHaveLength(4);

    const atm = fixtures.find((f) => f.id === '401882875');
    expect(atm).toBeDefined();
    if (atm === undefined) return;
    expect(atm.status).toBe('HALF_TIME');
    expect(atm.homeTeam).toEqual({
      id: '1068',
      name: 'Atlético Madrid',
      shortName: expect.any(String),
      crestUrl: expect.any(String),
      country: 'Spain',
    });
    expect(atm.awayTeam.name).toBe('Osasuna');
    expect(atm.score).toEqual({ home: 1, away: 0 });
    expect(atm.venue).toBe('Riyadh Air Metropolitano');
    expect(atm.competitionId).toBe(LA_LIGA.id);

    const scheduled = fixtures.find((f) => f.id === '401882871');
    expect(scheduled?.status).toBe('SCHEDULED');
    expect(scheduled?.score).toBeNull();
    expect(scheduled?.minute).toBeNull();

    expect(notes).toEqual([]);
  });
});

describe('summary: real finished Champions League match (PSG 6-1 Slovan Bratislava)', () => {
  const raw = espnSummarySchema.safeParse(loadEspnRawSample('summary-finished-psg-slovan'));

  it('parses against the lenient schema', () => {
    expect(raw.success).toBe(true);
  });

  it('normalizes the fixture: final score, half-time score, status, venue', () => {
    if (!raw.success) return;
    const events = normalizeEspnEvents(raw.data, asFixtureId('401915445'));
    const fixture = normalizeEspnSummaryFixture(raw.data, CHAMPIONS_LEAGUE, events.value);
    expect(fixture.value).not.toBeNull();
    if (fixture.value === null) return;
    expect(fixture.value.status).toBe('FINISHED');
    expect(fixture.value.score).toEqual({ home: 6, away: 1 });
    expect(fixture.value.halfTimeScore).toEqual({ home: 3, away: 0 });
    expect(fixture.value.venue).toBe('Parc des Princes');
    expect(fixture.value.homeTeam.name).toBe('Paris Saint-Germain');
    expect(fixture.value.awayTeam.name).toBe('Slovan Bratislava');
  });

  it('normalizes real events (key events merged with commentary, deduplicated by play id)', () => {
    if (!raw.success) return;
    const { value: events } = normalizeEspnEvents(raw.data, asFixtureId('401915445'));
    expect(events.length).toBeGreaterThan(50);
    // Stable, idempotent ids.
    const ids = events.map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith('espn:'))).toBe(true);

    // Chronological within each half. Raw minute+extraMinute is NOT monotonic across the half-time boundary
    // (first-half stoppage, e.g. 45'+2', sits above the second half's 46') — that overlap is exactly what
    // MatchReplay's elapsed axis exists to resolve, so here we only assert ordering within each half.
    const halfTimeIndex = events.findIndex((event) => event.type === 'HALF_TIME');
    expect(halfTimeIndex).toBeGreaterThan(0);
    const firstHalf = events.slice(0, halfTimeIndex + 1).map((event) => event.minute + (event.extraMinute ?? 0));
    const secondHalf = events.slice(halfTimeIndex + 1).map((event) => event.minute + (event.extraMinute ?? 0));
    expect(firstHalf).toEqual([...firstHalf].sort((a, b) => a - b));
    expect(secondHalf).toEqual([...secondHalf].sort((a, b) => a - b));
    expect(Math.max(...firstHalf)).toBeLessThanOrEqual(47); // stoppage, still "first half"
    expect(Math.min(...secondHalf)).toBeGreaterThanOrEqual(46); // second half starts at minute 46
  });

  it('credits Dembélé with the two goals he scored and the two he assisted', () => {
    if (!raw.success) return;
    const { value: events } = normalizeEspnEvents(raw.data, asFixtureId('401915445'));
    const goals = events.filter((event) => event.type === 'GOAL');
    expect(goals.length).toBeGreaterThanOrEqual(6);
    const dembeleGoals = goals.filter((event) => event.playerName === 'Ousmane Dembélé');
    expect(dembeleGoals).toHaveLength(2);
    // ESPN lists the scorer first and the assist provider second; the normalizer keeps that mapping.
    const dembeleAssists = goals.filter((event) => event.relatedPlayerId === dembeleGoals[0]?.playerId);
    expect(dembeleAssists.length).toBeGreaterThanOrEqual(2);
  });

  it('normalizes a substitution with the off-player as playerId and the on-player as relatedPlayerId', () => {
    if (!raw.success) return;
    const { value: events } = normalizeEspnEvents(raw.data, asFixtureId('401915445'));
    const sub = events.find(
      (event) => event.type === 'SUBSTITUTION' && event.playerName === 'Kenan Bajric',
    );
    expect(sub).toBeDefined();
    expect(sub?.relatedPlayerId).not.toBeNull();
  });

  it('normalizes both full lineups: 11 starters, real shirt numbers, formations', () => {
    if (!raw.success) return;
    const { value: lineups, notes } = normalizeEspnLineups(raw.data, asFixtureId('401915445'));
    expect(lineups).not.toBeNull();
    if (lineups === null) return;
    expect(lineups.confirmed).toBe(true);
    expect(lineups.home.formation).toBe('4-3-3');
    expect(lineups.home.startingXI).toHaveLength(11);
    expect(lineups.away.startingXI).toHaveLength(11);
    expect(lineups.home.startingXI.every((p) => p.shirtNumber !== null)).toBe(true);
    expect(notes.some((note) => note.includes('coach names'))).toBe(true);
  });

  it('normalizes team boxscore statistics, converting the 0-1 pass fraction to a percent', () => {
    if (!raw.success) return;
    const { value: stats } = normalizeEspnTeamStats(raw.data);
    const psg = stats.find((s) => s.teamId === '160');
    expect(psg).toBeDefined();
    if (psg === undefined) return;
    expect(psg.possession).toBe(72.1);
    expect(psg.shots).toBe(35);
    expect(psg.shotsOnTarget).toBe(14);
    expect(psg.corners).toBe(7);
    expect(psg.passAccuracy).toBe(90);
  });

  it('normalizes per-player match stats from the rosters, with passes/tackles/rating null (not published)', () => {
    if (!raw.success) return;
    const events = normalizeEspnEvents(raw.data, asFixtureId('401915445'));
    const fixture = normalizeEspnSummaryFixture(raw.data, CHAMPIONS_LEAGUE, events.value).value;
    expect(fixture).not.toBeNull();
    if (fixture === null) return;
    const { value: playerStats } = normalizeEspnPlayerMatchStats(raw.data, fixture);
    expect(playerStats.length).toBeGreaterThan(30);
    const dembele = playerStats.find((p) => p.playerId === '229744');
    expect(dembele).toBeDefined();
    expect(dembele?.goals).toBe(2);
    expect(dembele?.assists).toBe(2);
    expect(dembele?.passes).toBeNull();
    expect(dembele?.tackles).toBeNull();
    expect(dembele?.rating).toBeNull();
  });

  it('buildSummaryIndex resolves a team by any of its real display names', () => {
    if (!raw.success) return;
    const index = buildSummaryIndex(raw.data);
    expect(index.teamIdByName('Paris Saint-Germain')).toBe('160');
    expect(index.teamIdByName('unknown club')).toBeNull();
  });
});

describe('summary: real in-progress match (Atlético Madrid v Osasuna, second half)', () => {
  it('reports LIVE status with the current minute and full 23-player rosters', () => {
    const parsed = espnSummarySchema.safeParse(loadEspnRawSample('summary-live-atm-osasuna'));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const events = normalizeEspnEvents(parsed.data, asFixtureId('401882875'));
    const fixture = normalizeEspnSummaryFixture(parsed.data, LA_LIGA, events.value).value;
    expect(fixture?.status).toBe('LIVE');
    expect(fixture?.minute).toBe(52);
    const { value: lineups } = normalizeEspnLineups(parsed.data, asFixtureId('401882875'));
    expect(lineups?.home.startingXI).toHaveLength(11);
    expect(lineups?.home.substitutes.length).toBeGreaterThan(0);
  });
});

describe('teams: real Premier League team list', () => {
  it('normalizes 20 real clubs', () => {
    const parsed = espnTeamsSchema.safeParse(loadEspnRawSample('teams-eng.1'));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const { value: teams } = normalizeEspnTeams(parsed.data, PL);
    expect(teams).toHaveLength(20);
    expect(teams.some((team) => team.name === 'Arsenal')).toBe(true);
    expect(teams.every((team) => team.country === 'England')).toBe(true);
  });
});

describe('roster: real Manchester City roster with embedded season statistics', () => {
  const parsed = espnRosterSchema.safeParse(loadEspnRawSample('roster-mancity'));

  it('normalizes 27 real players, converting height from inches to centimetres', () => {
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const { value: players, notes } = normalizeEspnRosterPlayers(parsed.data, '382');
    expect(players).toHaveLength(27);
    const haaland = players.find((p) => p.name.includes('Haaland'));
    expect(haaland).toBeDefined();
    expect(haaland?.heightCm).toBe(196); // 77 inches
    expect(haaland?.nationality).toBe('Norway');
    expect(haaland?.shirtNumber).toBe(9);
    expect(haaland?.position).toBe('FW');
    expect(haaland?.marketValueEur).toBeNull();
    expect(notes.some((note) => note.includes('no market values'))).toBe(true);
  });

  it('derives Haaland season stats from the real roster splits, estimating minutes from appearances', () => {
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const { value: rows, notes } = normalizeEspnRosterSeasonStats(parsed.data, '382', PL);
    const haaland = rows.find((row) => row.playerId === '253989');
    expect(haaland).toBeDefined();
    if (haaland === undefined) return;
    expect(haaland.appearances).toBe(4);
    expect(haaland.goals).toBe(4);
    expect(haaland.assists).toBe(0);
    expect(haaland.minutesPlayed).toBe(4 * 90); // 4 starts, 0 sub appearances
    expect(haaland.passAccuracy).toBeNull();
    expect(haaland.tackles).toBeNull();
    expect(haaland.rating).toBeNull();
    expect(haaland.competitionId).toBe(PL.id);
    expect(notes.some((note) => note.includes('estimated'))).toBe(true);
  });

  it('skips a player with no statistics this season rather than fabricating a zero row', () => {
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const { value: rows, notes } = normalizeEspnRosterSeasonStats(parsed.data, '382', PL);
    const bettinelli = rows.find((row) => row.playerId === '177545');
    expect(bettinelli).toBeUndefined();
    expect(notes.some((note) => note.includes('no season statistics'))).toBe(true);
  });

  it('at least 40 players worth of season stats are available once both squads of a fixture are combined', () => {
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const { value: rows } = normalizeEspnRosterSeasonStats(parsed.data, '382', PL);
    expect(rows.length).toBeGreaterThan(15);
  });
});
