import { describe, expect, it } from 'vitest';

import { createManualClock } from './clock.js';
import type { Fixture, LiveMatchState, MatchEvent } from './domain.js';
import { asFixtureId, asTeamId } from './domain.js';
import { EspnProvider } from './espn/espn-provider.js';
import { loadEspnRawSample } from './espn/raw-samples.js';
import { goalsMatchScore, guaranteeFullTime, isSyntheticEvent, syntheticFullTimeId, withGuaranteedFullTime } from './full-time.js';
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
    fixture: { status, id: FIXTURE, score: { home: 1, away: 0 }, homeTeam: { id: asTeamId('1') } } as Fixture,
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

describe('EspnProvider — never synthesize an unsafe FULL_TIME', () => {
  type Play = { type?: { type?: string }; clock?: { displayValue?: string } };
  interface Sample {
    header: { competitions: { status: { type: Record<string, unknown> } }[] };
    keyEvents: Play[];
    commentary: { play?: Play; time?: { displayValue?: string } }[];
  }
  const sample = (): Sample => structuredClone(loadEspnRawSample('summary-finished-psg-slovan')) as Sample;
  const dropFullTime = (raw: Sample): Sample => {
    raw.keyEvents = raw.keyEvents.filter((e) => e.type?.type !== 'end-regular-time');
    raw.commentary = raw.commentary.filter((c) => c.play?.type?.type !== 'end-regular-time');
    return raw;
  };
  function providerFor(body: unknown): EspnProvider {
    const http: HttpClient = {
      request: (): Promise<HttpResponse> => Promise.resolve({ status: 200, body, headers: {} }),
    };
    return new EspnProvider({ http, clock: createManualClock() });
  }
  const live = async (body: unknown): Promise<LiveMatchState> => {
    const result = await providerFor(body).getLiveMatchState(FIXTURE);
    if (!result.ok || result.value === null) throw new Error('no live state');
    return result.value;
  };

  it('a lagging post summary missing the 87th-minute goal is not settled: no synthetic FULL_TIME', async () => {
    const raw = dropFullTime(sample());
    raw.keyEvents = raw.keyEvents.filter((e) => !(e.type?.type === 'goal' && e.clock?.displayValue === "87'"));
    raw.commentary = raw.commentary.filter((c) => !(c.play?.type?.type === 'goal' && c.time?.displayValue === "87'"));
    const state = await live(raw);
    expect(state.fixture.status).toBe('FINISHED');
    expect(state.fixture.score).toEqual({ home: 6, away: 1 });
    expect(fullTimeCount(state.events)).toBe(0);
  });

  it('a post summary with no plays but a non-zero score gets no synthetic FULL_TIME', async () => {
    const raw = sample();
    raw.keyEvents = [];
    raw.commentary = [];
    const state = await live(raw);
    expect(fullTimeCount(state.events)).toBe(0);
  });

  it('the consistent recorded sample without its full-time play still gets the synthetic one', async () => {
    const state = await live(dropFullTime(sample()));
    expect(state.events.at(-1)?.id).toBe(syntheticFullTimeId(FIXTURE));
  });

  it('a suspended match (unknown name, post, completed:false) is not FINISHED and gets no FULL_TIME', async () => {
    const raw = dropFullTime(sample());
    raw.header.competitions[0]!.status.type = {
      id: 'x', name: 'STATUS_SUSPENDED', state: 'post', completed: false, description: 'Suspended', detail: 'Susp', shortDetail: 'Susp',
    };
    const state = await live(raw);
    expect(state.fixture.status).not.toBe('FINISHED');
    expect(fullTimeCount(state.events)).toBe(0);
  });

  it('a bare post with an unrecognised name and no completed flag is not a confirmed final: no synthetic', async () => {
    const raw = dropFullTime(sample());
    raw.header.competitions[0]!.status.type = { id: 'x', name: 'STATUS_SOMETHING', state: 'post' };
    const state = await live(raw);
    expect(fullTimeCount(state.events)).toBe(0);
  });

  it('incomplete post summaries stay on the short TTL; only a provably complete one is cached for hours', async () => {
    const requests: number[] = [];
    const bodies: unknown[] = [];
    const clock = createManualClock(Date.parse('2026-09-09T22:00:00Z')); // ~3h after the 19:00 kickoff
    const http: HttpClient = {
      request: (): Promise<HttpResponse> => {
        requests.push(1);
        return Promise.resolve({ status: 200, body: bodies[Math.min(requests.length - 1, bodies.length - 1)], headers: {} });
      },
    };
    const empty = sample();
    empty.keyEvents = [];
    empty.commentary = [];
    bodies.push(empty, sample());
    const provider = new EspnProvider({ http, clock });
    await provider.getLiveMatchState(FIXTURE);
    await clock.advance(16_000);
    await provider.getLiveMatchState(FIXTURE); // re-fetched (short TTL) and now complete
    expect(requests).toHaveLength(2);
    await clock.advance(60 * 60_000);
    await provider.getLiveMatchState(FIXTURE);
    expect(requests).toHaveLength(2); // complete summary cached for hours
  });
});

describe('goalsMatchScore', () => {
  it('credits own goals to the opponent and rejects unattributable goals', () => {
    const own: MatchEvent = { ...event('e1', 'OWN_GOAL', 10), teamId: asTeamId('2') };
    expect(goalsMatchScore([own], { home: 1, away: 0 }, '1')).toBe(true);
    expect(goalsMatchScore([{ ...event('e2', 'GOAL', 10), teamId: null }], { home: 1, away: 0 }, '1')).toBe(false);
  });
});
