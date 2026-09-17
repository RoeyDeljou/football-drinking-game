import { describe, expect, it } from 'vitest';
import type { RoomAction } from './actions.js';
import { asPlayerId } from './ids.js';
import { G1_ID } from './modules/g1-guess-the-player.js';
import { M3_ID } from './modules/m3-shirt-number.js';
import { projectFor, projectForHostScreen } from './projection.js';
import type { EngineDeps } from './reducer.js';
import { reduceAll, reduceRoom } from './reducer.js';
import type { RoomState } from './state.js';
import { currentRound } from './state.js';
import { HOST, makeHarness, newRoom, P2, T0 } from './harness.test-utils.js';

const setup = (moduleId: typeof M3_ID, now = T0) => {
  const harness = makeHarness({ now });
  const actions: readonly RoomAction[] = [
    { type: 'PLAYER_JOIN', playerId: P2, nickname: 'Bea', isGuest: true },
    { type: 'SELECT_GAME', actorId: HOST, moduleId, config: null },
    { type: 'START_SESSION', actorId: HOST },
  ];
  const result = reduceAll(newRoom(now, 5), actions, harness.deps);
  expect(result.rejection).toBeNull();
  return { ...harness, room: result.state };
};

const submit = (room: RoomState, deps: EngineDeps, playerId: typeof HOST, payload: unknown): RoomState => {
  const round = currentRound(room);
  expect(round).toBeDefined();
  const result = reduceRoom(
    room,
    { type: 'SUBMIT_ANSWER', playerId, roundId: round?.id ?? (room.id as never), payload },
    deps,
  );
  expect(result.rejection).toBeNull();
  return result.state;
};

describe('pre-reveal projection', () => {
  it('never carries a solution field — not even as null', () => {
    const { room, deps } = setup(M3_ID);
    const view = projectFor(room, HOST, deps);
    expect(view.round?.visibility).toBe('pre-reveal');
    expect(view.round === null ? {} : view.round).not.toHaveProperty('solution');
    expect(JSON.stringify(view)).not.toContain('solution');
    expect(JSON.stringify(view)).not.toContain('"shirtNumber":1');
  });

  it('hides the shirt number and the footballer id inside the public payload', () => {
    const { room, deps } = setup(M3_ID);
    const view = projectFor(room, HOST, deps);
    const payload = view.round?.publicPayload as { target: Record<string, unknown> };
    expect(payload.target).not.toHaveProperty('shirtNumber');
    expect(payload.target).not.toHaveProperty('playerId');
    expect(Object.keys(payload.target).sort()).toEqual(['isStarter', 'name', 'position', 'teamId']);
  });

  it('shows that a rival has answered without revealing what they picked', () => {
    const { room, deps } = setup(M3_ID);
    const answered = submit(room, deps, P2, { guess: 7 });
    const view = projectFor(answered, HOST, deps);
    expect(view.round?.submissionStatus).toEqual([
      { playerId: HOST, submitted: false, submittedAt: null },
      { playerId: P2, submitted: true, submittedAt: T0 },
    ]);
    expect(view.round?.yourSubmission).toBeNull();
    expect(JSON.stringify(view.round)).not.toContain('"guess"');
  });

  it('shows a player their own submission', () => {
    const { room, deps } = setup(M3_ID);
    const answered = submit(room, deps, HOST, { guess: 4 });
    expect(projectFor(answered, HOST, deps).round?.yourSubmission).toEqual({ guess: 4 });
  });

  it('gives the shared big-screen view no private payload and no personal answer', () => {
    const { room, deps } = setup(M3_ID);
    const answered = submit(room, deps, HOST, { guess: 4 });
    const screen = projectForHostScreen(answered, deps);
    expect(screen.viewerId).toBeNull();
    expect(screen.you).toBeNull();
    expect(screen.round?.privatePayload).toBeNull();
    expect(screen.round?.yourSubmission).toBeNull();
  });

  it('reports an unknown viewer as having no seat at the table', () => {
    const { room, deps } = setup(M3_ID);
    expect(projectFor(room, asPlayerId('stranger'), deps).you).toBeNull();
  });
});

describe('revealed projection', () => {
  it('adds the solution, every pick, the outcome and the round penalties', () => {
    const { room, deps } = setup(M3_ID);
    let next = submit(room, deps, HOST, { guess: 4 });
    next = submit(next, deps, P2, { guess: 9 });
    expect(next.phase).toBe('roundReveal');

    const view = projectFor(next, HOST, deps);
    expect(view.round?.visibility).toBe('revealed');
    if (view.round?.visibility !== 'revealed') throw new Error('expected a revealed round');
    expect(view.round.solution).toHaveProperty('shirtNumber');
    expect(view.round.submissions.map((entry) => entry.payload)).toEqual([{ guess: 4 }, { guess: 9 }]);
    expect(view.round.outcome?.winnerIds.length).toBeGreaterThan(0);
    expect(view.round.penalties.every((entry) => entry.roundId === view.round?.id)).toBe(true);
  });

  it('exposes the leaderboard and the drink tally', () => {
    const { room, deps } = setup(M3_ID);
    let next = submit(room, deps, HOST, { guess: 4 });
    next = submit(next, deps, P2, { guess: 40 });
    const view = projectFor(next, P2, deps);
    expect(view.leaderboard).toHaveLength(2);
    expect(view.leaderboard[0]?.rank).toBe(1);
    expect(view.drinkTally.map((row) => row.playerId).sort()).toEqual([HOST, P2].sort());
    expect(view.you?.rank).not.toBeNull();
  });
});

describe('progressive disclosure (G1)', () => {
  it('unlocks clues over time and shows them all at reveal', () => {
    const { room, deps, clock } = setup(G1_ID);
    const atStart = projectFor(room, HOST, deps).round?.publicPayload as { clues: readonly unknown[] };
    expect(atStart.clues).toHaveLength(1);

    clock.advance(8_000);
    const later = projectFor(room, HOST, deps).round?.publicPayload as { clues: readonly unknown[] };
    expect(later.clues).toHaveLength(2);

    clock.advance(100_000);
    const all = projectFor(room, HOST, deps).round?.publicPayload as { clues: readonly unknown[] };
    expect(all.clues.length).toBeGreaterThan(2);
    // Still no solution, however long the round has been open.
    expect(JSON.stringify(projectFor(room, HOST, deps))).not.toContain('solution');
  });
});

describe('room-level projection', () => {
  it('projects the lobby with no session and no round', () => {
    const { deps } = makeHarness();
    const view = projectFor(newRoom(), HOST, deps);
    expect(view.phase).toBe('lobby');
    expect(view.session).toBeNull();
    expect(view.round).toBeNull();
    expect(view.you?.isHost).toBe(true);
    expect(view.players).toHaveLength(1);
  });

  it('marks who the host is and who has left', () => {
    const { deps } = makeHarness();
    const room = reduceAll(
      newRoom(),
      [
        { type: 'PLAYER_JOIN', playerId: P2, nickname: 'Bea', isGuest: true },
        { type: 'PLAYER_LEAVE', playerId: P2 },
      ],
      deps,
    ).state;
    const view = projectFor(room, HOST, deps);
    expect(view.players.find((player) => player.id === HOST)?.isHost).toBe(true);
    expect(view.players.find((player) => player.id === P2)?.hasLeft).toBe(true);
    expect(view.drinkTally).toHaveLength(1);
  });
});
