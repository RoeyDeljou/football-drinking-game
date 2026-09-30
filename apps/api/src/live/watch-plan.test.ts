import { asFixtureId } from '@fdg/football-data';
import type { CompetitionId } from '@fdg/football-data';
import type { EngineGameModule, RoomId, RoomState } from '@fdg/game-core';
import { describe, expect, it } from 'vitest';
import type { RoomMeta } from '../rooms/store.js';
import { planWatch } from './watch-plan.js';

const state = (over: { phase?: string; roundStatus?: string; finishedAt?: number | null } = {}): RoomState =>
  ({
    id: 'room' as RoomId,
    phase: over.phase ?? 'playing',
    activeSessionIndex: 0,
    sessions: [
      { id: 's1', finishedAt: over.finishedAt ?? null, moduleId: 'M1', rounds: [{ id: 'r0', status: 'done' }, { id: 'r1', status: over.roundStatus ?? 'open' }] },
    ],
  }) as unknown as RoomState;

const live = { supportsLiveEvents: true } as EngineGameModule;
const lookups = (module: EngineGameModule | null) => ({
  moduleFor: () => module,
  gamedayPinnedFixture: (_r: RoomId, s: number, r: number) => (s === 0 && r === 1 ? asFixtureId('pinned') : null),
});
const single: RoomMeta = { fixtureId: asFixtureId('fx') };
const gameday: RoomMeta = { fixtureId: null, gamedayCompetitionId: 'pl' as unknown as CompetitionId };

describe('planWatch', () => {
  it('watches the fixture for an open round of a live-event module', () => {
    expect(planWatch(state(), single, lookups(live)).map((n) => n.fixtureId)).toEqual(['fx']);
  });
  it('watches nothing unless playing, unfinished, open, live-capable', () => {
    expect(planWatch(state({ phase: 'lobby' }), single, lookups(live))).toEqual([]);
    expect(planWatch(state({ finishedAt: 5 }), single, lookups(live))).toEqual([]);
    expect(planWatch(state({ roundStatus: 'resolved' }), single, lookups(live))).toEqual([]);
    expect(planWatch(state(), single, lookups({ supportsLiveEvents: false } as EngineGameModule))).toEqual([]);
    expect(planWatch(state(), { fixtureId: null }, lookups(live))).toEqual([]);
  });
  it('gameday rooms watch the current round pinned fixture', () => {
    expect(planWatch(state(), gameday, lookups(live)).map((n) => n.fixtureId)).toEqual(['pinned']);
  });
  it('gameday rooms with no pin watch nothing (never the rotation pool)', () => {
    const unpinned = { ...lookups(live), gamedayPinnedFixture: () => null };
    expect(planWatch(state(), gameday, unpinned)).toEqual([]);
  });
  it('round key changes with the round', () => {
    const a = planWatch(state(), single, lookups(live))[0]?.roundKey;
    expect(a).toBe('s1:r1');
  });
});
