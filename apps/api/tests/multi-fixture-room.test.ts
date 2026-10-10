/**
 * Multi-fixture matchday rooms (`POST /rooms { fixtureIds }`) and rooms created BEFORE kickoff.
 *
 * Scenario (offline FixtureProvider): `mf-pl` (Premier League, LIVE), `mf-ll` (La Liga, SCHEDULED, kicks off in 20
 * minutes: inside the 30-minute open window) and `mf-done` (Premier League, FINISHED).
 */
import { COMPETITIONS, FixtureProvider, asTeamId, createInMemoryDataSource } from '@fdg/football-data';
import type { ProjectedRoom } from '@fdg/game-core';
import { asRoomId } from '@fdg/game-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPinnedRoundFixture } from '../src/engine/gameday-cache.js';
import type { LiveScheduler } from '../src/live/ingestion.js';
import type { TestServer } from './helpers.js';
import { connectAndTrack, jsonFetch, startTestServer } from './helpers.js';

const PL = COMPETITIONS.PREMIER_LEAGUE;
const LL = COMPETITIONS.LA_LIGA;
const KICKOFF_IN_20_MIN = new Date(Date.now() + 20 * 60_000).toISOString();

const team = (id: string) => ({ id: asTeamId(id), name: `${id} FC`, shortName: id.toUpperCase(), crestUrl: null, country: null });
const player = (teamId: string, index: number) => ({
  id: `${teamId}-p${String(index + 1)}`,
  name: `${teamId} Player ${String(index + 1)}`,
  fullName: null,
  nationality: null,
  dateOfBirth: null,
  age: null,
  heightCm: null,
  position: 'MF' as const,
  shirtNumber: index + 1,
  teamId,
  photoUrl: null,
  marketValueEur: null,
});
const startingXI = (teamId: string) =>
  Array.from({ length: 11 }, (_, index) => ({
    playerId: `${teamId}-p${String(index + 1)}`,
    name: `${teamId} Player ${String(index + 1)}`,
    shirtNumber: index + 1,
    position: 'MF' as const,
    gridPosition: null,
    isStarter: true,
  }));
const lineupsFor = (fixtureId: string, home: string, away: string) => ({
  fixtureId,
  home: { teamId: home, formation: null, coachName: null, startingXI: startingXI(home), substitutes: [] },
  away: { teamId: away, formation: null, coachName: null, startingXI: startingXI(away), substitutes: [] },
  confirmed: true,
});
const fixtureOf = (
  id: string,
  competition: typeof PL | typeof LL,
  status: 'LIVE' | 'SCHEDULED' | 'FINISHED',
  kickoff: string,
  home: string,
  away: string,
) => ({
  id,
  competitionId: competition.id,
  season: competition.currentSeason,
  kickoff,
  status,
  minute: status === 'LIVE' ? 30 : null,
  homeTeam: team(home),
  awayTeam: team(away),
  score: status === 'SCHEDULED' ? null : { home: 1, away: 0 },
  halfTimeScore: null,
  venue: null,
  round: null,
});
const goal = (fixtureId: string, teamId: string) => ({
  id: `${fixtureId}-goal`,
  fixtureId,
  type: 'GOAL' as const,
  minute: 10,
  extraMinute: null,
  teamId,
  playerId: null,
  playerName: null,
  relatedPlayerId: null,
  detail: null,
});
const PROVENANCE = {
  kind: 'recorded-sample-data' as const,
  description: 'multi-fixture-room.test.ts',
  recordedAt: '2026-10-01T00:00:00.000Z',
  disclaimer: 'test data',
};
const competitionFile = (
  code: keyof typeof COMPETITIONS,
  teams: string[],
  fixtures: unknown[],
  lineups: unknown[],
  liveStates: unknown[],
) => ({
  provenance: PROVENANCE,
  competitionCode: code,
  season: COMPETITIONS[code].currentSeason,
  teams: teams.map(team),
  players: teams.flatMap((id) => Array.from({ length: 11 }, (_, index) => player(id, index))),
  seasonStats: teams.slice(0, 2).map((id) => ({
    playerId: `${id}-p1`,
    teamId: id,
    competitionId: COMPETITIONS[code].id,
    season: COMPETITIONS[code].currentSeason,
    appearances: 5,
    minutesPlayed: 450,
    goals: 2,
    assists: 1,
    yellowCards: 0,
    redCards: 0,
    shots: 10,
    shotsOnTarget: 4,
    passAccuracy: 80,
    tackles: 3,
    rating: 7,
  })),
  fixtures,
  lineups,
  liveStates,
});
const placeholder = (code: keyof typeof COMPETITIONS) =>
  competitionFile(
    code,
    [`${code.toLowerCase()}-a`, `${code.toLowerCase()}-b`],
    [fixtureOf(`${code.toLowerCase()}-x`, COMPETITIONS[code] as typeof PL, 'FINISHED', '2026-09-20T12:00:00.000Z', `${code.toLowerCase()}-a`, `${code.toLowerCase()}-b`)],
    [],
    [],
  );

const buildScenario = () => {
  const plLive = fixtureOf('mf-pl', PL, 'LIVE', new Date(Date.now() - 30 * 60_000).toISOString(), 'arsenal', 'leeds');
  const plDone = fixtureOf('mf-done', PL, 'FINISHED', '2026-09-20T12:00:00.000Z', 'chelsea', 'spurs');
  const llSoon = fixtureOf('mf-ll', LL, 'SCHEDULED', KICKOFF_IN_20_MIN, 'barca', 'getafe');
  const stamp = { updatedAt: new Date().toISOString(), teamStats: [], playerStats: [] };
  return createInMemoryDataSource({
    'index.json': {
      provenance: PROVENANCE,
      version: 1,
      competitions: [
        { code: 'PREMIER_LEAGUE', file: 'competitions/premier-league.json' },
        { code: 'LA_LIGA', file: 'competitions/la-liga.json' },
        { code: 'SERIE_A', file: 'competitions/serie-a.json' },
        { code: 'BUNDESLIGA', file: 'competitions/bundesliga.json' },
        { code: 'LIGUE_1', file: 'competitions/ligue-1.json' },
        { code: 'CHAMPIONS_LEAGUE', file: 'competitions/champions-league.json' },
      ],
      careersFile: 'careers.json',
      timelines: [],
    },
    'competitions/premier-league.json': competitionFile(
      'PREMIER_LEAGUE',
      ['arsenal', 'leeds', 'chelsea', 'spurs'],
      [plLive, plDone],
      [lineupsFor('mf-pl', 'arsenal', 'leeds'), lineupsFor('mf-done', 'chelsea', 'spurs')],
      [{ fixtureId: 'mf-pl', events: [goal('mf-pl', 'arsenal')], ...stamp }],
    ),
    'competitions/la-liga.json': competitionFile(
      'LA_LIGA',
      ['barca', 'getafe'],
      [llSoon],
      [lineupsFor('mf-ll', 'barca', 'getafe')],
      [{ fixtureId: 'mf-ll', events: [], ...stamp }],
    ),
    'competitions/serie-a.json': placeholder('SERIE_A'),
    'competitions/bundesliga.json': placeholder('BUNDESLIGA'),
    'competitions/ligue-1.json': placeholder('LIGUE_1'),
    'competitions/champions-league.json': placeholder('CHAMPIONS_LEAGUE'),
    'careers.json': { provenance: PROVENANCE, careers: [] },
  });
};

const createFakeScheduler = () => {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const scheduler: LiveScheduler = {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const advance = async (ms: number, idle: () => Promise<void>): Promise<void> => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
      await idle();
    }
    now = target;
  };
  return { scheduler, advance };
};

interface RoomView extends ProjectedRoom {
  readonly fixtureIds: readonly string[];
  readonly fixtureStatus: string | null;
  readonly currentFixture: { readonly fixtureId: string; readonly competitionId: string; readonly mode: string } | null;
}

const STEPS = ['fixture', 'lineups', 'squads', 'stats'];
const post = (server: TestServer, body: Record<string, unknown>) =>
  jsonFetch(`${server.baseUrl}/rooms`, {
    method: 'POST',
    body: JSON.stringify({ category: 'matchday', hostNickname: 'Host', settings: { minPlayersToStart: 1 }, ...body }),
  });

describe('multi-fixture matchday rooms and pre-kickoff rooms', () => {
  let server: TestServer;
  const fake = createFakeScheduler();

  beforeAll(async () => {
    server = await startTestServer({
      footballData: new FixtureProvider({ dataSource: buildScenario() }),
      liveScheduler: fake.scheduler,
      liveIngestion: { liveIntervalMs: 15_000, preKickoffIntervalMs: 60_000, jitterRatio: 0 },
    });
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  it('validates fixtureIds: unknown, not live/upcoming, too many, and shape conflicts', async () => {
    const unknown = await post(server, { fixtureIds: ['mf-pl', 'nope'] });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ error: { code: 'UNKNOWN_FIXTURE', fixtureIds: ['nope'] } });

    const done = await post(server, { fixtureIds: ['mf-pl', 'mf-done'] });
    expect(done.status).toBe(400);
    expect(done.body).toMatchObject({ error: { code: 'FIXTURE_NOT_AVAILABLE', fixtureIds: ['mf-done'] } });

    const tooMany = await post(server, { fixtureIds: Array.from({ length: 21 }, (_, i) => `f${String(i)}`) });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body).toMatchObject({ error: { code: 'INVALID_BODY' } });

    expect((await post(server, { fixtureIds: [] })).status).toBe(400);
    expect((await post(server, { fixtureIds: ['mf-pl'], fixtureId: 'mf-pl' })).status).toBe(400);
    expect((await post(server, { fixtureIds: ['mf-pl'], gameday: true, competitionId: PL.id })).status).toBe(400);
  });

  it('one id (or duplicates of one) is a plain single-fixture room; legacy fixtureId still works', async () => {
    const dup = await post(server, { fixtureIds: ['mf-pl', 'mf-pl'] });
    expect(dup.status).toBe(201);
    expect((dup.body as { room: Record<string, unknown> }).room).toMatchObject({ fixtureId: 'mf-pl', fixtureIds: ['mf-pl'], fixtureStatus: 'LIVE' });

    const legacy = await post(server, { fixtureId: 'mf-pl' });
    expect((legacy.body as { room: Record<string, unknown> }).room).toMatchObject({ fixtureId: 'mf-pl', fixtureIds: ['mf-pl'] });
  });

  it('a cross-competition pool rotates rounds across its fixtures, pins them, and exposes fixtureIds/fixtureStatus', async () => {
    const created = await post(server, { fixtureIds: ['mf-pl', 'mf-ll'], settings: { minPlayersToStart: 1, roundsPerSession: 2 } });
    expect(created.status).toBe(201);
    const { roomToken, roomId, room, pin } = created.body as { roomToken: string; roomId: string; pin: string; room: Record<string, unknown> };
    expect(room).toMatchObject({ fixtureId: null, fixtureIds: ['mf-pl', 'mf-ll'], gamedayCompetitionId: null, fixtureStatus: 'LIVE' });
    const byPin = await jsonFetch(`${server.baseUrl}/rooms/pin/${pin}`);
    expect(byPin.body).toMatchObject({ fixtureIds: ['mf-pl', 'mf-ll'], fixtureStatus: 'LIVE' });

    const host = await connectAndTrack<RoomView>(server, { mode: 'reconnect', roomToken });
    const hostId = host.joined.playerId;
    host.socket.emit('room:action', { type: 'SELECT_GAME', actorId: hostId, moduleId: 'M3', config: null });
    await host.state.waitFor((s) => s.selection?.moduleId === 'M3', 15_000);
    host.socket.emit('room:action', { type: 'START_LOADING', actorId: hostId, stepKeys: STEPS });
    const loaded = await host.state.waitFor((s) => s.loading?.steps.every((step) => step.status === 'done' || step.status === 'failed') === true, 30_000);
    expect(loaded.loading?.steps.every((step) => step.status === 'done')).toBe(true);
    expect(loaded.fixtureIds).toEqual(['mf-pl', 'mf-ll']);
    host.socket.emit('room:action', { type: 'START_SESSION', actorId: hostId });

    const seen: Array<{ fixtureId: string; competitionId: string }> = [];
    for (let round = 0; round < 2; round += 1) {
      const playing = await host.state.waitFor((s) => s.round?.status === 'open' && s.round.index === round, 15_000);
      expect(playing.fixtureIds).toEqual(['mf-pl', 'mf-ll']);
      seen.push({ fixtureId: playing.currentFixture!.fixtureId, competitionId: playing.currentFixture!.competitionId });
      host.socket.emit('room:action', { type: 'SUBMIT_ANSWER', playerId: hostId, roundId: playing.round!.id, payload: { guess: 1 } });
      await host.state.waitFor((s) => s.round?.status === 'resolved', 15_000);
      host.socket.emit('room:action', { type: 'ADVANCE', actorId: hostId });
      await host.state.waitFor((s) => s.phase === 'intermission', 15_000);
      if (round === 0) host.socket.emit('room:action', { type: 'ADVANCE', actorId: hostId });
    }
    expect(seen.map((entry) => entry.fixtureId)).toEqual(['mf-pl', 'mf-ll']);
    expect(seen[0]!.competitionId).not.toBe(seen[1]!.competitionId);
    expect(getPinnedRoundFixture(asRoomId(roomId), { sessionIndex: 0, roundIndex: 0 })).toBe('mf-pl');
    expect(getPinnedRoundFixture(asRoomId(roomId), { sessionIndex: 0, roundIndex: 1 })).toBe('mf-ll');
    host.socket.close();
  }, 90_000);

  it('live ingestion follows the pinned fixture round by round across competitions', async () => {
    const ingestion = server.ctx.liveIngestion!;
    const idle = (): Promise<void> => ingestion.idle();
    const created = await post(server, { fixtureIds: ['mf-pl', 'mf-ll'] });
    const { roomToken } = created.body as { roomToken: string };
    const host = await connectAndTrack<RoomView>(server, { mode: 'reconnect', roomToken });
    const hostId = host.joined.playerId;
    host.socket.emit('room:action', { type: 'SELECT_GAME', actorId: hostId, moduleId: 'M6', config: null });
    await host.state.waitFor((s) => s.selection?.moduleId === 'M6', 15_000);
    host.socket.emit('room:action', { type: 'START_LOADING', actorId: hostId, stepKeys: STEPS });
    await host.state.waitFor((s) => s.loading?.steps.every((step) => step.status === 'done') === true, 30_000);
    host.socket.emit('room:action', { type: 'START_SESSION', actorId: hostId });
    const first = await host.state.waitFor((s) => s.round?.status === 'open', 15_000);
    expect(first.currentFixture!.fixtureId).toBe('mf-pl');
    expect(ingestion.watchedFixtureIds()).toEqual(['mf-pl']); // only the round's fixture, not the whole pool
    await fake.advance(15_000, idle);

    host.socket.emit('room:action', { type: 'REVEAL_ROUND', actorId: hostId });
    await host.state.waitFor((s) => s.round?.status === 'resolved', 15_000);
    host.socket.emit('room:action', { type: 'ADVANCE', actorId: hostId });
    await host.state.waitFor((s) => s.phase === 'intermission', 15_000);
    host.socket.emit('room:action', { type: 'ADVANCE', actorId: hostId });
    const second = await host.state.waitFor((s) => s.round?.status === 'open' && s.round.index === 1, 15_000);
    expect(second.currentFixture!.fixtureId).toBe('mf-ll');
    expect(ingestion.watchedFixtureIds()).toEqual(['mf-ll']);
    host.socket.close();
  }, 90_000);

  it('a room on a fixture 20 minutes from kickoff can select every live game, waits for kickoff, and does not lock early', async () => {
    const ingestion = server.ctx.liveIngestion!;
    const idle = (): Promise<void> => ingestion.idle();
    const created = await post(server, { fixtureIds: ['mf-ll'] });
    expect(created.status).toBe(201);
    expect((created.body as { room: Record<string, unknown> }).room).toMatchObject({ fixtureStatus: 'SCHEDULED' });
    const { roomToken } = created.body as { roomToken: string };
    const host = await connectAndTrack<RoomView>(server, { mode: 'reconnect', roomToken });
    const hostId = host.joined.playerId;
    const errors: string[] = [];
    host.socket.on('room:error', (e: { code: string }) => { errors.push(e.code); });

    // Selectable before kickoff: the live-feed requirement is waived while the fixture is SCHEDULED.
    for (const moduleId of ['M1', 'M4', 'M5', 'M6', 'M7', 'M9']) {
      host.socket.emit('room:action', { type: 'SELECT_GAME', actorId: hostId, moduleId, config: null });
      await host.state.waitFor((s) => s.selection?.moduleId === moduleId, 15_000);
    }
    expect(errors).toEqual([]);

    host.socket.emit('room:action', { type: 'SELECT_GAME', actorId: hostId, moduleId: 'M1', config: null });
    await host.state.waitFor((s) => s.selection?.moduleId === 'M1', 15_000);
    host.socket.emit('room:action', { type: 'START_LOADING', actorId: hostId, stepKeys: STEPS });
    await host.state.waitFor((s) => s.loading?.steps.every((step) => step.status === 'done' || step.status === 'failed') === true, 15_000);
    host.socket.emit('room:action', { type: 'START_SESSION', actorId: hostId });
    const playing = await host.state.waitFor((s) => s.round?.status === 'open', 15_000);
    expect(errors).toEqual([]);
    expect((playing.round!.publicPayload as { slipLocked: boolean }).slipLocked).toBe(false);

    // Polls before kickoff deliver an empty baseline and change nothing: the slip stays open.
    expect(ingestion.watchedFixtureIds()).toContain('mf-ll');
    await fake.advance(60_000, idle);
    await fake.advance(60_000, idle);
    const still = host.state.latest()!;
    expect(still.round!.status).toBe('open');
    expect((still.round!.publicPayload as { slipLocked: boolean }).slipLocked).toBe(false);
    expect(still.fixtureStatus).toBe('SCHEDULED');
    host.socket.close();
  }, 90_000);

  it.each(['M4', 'M5', 'M6', 'M7', 'M9'])('%s opens a round in a room created 20 minutes before kickoff', async (moduleId) => {
    const created = await post(server, { fixtureIds: ['mf-ll'] });
    const { roomToken } = created.body as { roomToken: string };
    const host = await connectAndTrack<RoomView>(server, { mode: 'reconnect', roomToken });
    const hostId = host.joined.playerId;
    const errors: string[] = [];
    host.socket.on('room:error', (e: { code: string }) => errors.push(e.code));
    host.socket.emit('room:action', { type: 'SELECT_GAME', actorId: hostId, moduleId, config: null });
    await host.state.waitFor((s) => s.selection?.moduleId === moduleId, 15_000);
    host.socket.emit('room:action', { type: 'START_LOADING', actorId: hostId, stepKeys: STEPS });
    await host.state.waitFor((s) => s.loading?.steps.every((step) => step.status === 'done' || step.status === 'failed') === true, 15_000);
    host.socket.emit('room:action', { type: 'START_SESSION', actorId: hostId });
    await host.state.waitFor((s) => s.round !== null && s.phase === 'playing', 15_000);
    expect(errors).toEqual([]);
    host.socket.close();
  }, 60_000);
});
