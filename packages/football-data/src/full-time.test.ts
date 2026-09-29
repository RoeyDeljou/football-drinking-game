import { describe, expect, it } from 'vitest';

import { createManualClock } from './clock.js';
import type { Fixture, LiveMatchState, MatchEvent } from './domain.js';
import { asFixtureId, asTeamId } from './domain.js';
import { EspnProvider } from './espn/espn-provider.js';
import { loadEspnRawSample } from './espn/raw-samples.js';
import { guaranteeFullTime, isSyntheticEvent, syntheticFullTimeId, withGuaranteedFullTime } from './full-time.js';
import type { HttpClient, HttpRequest, HttpResponse } from './http.js';

const FIXTURE = asFixtureId('401915445');

function event(id: string, type: MatchEvent['type'], minute: number, extraMinute: number | null = null): MatchEvent {
  return {
    id,
    fixtureId: FIXTURE,
    type,
    minute,
    extraMinute,
    teamId: asTeamId('1'),
    playerId: null,
    playerName: null,
    relatedPlayerId: null,
    detail: null,
  };
}

const fullTimeCount = (events: readonly MatchEvent[]): number => events.filter((e) => e.type === 'FULL_TIME').length;

describe('withGuaranteedFullTime', () => {
  it('appends one synthetic FULL_TIME at minute 90 with a stable, non-colliding id when none exists', () => {
    const events = [event('espn:1', 'KICK_OFF', 1), event('espn:2', 'GOAL', 30), event('espn:3', 'HALF_TIME', 45)];
    const first = withGuaranteedFullTime(FIXTURE, events);
    const second = withGuaranteedFullTime(FIXTURE, events);
    expect(first).toHaveLength(4);
    const last = first.at(-1);
    expect(last?.type).toBe('FULL_TIME');
    expect(last?.id).toBe(syntheticFullTimeId(FIXTURE));
    expect(last?.id.startsWith('espn:')).toBe(false);
    expect(last?.minute).toBe(90);
    expect(last?.extraMinute).toBeNull();
    expect(second.at(-1)?.id).toBe(last?.id);
    expect(first.slice(0, 3)).toEqual(events);
  });

  it('reuses the latest event minute when play ran past 90', () => {
    const stoppage = withGuaranteedFullTime(FIXTURE, [event('espn:1', 'GOAL', 90, 6)]).at(-1);
    expect([stoppage?.minute, stoppage?.extraMinute]).toEqual([90, 6]);
    const extra = withGuaranteedFullTime(FIXTURE, [event('espn:1', 'GOAL', 118)]).at(-1);
    expect([extra?.minute, extra?.extraMinute]).toEqual([118, null]);
  });

  it('works on an empty event list', () => {
    const result = withGuaranteedFullTime(FIXTURE, []);
    expect(result).toHaveLength(1);
    expect(isSyntheticEvent(result[0] as MatchEvent)).toBe(true);
  });

  it('prefers a real FULL_TIME: keeps it untouched, adds nothing', () => {
    const events = [event('espn:1', 'GOAL', 10), event('espn:9', 'FULL_TIME', 90)];
    expect(withGuaranteedFullTime(FIXTURE, events)).toBe(events);
  });

  it('collapses several real FULL_TIME events to the last one and moves it last', () => {
    const events = [
      event('espn:8', 'FULL_TIME', 90), // end of regulation
      event('espn:9', 'GOAL', 105),
      event('espn:10', 'FULL_TIME', 120), // end of extra time
    ];
    const result = withGuaranteedFullTime(FIXTURE, events);
    expect(result.map((e) => e.id)).toEqual(['espn:9', 'espn:10']);
    expect(fullTimeCount(result)).toBe(1);
  });
});

describe('guaranteeFullTime', () => {
  const state = (status: Fixture['status'], events: readonly MatchEvent[]): LiveMatchState => ({
    fixture: { status, id: FIXTURE } as Fixture,
    events,
    teamStats: [],
    playerStats: [],
    updatedAt: '2026-09-16T20:00:00.000Z',
  });

  it('leaves a match that is still in progress alone', () => {
    const live = state('LIVE', [event('espn:1', 'GOAL', 10)]);
    expect(guaranteeFullTime(live)).toBe(live);
  });

  it('adds exactly one FULL_TIME to a FINISHED state', () => {
    expect(fullTimeCount(guaranteeFullTime(state('FINISHED', [event('espn:1', 'GOAL', 10)])).events)).toBe(1);
  });
});

describe('EspnProvider — FINISHED summaries always carry exactly one FULL_TIME', () => {
  interface Summaryish {
    keyEvents?: { type?: { type?: string } }[];
    commentary?: { play?: { type?: { type?: string } } }[];
  }
  function withoutFullTime(): unknown {
    const raw = structuredClone(loadEspnRawSample('summary-finished-psg-slovan')) as Summaryish;
    raw.keyEvents = (raw.keyEvents ?? []).filter((entry) => entry.type?.type !== 'end-regular-time');
    raw.commentary = (raw.commentary ?? []).filter((entry) => entry.play?.type?.type !== 'end-regular-time');
    return raw;
  }
  function scripted(bodies: readonly unknown[]): { http: HttpClient; requests: HttpRequest[] } {
    const requests: HttpRequest[] = [];
    return {
      requests,
      http: {
        request: (request: HttpRequest): Promise<HttpResponse> => {
          requests.push(request);
          const body = bodies[Math.min(requests.length - 1, bodies.length - 1)];
          return Promise.resolve({ status: 200, body, headers: {} });
        },
      },
    };
  }

  it('synthesizes a stable FULL_TIME, does not cache the incomplete post summary for hours, and swaps in the real one', async () => {
    const clock = createManualClock();
    const { http, requests } = scripted([withoutFullTime(), withoutFullTime(), loadEspnRawSample('summary-finished-psg-slovan')]);
    const provider = new EspnProvider({ http, clock });

    const first = await provider.getLiveMatchState(FIXTURE);
    expect(first.ok).toBe(true);
    if (!first.ok || first.value === null) return;
    expect(first.value.fixture.status).toBe('FINISHED');
    expect(fullTimeCount(first.value.events)).toBe(1);
    expect(first.value.events.at(-1)?.id).toBe(syntheticFullTimeId(FIXTURE));

    // Within the live TTL it is served from cache with the same id.
    const cached = await provider.getLiveMatchState(FIXTURE);
    expect(requests).toHaveLength(1);
    expect(cached.ok && cached.value?.events.at(-1)?.id).toBe(syntheticFullTimeId(FIXTURE));

    // Past the short live TTL it re-fetches (would be 6h if the incomplete summary had been cached long-term).
    await clock.advance(16_000);
    const second = await provider.getLiveMatchState(FIXTURE);
    expect(requests).toHaveLength(2);
    expect(second.ok && second.value?.events.at(-1)?.id).toBe(syntheticFullTimeId(FIXTURE));

    // Once ESPN publishes the real play, the real event replaces the synthetic one (still exactly one).
    await clock.advance(16_000);
    const third = await provider.getLiveMatchState(FIXTURE);
    expect(requests).toHaveLength(3);
    if (!third.ok || third.value === null) return;
    expect(fullTimeCount(third.value.events)).toBe(1);
    const real = third.value.events.at(-1);
    expect(real?.id.startsWith('espn:')).toBe(true);
    expect(third.value.events.some(isSyntheticEvent)).toBe(false);

    // A complete finished summary is now cached long-term.
    await clock.advance(60_000);
    await provider.getLiveMatchState(FIXTURE);
    expect(requests).toHaveLength(3);
  });

  it('getMatchEvents gives the same guarantee', async () => {
    const { http } = scripted([withoutFullTime()]);
    const provider = new EspnProvider({ http, clock: createManualClock() });
    const events = await provider.getMatchEvents(FIXTURE);
    expect(events.ok && fullTimeCount(events.value)).toBe(1);
  });
});
