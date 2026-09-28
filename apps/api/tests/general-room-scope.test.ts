/**
 * Optional competition scope for general rooms (`RoomMeta.generalCompetitionId`, see
 * `engine/general-scope.ts`). Covers: room creation with/without a scope, rejection of an unknown
 * competition id, that a round played in a scoped room only ever draws content from that
 * competition, that game availability correctly differs from the combined dataset for a thin
 * competition, and that the filtered-view cache never leaks between two differently-scoped rooms.
 */

import {
  asCompetitionId,
  buildGeneralDataset,
  createFootballDataProvider,
  readFootballDataConfigFromEnv,
} from '@fdg/football-data';
import type { FootballDataProvider, GeneralDataset } from '@fdg/football-data';
import type { ProjectedRoom, ProjectedRoundPreReveal } from '@fdg/game-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getScopedGeneralDataset } from '../src/engine/general-scope.js';
import type { TestServer } from './helpers.js';
import { connectAndTrack, jsonFetch, startTestServer, waitForEvent } from './helpers.js';

const fixtureProvider = (): FootballDataProvider =>
  createFootballDataProvider(readFootballDataConfigFromEnv({ FOOTBALL_DATA_PROVIDER: 'fixture' }));

/** Independent oracle for "which players belong to this competition", built straight from the
 * recorded dataset by grouping `PlayerSeasonStats` rows by `teamId` into the FULL set of
 * competitions each team has stats rows in (a team can legitimately play in more than one
 * competition at once, e.g. a domestic league plus the Champions League) and then checking set
 * membership — deliberately not reusing anything shaped like `general-scope.ts`'s own
 * `resolveTeamCompetitions`/filtering logic, so this assertion would actually fail both if the
 * server's wiring dropped the filter entirely AND if it kept only one competition per team. */
const playerIdsForCompetition = (dataset: GeneralDataset, competitionId: string): Set<string> => {
  const teamCompetitionSets = new Map<string, Set<string>>();
  for (const row of dataset.seasonStats) {
    let competitions = teamCompetitionSets.get(row.teamId);
    if (competitions === undefined) {
      competitions = new Set();
      teamCompetitionSets.set(row.teamId, competitions);
    }
    competitions.add(row.competitionId);
  }
  const teamIds = new Set(
    [...teamCompetitionSets.entries()].filter(([, competitions]) => competitions.has(competitionId)).map(([id]) => id),
  );
  return new Set(dataset.players.filter((player) => teamIds.has(player.teamId)).map((player) => player.id));
};

/** Every team that has `PlayerSeasonStats` rows in more than one competition, per the same
 * independent grouping as `playerIdsForCompetition` above. */
const teamsInMultipleCompetitions = (dataset: GeneralDataset): Map<string, Set<string>> => {
  const teamCompetitionSets = new Map<string, Set<string>>();
  for (const row of dataset.seasonStats) {
    let competitions = teamCompetitionSets.get(row.teamId);
    if (competitions === undefined) {
      competitions = new Set();
      teamCompetitionSets.set(row.teamId, competitions);
    }
    competitions.add(row.competitionId);
  }
  const multi = new Map<string, Set<string>>();
  for (const [teamId, competitions] of teamCompetitionSets) {
    if (competitions.size > 1) multi.set(teamId, competitions);
  }
  return multi;
};

describe('general room competition scope', () => {
  let server: TestServer;
  let referenceDataset: GeneralDataset;

  beforeAll(async () => {
    server = await startTestServer();
    const built = await buildGeneralDataset(fixtureProvider(), {});
    if (!built.ok) throw new Error(`could not build reference dataset: ${built.error.message}`);
    referenceDataset = built.value;
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  it('creates a general room scoped to a valid competition and reflects it in every summary', async () => {
    const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ category: 'general', competitionId: 'la-liga', hostNickname: 'Hosty' }),
    });
    expect(createRoom.status).toBe(201);
    const body = createRoom.body as { roomId: string; pin: string; room: { generalCompetitionId: string | null } };
    expect(body.room.generalCompetitionId).toBe('la-liga');

    const byId = await jsonFetch(`${server.baseUrl}/rooms/${body.roomId}`);
    expect(byId.status).toBe(200);
    expect((byId.body as { generalCompetitionId: string | null }).generalCompetitionId).toBe('la-liga');

    const byPin = await jsonFetch(`${server.baseUrl}/rooms/pin/${body.pin}`);
    expect(byPin.status).toBe(200);
    expect((byPin.body as { generalCompetitionId: string | null }).generalCompetitionId).toBe('la-liga');
  });

  it('rejects an unknown competition id with zero side effects', async () => {
    const before = await server.ctx.prisma.room.count();

    const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ category: 'general', competitionId: 'not-a-real-competition', hostNickname: 'Hosty' }),
    });
    expect(createRoom.status).toBe(400);
    expect((createRoom.body as { error: { code: string } }).error.code).toBe('UNKNOWN_COMPETITION');

    const after = await server.ctx.prisma.room.count();
    expect(after).toBe(before);
  });

  it('a general room without a competitionId behaves exactly as before (combined dataset, no scope)', async () => {
    const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({
        category: 'general',
        hostNickname: 'Hosty',
        settings: { minPlayersToStart: 1, roundsPerSession: 1 },
      }),
    });
    expect(createRoom.status).toBe(201);
    const { roomToken, roomId } = createRoom.body as { roomToken: string; roomId: string };
    const room = (createRoom.body as { room: { generalCompetitionId: string | null } }).room;
    expect(room.generalCompetitionId).toBeNull();

    const byId = await jsonFetch(`${server.baseUrl}/rooms/${roomId}`);
    expect((byId.body as { generalCompetitionId: string | null }).generalCompetitionId).toBeNull();

    const host = await connectAndTrack<ProjectedRoom>(server, { mode: 'reconnect', roomToken });
    host.socket.emit('room:action', { type: 'SELECT_GAME', actorId: host.joined.playerId, moduleId: 'G6', config: null });
    await host.state.waitFor((state) => state.selection?.moduleId === 'G6');

    host.socket.emit('room:action', { type: 'START_LOADING', actorId: host.joined.playerId, stepKeys: ['general'] });
    await host.state.waitFor((state) => state.loading?.steps.every((step) => step.status === 'done') === true, 15_000);

    host.socket.emit('room:action', { type: 'START_SESSION', actorId: host.joined.playerId });
    const playing = await host.state.waitFor((state) => state.phase === 'playing', 15_000);
    expect(playing.round).not.toBeNull();

    host.socket.close();
  }, 30_000);

  it('a competition-scoped room only ever produces content that belongs to that competition, across several rounds', async () => {
    const expectedPlayerIds = playerIdsForCompetition(referenceDataset, 'la-liga');
    expect(expectedPlayerIds.size).toBeGreaterThan(0);

    const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({
        category: 'general',
        competitionId: 'la-liga',
        hostNickname: 'Hosty',
        settings: { minPlayersToStart: 1, roundsPerSession: 5 },
      }),
    });
    expect(createRoom.status).toBe(201);
    const { roomToken } = createRoom.body as { roomToken: string };

    const host = await connectAndTrack<ProjectedRoom>(server, { mode: 'reconnect', roomToken });
    host.socket.emit('room:action', { type: 'SELECT_GAME', actorId: host.joined.playerId, moduleId: 'G1', config: null });
    await host.state.waitFor((state) => state.selection?.moduleId === 'G1');

    host.socket.emit('room:action', { type: 'START_LOADING', actorId: host.joined.playerId, stepKeys: ['general'] });
    await host.state.waitFor((state) => state.loading?.steps.every((step) => step.status === 'done') === true, 15_000);

    host.socket.emit('room:action', { type: 'START_SESSION', actorId: host.joined.playerId });
    let playing = await host.state.waitFor((state) => state.phase === 'playing', 15_000);

    for (let round = 0; round < 5; round += 1) {
      expect(playing.round?.visibility).toBe('pre-reveal');
      const preReveal = playing.round as ProjectedRoundPreReveal;
      const options = preReveal.publicPayload as { options: { playerId: string }[] };
      expect(options.options.length).toBeGreaterThan(0);
      for (const option of options.options) {
        expect(expectedPlayerIds.has(option.playerId)).toBe(true);
      }

      const roundId = playing.round!.id;
      host.socket.emit('room:action', {
        type: 'SUBMIT_ANSWER',
        playerId: host.joined.playerId,
        roundId,
        payload: { playerId: options.options[0]!.playerId },
      });
      await host.state.waitFor((state) => state.round?.status === 'resolved', 15_000);

      host.socket.emit('room:action', { type: 'ADVANCE', actorId: host.joined.playerId });
      await host.state.waitFor((state) => state.phase === 'intermission', 15_000);

      if (round < 4) {
        host.socket.emit('room:action', { type: 'ADVANCE', actorId: host.joined.playerId });
        playing = await host.state.waitFor(
          (state) => state.phase === 'playing' && state.round?.id !== roundId,
          15_000,
        );
      }
    }

    host.socket.close();
  }, 60_000);

  it("a scoped room's game availability differs from the combined dataset for a competition with thinner career data", async () => {
    // The recorded fixture dataset's bundesliga slice has no career-history coverage (see
    // `general-scope.ts`'s doc comment on the team join) — thin enough that G3 (needs
    // `hasCareerHistory`) is unavailable when scoped to it, even though the combined dataset (every
    // competition's career data pooled together) comfortably clears the threshold.
    const scopedRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({
        category: 'general',
        competitionId: 'bundesliga',
        hostNickname: 'Hosty',
        settings: { minPlayersToStart: 1 },
      }),
    });
    expect(scopedRoom.status).toBe(201);
    const scopedToken = (scopedRoom.body as { roomToken: string }).roomToken;
    const scopedHost = await connectAndTrack<ProjectedRoom>(server, { mode: 'reconnect', roomToken: scopedToken });

    const scopedRejected = waitForEvent<{ code: string }>(scopedHost.socket, 'room:error');
    scopedHost.socket.emit('room:action', { type: 'SELECT_GAME', actorId: scopedHost.joined.playerId, moduleId: 'G3', config: null });
    const scopedError = await scopedRejected;
    expect(scopedError.code).toBe('DATA_UNAVAILABLE');
    scopedHost.socket.close();

    const combinedRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ category: 'general', hostNickname: 'Hosty', settings: { minPlayersToStart: 1 } }),
    });
    expect(combinedRoom.status).toBe(201);
    const combinedToken = (combinedRoom.body as { roomToken: string }).roomToken;
    const combinedHost = await connectAndTrack<ProjectedRoom>(server, { mode: 'reconnect', roomToken: combinedToken });

    combinedHost.socket.emit('room:action', { type: 'SELECT_GAME', actorId: combinedHost.joined.playerId, moduleId: 'G3', config: null });
    const selected = await combinedHost.state.waitFor((state) => state.selection?.moduleId === 'G3', 5_000);
    expect(selected.selection?.moduleId).toBe('G3');
    combinedHost.socket.close();
  }, 30_000);

  it('a team playing in two competitions at once is not dropped from either scoped view (regression for the single-competition-per-team bug)', async () => {
    const multi = teamsInMultipleCompetitions(referenceDataset);
    expect(multi.size).toBeGreaterThan(0);

    const liverpool = referenceDataset.teams.find((team) => team.name === 'Liverpool');
    expect(liverpool).toBeDefined();
    const liverpoolCompetitions = multi.get(liverpool!.id);
    expect(liverpoolCompetitions).toBeDefined();
    expect(liverpoolCompetitions!.has('premier-league')).toBe(true);
    expect(liverpoolCompetitions!.has('champions-league')).toBe(true);

    // At least one more dual-competition team (e.g. Atlético Madrid / la-liga+champions-league, or
    // Paris Saint-Germain / ligue-1+champions-league), so this isn't a single-team coincidence.
    const otherMulti = [...multi.entries()].find(([teamId]) => teamId !== liverpool!.id);
    expect(otherMulti).toBeDefined();
    const [otherTeamId, otherCompetitions] = otherMulti!;
    const otherCompetitionIds = [...otherCompetitions];
    expect(otherCompetitionIds.length).toBeGreaterThan(1);

    // Exercise the module under test directly, so this is a deterministic check of the scoped
    // dataset's actual contents rather than something dependent on a game round's random draw
    // happening to include this team.
    const expectTeamSurvivesScopedView = (competitionId: string, teamId: string): void => {
      const expectedPlayerIds = playerIdsForCompetition(referenceDataset, competitionId);
      const teamPlayerIds = new Set(
        referenceDataset.players.filter((player) => player.teamId === teamId).map((player) => player.id),
      );
      expect(teamPlayerIds.size).toBeGreaterThan(0);
      for (const playerId of teamPlayerIds) {
        expect(expectedPlayerIds.has(playerId)).toBe(true);
      }

      const scoped = getScopedGeneralDataset(referenceDataset, asCompetitionId(competitionId));
      expect(scoped.teams.some((team) => team.id === teamId)).toBe(true);
      const scopedPlayerIds = new Set(scoped.players.map((player) => player.id));
      for (const playerId of teamPlayerIds) {
        expect(scopedPlayerIds.has(playerId)).toBe(true);
      }
    };

    expectTeamSurvivesScopedView('premier-league', liverpool!.id);
    expectTeamSurvivesScopedView('champions-league', liverpool!.id);
    for (const competitionId of otherCompetitionIds) {
      expectTeamSurvivesScopedView(competitionId, otherTeamId);
    }
  }, 60_000);

  it('the filtered-view cache never leaks between two rooms scoped to different competitions', async () => {
    const laLigaPlayerIds = playerIdsForCompetition(referenceDataset, 'la-liga');
    const serieAPlayerIds = playerIdsForCompetition(referenceDataset, 'serie-a');
    expect([...laLigaPlayerIds].some((id) => serieAPlayerIds.has(id))).toBe(false);

    const createScoped = async (competitionId: string) => {
      const created = await jsonFetch(`${server.baseUrl}/rooms`, {
        method: 'POST',
        body: JSON.stringify({
          category: 'general',
          competitionId,
          hostNickname: 'Hosty',
          settings: { minPlayersToStart: 1, roundsPerSession: 1 },
        }),
      });
      expect(created.status).toBe(201);
      return (created.body as { roomToken: string }).roomToken;
    };

    // Created back-to-back, deliberately interleaved, so a per-request or first-write-wins cache bug
    // would show up as room B seeing room A's competition (or vice versa).
    const tokenA = await createScoped('la-liga');
    const tokenB = await createScoped('serie-a');

    const playOneRound = async (roomToken: string, expectedIds: Set<string>): Promise<void> => {
      const host = await connectAndTrack<ProjectedRoom>(server, { mode: 'reconnect', roomToken });
      host.socket.emit('room:action', { type: 'SELECT_GAME', actorId: host.joined.playerId, moduleId: 'G1', config: null });
      await host.state.waitFor((state) => state.selection?.moduleId === 'G1');
      host.socket.emit('room:action', { type: 'START_LOADING', actorId: host.joined.playerId, stepKeys: ['general'] });
      await host.state.waitFor((state) => state.loading?.steps.every((step) => step.status === 'done') === true, 15_000);
      host.socket.emit('room:action', { type: 'START_SESSION', actorId: host.joined.playerId });
      const playing = await host.state.waitFor((state) => state.phase === 'playing', 15_000);
      const preReveal = playing.round as ProjectedRoundPreReveal;
      const options = preReveal.publicPayload as { options: { playerId: string }[] };
      for (const option of options.options) {
        expect(expectedIds.has(option.playerId)).toBe(true);
      }
      host.socket.close();
    };

    await playOneRound(tokenB, serieAPlayerIds);
    await playOneRound(tokenA, laLigaPlayerIds);
  }, 60_000);
});
