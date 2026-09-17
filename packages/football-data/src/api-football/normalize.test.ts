/**
 * The adapter contract test: recorded raw API-Football payloads in, normalized domain types out.
 *
 * Runs entirely from `data/raw-samples/` — no API key, no network.
 */

import { describe, expect, it } from 'vitest';

import { COMPETITIONS, competitionConfigByApiFootballId } from '../competitions.js';
import { asFixtureId } from '../domain.js';
import {
  normalizeCareer,
  normalizeEvents,
  normalizeEventType,
  normalizeFixtures,
  normalizeFixtureStatus,
  normalizeLineups,
  normalizePlayerBio,
  normalizePlayerMatchStats,
  normalizePlayerSeasonStats,
  normalizePosition,
  normalizeTeamStats,
} from './normalize.js';
import { loadRawSample } from './raw-samples.js';
import {
  envelopeErrorMessage,
  eventsResponseSchema,
  fixturePlayersResponseSchema,
  fixturesResponseSchema,
  lineupsResponseSchema,
  playersResponseSchema,
  squadsResponseSchema,
  teamStatisticsResponseSchema,
  transfersResponseSchema,
} from './schemas.js';
import { normalizeSquad } from './normalize.js';

const FIXTURE_ID = asFixtureId('1208301');
const PL = COMPETITIONS.PREMIER_LEAGUE;

describe('status and position mapping', () => {
  it('maps every API-Football status code the app can encounter', () => {
    expect(normalizeFixtureStatus('NS')).toBe('SCHEDULED');
    expect(normalizeFixtureStatus('1H')).toBe('LIVE');
    expect(normalizeFixtureStatus('2H')).toBe('LIVE');
    expect(normalizeFixtureStatus('HT')).toBe('HALF_TIME');
    expect(normalizeFixtureStatus('ET')).toBe('EXTRA_TIME');
    expect(normalizeFixtureStatus('P')).toBe('PENALTIES');
    expect(normalizeFixtureStatus('FT')).toBe('FINISHED');
    expect(normalizeFixtureStatus('AET')).toBe('FINISHED');
    expect(normalizeFixtureStatus('PST')).toBe('POSTPONED');
    expect(normalizeFixtureStatus('CANC')).toBe('CANCELLED');
    expect(normalizeFixtureStatus('something-new')).toBe('SCHEDULED');
  });

  it('maps positions and defaults to UNKNOWN rather than guessing', () => {
    expect(normalizePosition('Goalkeeper')).toBe('GK');
    expect(normalizePosition('G')).toBe('GK');
    expect(normalizePosition('Defender')).toBe('DF');
    expect(normalizePosition('Midfielder')).toBe('MF');
    expect(normalizePosition('Attacker')).toBe('FW');
    expect(normalizePosition('F')).toBe('FW');
    expect(normalizePosition(null)).toBe('UNKNOWN');
    expect(normalizePosition('Zebra')).toBe('UNKNOWN');
  });

  it('collapses the type/detail pair into a flat event type', () => {
    expect(normalizeEventType('Goal', 'Normal Goal')).toBe('GOAL');
    expect(normalizeEventType('Goal', 'Own Goal')).toBe('OWN_GOAL');
    expect(normalizeEventType('Goal', 'Penalty')).toBe('PENALTY_SCORED');
    expect(normalizeEventType('Card', 'Yellow Card')).toBe('YELLOW_CARD');
    expect(normalizeEventType('Card', 'Second Yellow card')).toBe('SECOND_YELLOW');
    expect(normalizeEventType('Card', 'Red Card')).toBe('RED_CARD');
    expect(normalizeEventType('subst', 'Substitution 2')).toBe('SUBSTITUTION');
    expect(normalizeEventType('Var', 'Penalty confirmed')).toBe('PENALTY_AWARDED');
    expect(normalizeEventType('Var', 'Goal cancelled')).toBe('VAR_CHECK');
  });
});

describe('/fixtures', () => {
  it('normalizes the recorded payload into domain fixtures', () => {
    const parsed = fixturesResponseSchema.safeParse(loadRawSample('fixtures'));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const { value: fixtures, notes } = normalizeFixtures(parsed.data.response, () => PL);
    expect(fixtures).toHaveLength(3);
    // Sorted by kickoff, so the finished 1 February match comes first.
    expect(fixtures.map((fixture) => fixture.id)).toEqual(['1208290', '1208301', '1208305']);

    const live = fixtures.find((fixture) => fixture.id === '1208301');
    expect(live).toBeDefined();
    if (live === undefined) return;
    expect(live.competitionId).toBe(PL.id);
    expect(live.season).toBe('2025/26');
    expect(live.status).toBe('LIVE');
    expect(live.minute).toBe(63);
    expect(live.homeTeam).toEqual({
      id: '42',
      name: 'Arsenal',
      shortName: 'ARS',
      crestUrl: 'https://media.api-sports.io/football/teams/42.png',
      country: null,
    });
    expect(live.score).toEqual({ home: 1, away: 1 });
    expect(live.halfTimeScore).toEqual({ home: 1, away: 1 });
    expect(live.venue).toBe('Emirates Stadium');
    expect(live.round).toBe('Regular Season - 24');
    expect(notes).toEqual([]);

    const scheduled = fixtures.find((fixture) => fixture.id === '1208305');
    expect(scheduled?.status).toBe('SCHEDULED');
    expect(scheduled?.minute).toBeNull();
    expect(scheduled?.score).toBeNull();
    expect(scheduled?.halfTimeScore).toBeNull();
  });

  it('normalizes partial payloads to nulls with notes, and drops unsupported leagues', () => {
    const parsed = fixturesResponseSchema.safeParse(loadRawSample('fixtures-partial'));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const { value: fixtures, notes } = normalizeFixtures(parsed.data.response, competitionConfigByApiFootballId);
    // The Primeira Liga fixture is not a supported competition and is dropped with a note.
    expect(fixtures).toHaveLength(1);
    const only = fixtures[0];
    expect(only).toBeDefined();
    if (only === undefined) return;

    expect(only.venue).toBeNull();
    expect(only.score).toBeNull();
    expect(only.halfTimeScore).toBeNull();
    expect(only.round).toBeNull();
    expect(only.status).toBe('LIVE');
    // Missing code falls back to a derived abbreviation rather than an empty string.
    expect(only.homeTeam.shortName).toBe('AV');
    expect(notes.some((note) => note.includes('unsupported league 94'))).toBe(true);
    expect(notes.some((note) => note.includes('no venue'))).toBe(true);
    expect(notes.some((note) => note.includes('score is missing'))).toBe(true);
  });
});

describe('/fixtures/lineups', () => {
  it('normalizes both XIs, keeps grid positions and notes the missing shirt number', () => {
    const parsed = lineupsResponseSchema.safeParse(loadRawSample('lineups'));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const { value: lineups, notes } = normalizeLineups(FIXTURE_ID, parsed.data.response, '42');
    expect(lineups).not.toBeNull();
    if (lineups === null) return;

    expect(lineups.fixtureId).toBe(FIXTURE_ID);
    expect(lineups.confirmed).toBe(true);
    expect(lineups.home.teamId).toBe('42');
    expect(lineups.away.teamId).toBe('40');
    expect(lineups.home.formation).toBe('4-3-3');
    expect(lineups.home.coachName).toBe('M. Arteta');
    expect(lineups.home.startingXI).toHaveLength(11);
    expect(lineups.away.startingXI).toHaveLength(11);

    const keeper = lineups.home.startingXI[0];
    expect(keeper?.name).toBe('David Raya');
    expect(keeper?.position).toBe('GK');
    expect(keeper?.shirtNumber).toBe(22);
    expect(keeper?.gridPosition).toBe('1:1');
    expect(keeper?.isStarter).toBe(true);

    // A null `pos` normalizes rather than throwing.
    expect(lineups.home.startingXI.find((entry) => entry.name === 'Viktor Gyökeres')?.position).toBe('UNKNOWN');
    // A null shirt number is kept as null and reported.
    expect(lineups.home.startingXI.find((entry) => entry.name === 'Martín Zubimendi')?.shirtNumber).toBeNull();
    expect(notes.some((note) => note.includes('No shirt number for Martín Zubimendi'))).toBe(true);

    // The unidentified substitute is dropped with a note instead of producing a broken entry.
    expect(lineups.away.substitutes).toHaveLength(4);
    expect(notes.some((note) => note.includes('unidentified substitute'))).toBe(true);
  });

  it('returns null for a pre-publication payload with only one side', () => {
    const parsed = lineupsResponseSchema.safeParse(loadRawSample('lineups-incomplete'));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const { value, notes } = normalizeLineups(asFixtureId('1208305'), parsed.data.response, '50');
    expect(value).toBeNull();
    expect(notes[0]).toContain('need two');
  });
});

describe('/fixtures/events', () => {
  it('normalizes events, drops the minute-less one, and produces stable ids', () => {
    const parsed = eventsResponseSchema.safeParse(loadRawSample('events'));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const first = normalizeEvents(FIXTURE_ID, parsed.data.response);
    expect(first.value).toHaveLength(8);
    expect(first.notes.some((note) => note.includes('no minute'))).toBe(true);

    expect(first.value.map((event) => event.type)).toEqual([
      'GOAL',
      'YELLOW_CARD',
      'GOAL',
      'PENALTY_AWARDED',
      'PENALTY_SCORED',
      'SUBSTITUTION',
      'SECOND_YELLOW',
      'GOAL',
    ]);

    const opener = first.value[0];
    expect(opener?.minute).toBe(15);
    expect(opener?.teamId).toBe('42');
    expect(opener?.playerId).toBe('20754');
    expect(opener?.playerName).toBe('William Saliba');
    expect(opener?.relatedPlayerId).toBe('20759');
    expect(opener?.detail).toBe('Normal Goal');
    expect(opener?.fixtureId).toBe(FIXTURE_ID);

    const stoppage = first.value.at(-1);
    expect(stoppage?.minute).toBe(90);
    expect(stoppage?.extraMinute).toBe(3);

    // Re-normalizing the same feed yields the same ids, so repeated polls are idempotent.
    const second = normalizeEvents(FIXTURE_ID, parsed.data.response);
    expect(second.value.map((event) => event.id)).toEqual(first.value.map((event) => event.id));
    expect(new Set(first.value.map((event) => event.id)).size).toBe(first.value.length);
  });
});

describe('/fixtures/statistics and /fixtures/players', () => {
  it('coerces percentage strings and missing statistic types', () => {
    const parsed = teamStatisticsResponseSchema.safeParse(loadRawSample('statistics'));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const { value: stats } = normalizeTeamStats(parsed.data.response);
    expect(stats).toHaveLength(2);
    const home = stats[0];
    expect(home?.teamId).toBe('42');
    expect(home?.possession).toBe(52);
    expect(home?.shots).toBe(16);
    expect(home?.shotsOnTarget).toBe(7);
    expect(home?.corners).toBe(8);
    expect(home?.passAccuracy).toBe(86);
    expect(home?.redCards).toBeNull();

    const away = stats[1];
    // `Passes %` present but null, and no `Red Cards` string mismatch.
    expect(away?.passAccuracy).toBeNull();
    expect(away?.redCards).toBe(0);
  });

  it('normalizes per-player match statistics, including string ratings', () => {
    const parsed = fixturePlayersResponseSchema.safeParse(loadRawSample('fixture-players'));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const { value: stats, notes } = normalizePlayerMatchStats(parsed.data.response);
    expect(stats).toHaveLength(4);
    expect(notes.some((note) => note.includes('unidentified player match stats'))).toBe(true);

    const saka = stats.find((row) => row.playerId === '20760');
    expect(saka?.teamId).toBe('42');
    expect(saka?.minutesPlayed).toBe(95);
    expect(saka?.goals).toBe(1);
    // `assists: null` upstream normalizes to 0, never to null, because the domain type says non-null.
    expect(saka?.assists).toBe(0);
    expect(saka?.passAccuracy).toBe(83);
    expect(saka?.rating).toBe(8.4);
    expect(saka?.duelsWon).toBe(9);

    const keeper = stats.find((row) => row.playerId === '20752');
    expect(keeper?.shots).toBeNull();
    expect(keeper?.tackles).toBeNull();

    const unused = stats.find((row) => row.playerId === '30812');
    expect(unused?.minutesPlayed).toBeNull();
    expect(unused?.rating).toBeNull();
  });
});

describe('/players/squads and /players', () => {
  it('normalizes a squad and reports the unidentified member', () => {
    const parsed = squadsResponseSchema.safeParse(loadRawSample('squads'));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const row = parsed.data.response[0];
    expect(row).toBeDefined();
    if (row === undefined) return;

    const { value: players, notes } = normalizeSquad(row);
    expect(players).toHaveLength(5);
    expect(notes.some((note) => note.includes('unidentified squad member'))).toBe(true);

    const raya = players[0];
    expect(raya?.id).toBe('20752');
    expect(raya?.teamId).toBe('42');
    expect(raya?.position).toBe('GK');
    expect(raya?.shirtNumber).toBe(22);
    expect(raya?.age).toBe(30);
    // API-Football carries no market values; the gap is explicit so DataQuality can disable G7.
    expect(raya?.marketValueEur).toBeNull();

    expect(players.find((player) => player.id === '20761')?.position).toBe('UNKNOWN');
  });

  it('normalizes a player bio, parsing the height string', () => {
    const parsed = playersResponseSchema.safeParse(loadRawSample('players'));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const raw = parsed.data.response[0];
    expect(raw).toBeDefined();
    if (raw === undefined) return;

    const { value: player } = normalizePlayerBio(raw);
    expect(player).not.toBeNull();
    if (player === null) return;
    expect(player.id).toBe('20760');
    expect(player.name).toBe('B. Saka');
    expect(player.fullName).toBe('Bukayo Saka');
    expect(player.nationality).toBe('England');
    expect(player.dateOfBirth).toBe('2001-09-05');
    expect(player.age).toBe(24);
    expect(player.heightCm).toBe(178);
    expect(player.position).toBe('FW');
    expect(player.teamId).toBe('42');

    // A player with no height at all stays null instead of becoming 0.
    const missingHeight = parsed.data.response[2];
    expect(missingHeight).toBeDefined();
    if (missingHeight === undefined) return;
    expect(normalizePlayerBio(missingHeight).value?.heightCm).toBeNull();
  });

  it('keeps only supported competitions in the season statistics and folds second yellows into both counts', () => {
    const parsed = playersResponseSchema.safeParse(loadRawSample('players'));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const saka = parsed.data.response[0];
    expect(saka).toBeDefined();
    if (saka === undefined) return;

    const { value: rows } = normalizePlayerSeasonStats(saka, competitionConfigByApiFootballId);
    // Premier League and Champions League are supported; the FA Cup block is not.
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.competitionId).sort()).toEqual(['champions-league', 'premier-league']);

    const league = rows.find((row) => row.competitionId === PL.id);
    expect(league?.season).toBe('2025/26');
    expect(league?.appearances).toBe(23);
    expect(league?.minutesPlayed).toBe(1884);
    expect(league?.goals).toBe(11);
    expect(league?.assists).toBe(9);
    expect(league?.shots).toBe(62);
    expect(league?.shotsOnTarget).toBe(29);
    expect(league?.passAccuracy).toBe(81);
    expect(league?.tackles).toBe(26);
    // The long upstream rating string is coerced to a number.
    expect(league?.rating).toBeCloseTo(7.612345, 5);

    const salah = parsed.data.response[1];
    expect(salah).toBeDefined();
    if (salah === undefined) return;
    const salahRows = normalizePlayerSeasonStats(salah, competitionConfigByApiFootballId).value;
    const salahLeague = salahRows[0];
    // `yellowred: 1` counts as both a yellow and a red.
    expect(salahLeague?.yellowCards).toBe(2);
    expect(salahLeague?.redCards).toBe(1);

    const zubimendi = parsed.data.response[2];
    expect(zubimendi).toBeDefined();
    if (zubimendi === undefined) return;
    const zubiRows = normalizePlayerSeasonStats(zubimendi, competitionConfigByApiFootballId).value;
    expect(zubiRows[0]?.rating).toBeNull();
    expect(zubiRows[0]?.assists).toBe(0);
  });
});

describe('/transfers', () => {
  it('rebuilds a career in chronological order from the newest-first transfer list', () => {
    const parsed = transfersResponseSchema.safeParse(loadRawSample('transfers'));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const row = parsed.data.response[0];
    expect(row).toBeDefined();
    if (row === undefined) return;

    const { value: career, notes } = normalizeCareer(row);
    expect(career.map((entry) => entry.teamName)).toEqual([
      'FC Basel',
      'Chelsea',
      'Fiorentina',
      'AS Roma',
      'AS Roma',
      'Liverpool',
    ]);
    expect(career[0]?.fromSeason).toBe('unknown');
    expect(career[0]?.toSeason).toBe('2013/14');
    expect(career[1]?.fromSeason).toBe('2013/14');
    expect(career.at(-1)?.teamName).toBe('Liverpool');
    expect(career.at(-1)?.toSeason).toBeNull();
    // Chelsea is one of the app's clubs, so the career entry carries a real team id.
    expect(career[1]?.teamId).toBe('49');
    // The transfer with a null date is filtered out before the walk.
    expect(notes).toEqual([]);
  });

  it('returns an empty career rather than failing when there is no transfer history', () => {
    const { value, notes } = normalizeCareer({ player: { id: 1, name: 'X' }, transfers: [] });
    expect(value).toEqual([]);
    expect(notes[0]).toContain('No transfer history');
  });
});

describe('envelope errors', () => {
  it('flattens an application-level error object into one message', () => {
    const sample = loadRawSample('error-envelope') as { errors: unknown };
    const message = envelopeErrorMessage(sample.errors);
    expect(message).toContain('rateLimit');
    expect(message).toContain('30 requests per minute');
  });

  it('treats an empty errors array as success', () => {
    expect(envelopeErrorMessage([])).toBeNull();
    expect(envelopeErrorMessage(undefined)).toBeNull();
  });
});
