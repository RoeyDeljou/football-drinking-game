import type { ProjectedRoom } from '@fdg/game-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import type { TestServer } from './helpers.js';
import { connectAndTrack, jsonFetch, startTestServer } from './helpers.js';

/**
 * Regression test: `runLoadingPipeline` (apps/api/src/realtime/loading.ts) is started
 * fire-and-forget from `room:action`'s `START_LOADING` handler in gateway.ts — the loading screen
 * advances through its own later `LOADING_PROGRESS`/`LOADING_FAILED` dispatches, not through
 * START_LOADING's own response. A throw anywhere inside the pipeline (here: `ctx.generalDataset()`,
 * the real production trigger QA used to independently reproduce this) previously had no caller to
 * catch it, leaving the host stuck on the loading screen forever with zero client feedback — no
 * `room:state`, no `room:error`. This forces that failure and asserts the host instead sees the
 * loading step marked failed (the same mechanism an ordinary "could not load the fixture" failure
 * already uses), never silence.
 */
describe('loading pipeline error handling', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  it('marks the loading step failed instead of stranding the host when the pipeline throws', async () => {
    const createRoom = await jsonFetch(`${server.baseUrl}/rooms`, {
      method: 'POST',
      body: JSON.stringify({
        category: 'general',
        hostNickname: 'Hosty',
        settings: { minPlayersToStart: 1 },
      }),
    });
    expect(createRoom.status).toBe(201);
    const { roomToken, hostPlayerId } = createRoom.body as { roomToken: string; hostPlayerId: string };

    const host = await connectAndTrack<ProjectedRoom>(server, { mode: 'reconnect', roomToken });
    expect(host.joined.isHost).toBe(true);

    host.socket.emit('room:action', {
      type: 'SELECT_GAME',
      actorId: hostPlayerId,
      moduleId: 'G6',
      config: null,
    });
    await host.state.waitFor((state) => state.selection?.moduleId === 'G6', 5_000);

    // Force the real production trigger: a data-layer hiccup surfacing from
    // apps/api/src/engine/data-context.ts's `ctx.generalDataset()` call. Every dispatch on a room
    // with a 'general' selection resolves that category and calls `ctx.generalDataset()` again (via
    // `buildEngineDeps`/`buildRoundDataContext`) regardless of the action type — so simply "always
    // throw" fails the START_LOADING dispatch itself (already covered by
    // room-action-error-handling.test.ts) rather than the fire-and-forget pipeline this test exists
    // to guard. Instead: let every call through except the pipeline's own direct
    // `await ctx.generalDataset()` in loading.ts's 'general' branch — call #3, after (1) the
    // START_LOADING dispatch's own resolution and (2) the pipeline's single LOADING_PROGRESS('active')
    // dispatch for its one requested step — so the failure lands exactly inside the pipeline, and the
    // recovery LOADING_FAILED dispatch afterward still succeeds.
    const mutableCtx = server.ctx as { generalDataset: AppContext['generalDataset'] };
    const originalGeneralDataset = mutableCtx.generalDataset.bind(server.ctx);
    let calls = 0;
    mutableCtx.generalDataset = async () => {
      calls += 1;
      if (calls === 3) throw new Error('simulated data-layer failure');
      return originalGeneralDataset();
    };

    host.socket.emit('room:action', {
      type: 'START_LOADING',
      actorId: hostPlayerId,
      stepKeys: ['general'],
    });

    const failedState = await host.state.waitFor(
      (state) => state.loading?.failedReason !== null && state.loading?.failedReason !== undefined,
      5_000,
    );
    expect(failedState.phase).toBe('loading');
    expect(failedState.loading?.failedReason).toBeTruthy();

    host.socket.close();
  }, 30_000);
});
