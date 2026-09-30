/**
 * Phase 5: live-event ingestion against the replay provider. A recorded match (PSG 6-1 Slovan
 * Bratislava) is played through a REAL room running M1 Match Markets; the ingestion loop polls the
 * replay on an injected clock, dispatches MATCH_EVENTS, and we assert events arrive, markets settle
 * at the right moments, and repeated polls never double-settle.
 */
import { FixtureProvider, createNodeDataSource } from '@fdg/football-data';
import type { LiveScheduler } from '../src/live/ingestion.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestServer } from './helpers.js';
import { connectAndTrack, jsonFetch, startTestServer } from './helpers.js';

const FIXTURE_ID = '401915445';

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
  /** Fire every timer due within `ms`, in order (each fired timer may arm the next). */
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
  return { scheduler, advance, pending: () => timers.size };
};

interface Settlement {
  readonly marketId: string;
  readonly optionId: string;
  readonly outcome: 'WON' | 'LOST';
}
interface M1Public {
  readonly markets: readonly { id: string; kind: string; options: readonly { id: string }[] }[];
  readonly counters: { homeGoals: number; awayGoals: number; fullTime: boolean; halfTimeRecorded: boolean; corners: number };
  readonly settlements: readonly Settlement[];
  readonly slipLocked: boolean;
}
interface RoomView {
  readonly phase: string;
  readonly selection: { moduleId: string } | null;
  readonly loading: { steps: readonly { status: string }[] } | null;
  readonly round: {
    id: string;
    status: string;
    visibility: string;
    publicPayload: M1Public;
  } | null;
}

describe('live ingestion loop with the replay provider (M1)', () => {
  let server: TestServer;
  let provider: FixtureProvider;
  const fake = createFakeScheduler();
  let liveCalls = 0;

  beforeAll(async () => {
    provider = new FixtureProvider({
      dataSource: createNodeDataSource(),
      replay: { fixtureId: FIXTURE_ID, autoStart: false, startMinute: 0 },
    });
    await provider.ready();
    const original = provider.getLiveMatchState.bind(provider);
    provider.getLiveMatchState = async (id) => {
      liveCalls += 1;
      return original(id);
    };
    server = await startTestServer({
      footballData: provider,
      liveScheduler: fake.scheduler,
      liveIngestion: { liveIntervalMs: 15_000, preKickoffIntervalMs: 15_000, jitterRatio: 0 },
    });
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  it('fires events into the room, settles markets at the right moments, never double-settles, and stops at full time', async () => {
    const ingestion = server.ctx.liveIngestion;
    expect(ingestion).toBeDefined();
    const idle = (): Promise<void> => ingestion!.idle();
    const replay = provider.matchReplay()!;
    expect(replay).not.toBeNull();

    const created = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({
        category: 'matchday',
        fixtureId: FIXTURE_ID,
        hostNickname: 'Hosty',
        settings: { minPlayersToStart: 1 },
      }),
    });
    expect(created.status).toBe(201);
    const { roomToken, roomId } = created.body as { roomToken: string; roomId: string };
    const host = await connectAndTrack<RoomView>(server, { mode: 'reconnect', roomToken });
    const playerId = host.joined.playerId;

    host.socket.emit('room:action', {
      type: 'SELECT_GAME',
      actorId: playerId,
      moduleId: 'M1',
      config: {
        markets: ['MATCH_RESULT', 'HT_RESULT', 'BTTS', 'OVER_UNDER_GOALS', 'OVER_UNDER_CORNERS'],
        goalsLine: 2.5,
        cornersLine: 9.5,
        cardsLine: 3.5,
        scorerOptionCount: 5,
        slipWindowMs: 3_600_000,
        sipsPerLostMarket: 1,
        worstSlipSips: 3,
        perfectSlipSips: 2,
        noAnswerSips: 4,
      },
    });
    await host.state.waitFor((s) => s.selection?.moduleId === 'M1', 15_000);
    host.socket.emit('room:action', {
      type: 'START_LOADING',
      actorId: playerId,
      stepKeys: ['fixture', 'lineups', 'squads', 'stats'],
    });
    const loaded = await host.state.waitFor(
      (s) => s.loading?.steps.every((step) => step.status === 'done' || step.status === 'failed') === true,
      30_000,
    );
    expect(loaded.loading?.steps.every((step) => step.status === 'done')).toBe(true);
    host.socket.emit('room:action', { type: 'START_SESSION', actorId: playerId });
    const playing = await host.state.waitFor((s) => s.round?.status === 'open', 15_000);
    const round = playing.round!;
    expect(round.publicPayload.slipLocked).toBe(false);

    // The room needs the fixture, so exactly one watcher exists and its first poll is armed.
    expect(ingestion!.watchedFixtureIds()).toEqual([FIXTURE_ID]);

    // File a slip (first option of every market), before any event is polled.
    host.socket.emit('room:action', {
      type: 'SUBMIT_ANSWER',
      playerId,
      roundId: round.id,
      payload: { picks: round.publicPayload.markets.map((m) => ({ marketId: m.id, optionId: m.options[0]!.id })) },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const view = async (): Promise<M1Public> => {
      const record = await server.ctx.roomStore.load(roomId as never);
      const current = record!.state.sessions[0]!.rounds[0]!;
      return current.publicPayload as M1Public;
    };

    let previousSettled = 0;
    let sawSettlementMidMatch = false;
    const checkpoints = [1, 20, 45, 46, 60, 75, 90];
    for (const minute of checkpoints) {
      replay.advanceTo(minute);
      await fake.advance(15_000, idle);
      const payload = await view();
      const expected = replay.fixture().score!;
      // Events arrived: counters track the replay's own score at this minute.
      expect(payload.counters.homeGoals).toBe(expected.home);
      expect(payload.counters.awayGoals).toBe(expected.away);
      expect(payload.slipLocked).toBe(true);
      // Settlements are monotonic and unique per option.
      expect(payload.settlements.length).toBeGreaterThanOrEqual(previousSettled);
      const keys = payload.settlements.map((s) => `${s.marketId}:${s.optionId}`);
      expect(new Set(keys).size).toBe(keys.length);
      if (minute < 90 && payload.settlements.length > 0) sawSettlementMidMatch = true;

      // Repeated polls at the same match minute change nothing (no double settle / double penalty).
      const before = await server.ctx.roomStore.load(roomId as never);
      for (let i = 0; i < 3; i += 1) await fake.advance(15_000, idle);
      const after = await server.ctx.roomStore.load(roomId as never);
      expect(after!.state.sessions[0]!.rounds[0]!.publicPayload).toEqual(before!.state.sessions[0]!.rounds[0]!.publicPayload);
      expect(after!.state.sessions[0]!.sipsByPlayer).toEqual(before!.state.sessions[0]!.sipsByPlayer);
      previousSettled = payload.settlements.length;

      // HT result must not settle before the half-time marker has been observed.
      const ht = payload.markets.find((m) => m.kind === 'HT_RESULT');
      if (ht !== undefined && !payload.counters.halfTimeRecorded) {
        expect(payload.settlements.some((s) => s.marketId === ht.id)).toBe(false);
      }
    }
    expect(sawSettlementMidMatch).toBe(true);

    // Full time: the final poll lands FULL_TIME, everything settles and the round resolves.
    replay.advanceTo(replay.status().finalMinute);
    await fake.advance(15_000, idle);
    const final = await host.state.waitFor((s) => s.round?.status === 'resolved', 15_000);
    expect(final.round!.visibility).toBe('revealed');
    const finalPayload = await view();
    expect(finalPayload.counters.fullTime).toBe(true);
    expect(finalPayload.settlements.length).toBe(
      finalPayload.markets.reduce((n, m) => n + m.options.length, 0),
    );

    // The loop stops itself: no watcher, no armed timers.
    await idle();
    expect(ingestion!.watchedFixtureIds()).toEqual([]);
    expect(fake.pending()).toBe(0);
    // ...and stays stopped: no further provider polls however much time passes.
    const callsAtStop = liveCalls;
    expect(callsAtStop).toBeGreaterThan(checkpoints.length);
    await fake.advance(120_000, idle);
    expect(liveCalls).toBe(callsAtStop);

    host.socket.close();
  }, 120_000);
});
