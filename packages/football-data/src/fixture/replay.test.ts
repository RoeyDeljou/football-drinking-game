import { describe, expect, it } from 'vitest';

import { createManualClock } from '../clock.js';
import {
  asCompetitionId,
  asFixtureId,
  asFootballPlayerId,
  asSeasonId,
  asTeamId,
  type Fixture,
  type MatchEvent,
} from '../domain.js';
import type { RecordedMatchTimeline } from './recorded-schema.js';
import type { MatchReplayOptions } from './replay.js';
import { buildElapsedAxis, MatchReplay } from './replay.js';

const HOME = asTeamId('home');
const AWAY = asTeamId('away');
const SCORER = asFootballPlayerId('scorer');
const OFF_PLAYER = asFootballPlayerId('off');
const ON_PLAYER = asFootballPlayerId('on');

function event(overrides: Partial<MatchEvent>): MatchEvent {
  return {
    id: `evt-${String(Math.random())}`,
    fixtureId: asFixtureId('f1'),
    type: 'FOUL',
    minute: 0,
    extraMinute: null,
    teamId: null,
    playerId: null,
    playerName: null,
    relatedPlayerId: null,
    detail: null,
    ...overrides,
  };
}

const baseFixture: Fixture = {
  id: asFixtureId('f1'),
  competitionId: asCompetitionId('premier-league'),
  season: asSeasonId('2026/27'),
  kickoff: '2026-09-16T15:00:00.000Z',
  status: 'SCHEDULED',
  minute: null,
  homeTeam: { id: HOME, name: 'Home FC', shortName: 'HOM', crestUrl: null, country: null },
  awayTeam: { id: AWAY, name: 'Away FC', shortName: 'AWY', crestUrl: null, country: null },
  score: null,
  halfTimeScore: null,
  venue: null,
  round: null,
};

// Kick-off(0) -> home goal(10) -> half-time(45+2') -> kick-off(46) -> sub(60) -> away goal(70) -> full-time(90+3')
const events: MatchEvent[] = [
  event({ id: 'kickoff-1', type: 'KICK_OFF', minute: 0 }),
  event({ id: 'goal-home', type: 'GOAL', minute: 10, teamId: HOME, playerId: SCORER }),
  event({ id: 'halftime', type: 'HALF_TIME', minute: 45, extraMinute: 2 }),
  event({ id: 'kickoff-2', type: 'KICK_OFF', minute: 46 }),
  event({ id: 'sub', type: 'SUBSTITUTION', minute: 60, teamId: HOME, playerId: OFF_PLAYER, relatedPlayerId: ON_PLAYER }),
  event({ id: 'goal-away', type: 'GOAL', minute: 70, teamId: AWAY }),
  event({ id: 'fulltime', type: 'FULL_TIME', minute: 90, extraMinute: 3 }),
];

const timeline: RecordedMatchTimeline = {
  provenance: {
    kind: 'recorded-sample-data',
    description: 'test',
    recordedAt: '2026-09-16T00:00:00.000Z',
    disclaimer: 'test fixture, not real data',
  },
  fixtureId: asFixtureId('f1'),
  competitionCode: 'PREMIER_LEAGUE',
  regulationMinutes: 90,
  secondHalfStartMinute: 46,
  events,
  finalTeamStats: [
    {
      teamId: HOME,
      possession: 60,
      shots: 10,
      shotsOnTarget: 5,
      corners: 4,
      offsides: 1,
      fouls: 8,
      yellowCards: 1,
      redCards: 0,
      passes: 500,
      passAccuracy: 88,
    },
    {
      teamId: AWAY,
      possession: 40,
      shots: 8,
      shotsOnTarget: 3,
      corners: 2,
      offsides: 0,
      fouls: 10,
      yellowCards: 2,
      redCards: 0,
      passes: 400,
      passAccuracy: 80,
    },
  ],
  finalPlayerStats: [
    {
      playerId: OFF_PLAYER,
      teamId: HOME,
      minutesPlayed: 60,
      goals: 0,
      assists: 0,
      shots: 2,
      shotsOnTarget: 1,
      passes: 30,
      passAccuracy: 85,
      tackles: 4,
      duelsWon: 6,
      foulsCommitted: 1,
      rating: 7,
    },
    {
      playerId: ON_PLAYER,
      teamId: HOME,
      minutesPlayed: 30,
      goals: 0,
      assists: 0,
      shots: 1,
      shotsOnTarget: 0,
      passes: 10,
      passAccuracy: 80,
      tackles: 1,
      duelsWon: 2,
      foulsCommitted: 0,
      rating: 6.8,
    },
    {
      playerId: SCORER,
      teamId: HOME,
      minutesPlayed: 90,
      goals: 1,
      assists: 0,
      shots: 3,
      shotsOnTarget: 2,
      passes: 40,
      passAccuracy: 90,
      tackles: 2,
      duelsWon: 5,
      foulsCommitted: 0,
      rating: 7.8,
    },
  ],
};

function buildReplay(overrides: Partial<Omit<MatchReplayOptions, 'timeline' | 'fixture' | 'clock'>> = {}) {
  const clock = createManualClock();
  const replay = new MatchReplay({ timeline, fixture: baseFixture, clock, ...overrides });
  return { replay, clock };
}

describe('buildElapsedAxis', () => {
  it('shifts every second-half event by the first half stoppage, so ordering is chronological', () => {
    const { timed, firstHalfStoppage } = buildElapsedAxis(events);
    expect(firstHalfStoppage).toBe(2);
    const byId = new Map(timed.map((entry) => [entry.event.id, entry]));
    expect(byId.get('kickoff-1')?.elapsed).toBe(0);
    expect(byId.get('goal-home')?.elapsed).toBe(10);
    expect(byId.get('halftime')?.elapsed).toBe(47);
    // Second-half kick-off (elapsed 46+2=48) sits strictly after half-time (47), never before.
    expect(byId.get('kickoff-2')?.elapsed).toBe(48);
    expect(byId.get('goal-away')?.elapsed).toBe(72);
    expect(byId.get('fulltime')?.elapsed).toBe(95);
    const elapsedOrder = timed.map((entry) => entry.elapsed);
    expect(elapsedOrder).toEqual([...elapsedOrder].sort((a, b) => a - b));
  });
});

describe('MatchReplay.advanceTo (explicit, deterministic)', () => {
  it('the KICK_OFF event fires at elapsed 0, so the match is already LIVE there', () => {
    const { replay } = buildReplay();
    expect(replay.fixture().status).toBe('LIVE');
    expect(replay.eventsSoFar().map((e) => e.id)).toEqual(['kickoff-1']);
  });

  it('is genuinely SCHEDULED before the timeline starts, when constructed with autoStart off and no advance', () => {
    // A negative startMinute clamps to 0, same as never advancing — exercised separately from the kickoff case
    // above via a timeline whose first event is not at elapsed 0.
    const laterKickoff: RecordedMatchTimeline = {
      ...timeline,
      events: events.map((event, index) => (index === 0 ? { ...event, minute: 1 } : event)),
    };
    const clock = createManualClock();
    const replay = new MatchReplay({ timeline: laterKickoff, fixture: baseFixture, clock });
    expect(replay.fixture().status).toBe('SCHEDULED');
    expect(replay.eventsSoFar()).toHaveLength(0);
  });

  it('is LIVE with the home goal counted just after it fires', () => {
    const { replay } = buildReplay();
    replay.advanceTo(10);
    const fixture = replay.fixture();
    expect(fixture.status).toBe('LIVE');
    expect(fixture.minute).toBe(10);
    expect(fixture.score).toEqual({ home: 1, away: 0 });
    expect(replay.eventsSoFar().map((e) => e.id)).toEqual(['kickoff-1', 'goal-home']);
  });

  it('shows minute 45 and HALF_TIME status right at the half-time whistle (elapsed 47)', () => {
    const { replay } = buildReplay();
    replay.advanceTo(47);
    const fixture = replay.fixture();
    expect(fixture.status).toBe('HALF_TIME');
    expect(fixture.minute).toBe(45);
    expect(fixture.halfTimeScore).toEqual({ home: 1, away: 0 });
  });

  it('shows minute 46 (not 48) right after the second-half kicks off', () => {
    const { replay } = buildReplay();
    replay.advanceTo(48);
    const fixture = replay.fixture();
    expect(fixture.status).toBe('LIVE');
    expect(fixture.minute).toBe(46);
  });

  it('derives the scoreboard minute from elapsed time minus first-half stoppage in the second half', () => {
    const { replay } = buildReplay();
    replay.advanceTo(72);
    const fixture = replay.fixture();
    expect(fixture.minute).toBe(70);
    expect(fixture.score).toEqual({ home: 1, away: 1 });
  });

  it('is FINISHED with a null minute at the final whistle, and isFinished() agrees', () => {
    const { replay } = buildReplay();
    replay.advanceTo(95);
    const fixture = replay.fixture();
    expect(fixture.status).toBe('FINISHED');
    expect(fixture.minute).toBeNull();
    expect(fixture.score).toEqual({ home: 1, away: 1 });
    expect(replay.isFinished()).toBe(true);
  });

  it('clamps to [0, finalMinute] and never goes negative or past full time', () => {
    const { replay } = buildReplay();
    replay.advanceTo(-50);
    expect(replay.currentMinute).toBe(0);
    replay.advanceTo(10_000);
    expect(replay.currentMinute).toBe(95);
  });

  it('is idempotent: repeated snapshots at the same minute produce the same event ids', () => {
    const { replay } = buildReplay();
    replay.advanceTo(72);
    const first = replay.eventsSoFar().map((e) => e.id);
    const second = replay.eventsSoFar().map((e) => e.id);
    expect(first).toEqual(second);
  });
});

describe('MatchReplay clock-driven replay (no timers, fully controlled)', () => {
  it('advances elapsed minutes as (real elapsed ms / 60000) * speedMultiplier', async () => {
    const { replay, clock } = buildReplay({ speedMultiplier: 10, autoStart: true });
    expect(replay.currentMinute).toBe(0);
    await clock.advance(60_000); // 1 real minute * 10x = 10 elapsed minutes
    expect(replay.currentMinute).toBe(10);
    expect(replay.fixture().score).toEqual({ home: 1, away: 0 });
  });

  it('pause() freezes position; start() resumes from there', async () => {
    const { replay, clock } = buildReplay({ speedMultiplier: 60, autoStart: true });
    await clock.advance(10_000); // 60x speed: 10 elapsed minutes
    replay.pause();
    const paused = replay.currentMinute;
    await clock.advance(60_000);
    expect(replay.currentMinute).toBe(paused);
    replay.start();
    await clock.advance(10_000);
    expect(replay.currentMinute).toBeCloseTo(paused + 10, 5);
  });

  it('running is false once finished, even though start() was called', async () => {
    const { replay, clock } = buildReplay({ speedMultiplier: 1000, autoStart: true });
    await clock.advance(60_000);
    expect(replay.isFinished()).toBe(true);
    expect(replay.running).toBe(false);
  });
});

describe('MatchReplay.snapshot', () => {
  it('team stats: counting stats come from fired events, rate stats converge toward the recorded final', () => {
    const { replay } = buildReplay();
    replay.advanceTo(95);
    const snapshot = replay.snapshot();
    const home = snapshot.teamStats.find((t) => t.teamId === HOME);
    expect(home?.shots).toBe(1); // one GOAL counts as a shot on target
    expect(home?.possession).toBe(60); // fraction = 1 at full time -> exactly the recorded value
  });

  it('player stats: a starter subbed off at 60 shows 60 minutes played once past that point', () => {
    const { replay } = buildReplay();
    replay.advanceTo(95);
    const snapshot = replay.snapshot();
    const off = snapshot.playerStats.find((p) => p.playerId === OFF_PLAYER);
    expect(off?.minutesPlayed).toBe(60);
  });

  it('scorer credited with the goal from the event feed', () => {
    const { replay } = buildReplay();
    replay.advanceTo(95);
    const scorer = replay.snapshot().playerStats.find((p) => p.playerId === SCORER);
    expect(scorer?.goals).toBe(1);
  });

  it('at kick-off (elapsed 0), nobody has scored and only the kick-off event has fired', () => {
    const { replay } = buildReplay();
    const snapshot = replay.snapshot();
    expect(snapshot.playerStats.every((p) => p.goals === 0)).toBe(true);
    expect(snapshot.events).toHaveLength(1);
  });
});
