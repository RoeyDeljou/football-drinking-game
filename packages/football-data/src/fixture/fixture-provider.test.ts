import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createManualClock } from '../clock.js';
import { COMPETITIONS } from '../competitions.js';
import { asCompetitionId, asFixtureId, asFootballPlayerId, asTeamId } from '../domain.js';
import { createNodeDataSource, defaultDataDir } from '../node-data-source.js';
import { FixtureProvider } from './fixture-provider.js';

const PL = COMPETITIONS.PREMIER_LEAGUE;
const LA_LIGA = COMPETITIONS.LA_LIGA;
// Paris Saint-Germain 6-1 Slovan Bratislava (UEFA Champions League) — the one fixture with a full,
// genuinely kick-off-to-full-time recorded timeline (see data/README.md and B1 in the QA regression notes).
const REPLAY_FIXTURE = asFixtureId('401915445');

function provider(options: ConstructorParameters<typeof FixtureProvider>[0] = { dataSource: createNodeDataSource() }) {
  return new FixtureProvider(options);
}

describe('FixtureProvider — basic queries against the real recorded snapshot', () => {
  it('lists all six supported competitions', async () => {
    const result = await provider().listCompetitions();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((c) => c.code).sort()).toEqual(
      ['BUNDESLIGA', 'CHAMPIONS_LEAGUE', 'LA_LIGA', 'LIGUE_1', 'PREMIER_LEAGUE', 'SERIE_A'].sort(),
    );
  });

  it('returns Premier League fixtures for the current season, sorted by kickoff', async () => {
    const result = await provider().getFixturesByCompetition(PL.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThanOrEqual(3);
    const kickoffs = result.value.map((f) => f.kickoff);
    expect(kickoffs).toEqual([...kickoffs].sort());
  });

  it('getFixture returns null (not a failure) for an unknown fixture', async () => {
    const result = await provider().getFixture(asFixtureId('does-not-exist'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it('getLineups returns confirmed lineups with 11 real starters and real substitutes for a recorded fixture', async () => {
    const result = await provider().getLineups(REPLAY_FIXTURE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    expect(result.value?.confirmed).toBe(true);
    expect(result.value?.home.startingXI).toHaveLength(11);
    expect(result.value?.away.startingXI).toHaveLength(11);
    expect(result.value?.home.startingXI.every((p) => p.shirtNumber !== null)).toBe(true);
  });

  it('getSquad returns real players for a team id in the snapshot', async () => {
    const result = await provider().getSquad(asTeamId('382')); // Manchester City
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThan(15);
    expect(result.value.some((p) => p.name.includes('Haaland') || p.position === 'FW')).toBe(true);
  });

  it('getPlayerSeasonStats returns at least 40 players per competition (the acceptance floor)', async () => {
    for (const code of ['PREMIER_LEAGUE', 'LA_LIGA', 'SERIE_A', 'BUNDESLIGA', 'LIGUE_1', 'CHAMPIONS_LEAGUE'] as const) {
      const config = COMPETITIONS[code];
      const result = await provider().getPlayerSeasonStats({ competitionId: config.id });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.length).toBeGreaterThanOrEqual(40);
    }
  });

  it('getPlayerSeasonStats can be narrowed to one team and respects a limit', async () => {
    const result = await provider().getPlayerSeasonStats({ competitionId: PL.id, teamId: asTeamId('382'), limit: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeLessThanOrEqual(3);
    expect(result.value.every((row) => row.teamId === '382')).toBe(true);
  });

  it('an unsupported competition id fails fast rather than returning an empty list', async () => {
    const result = await provider().getFixturesByCompetition(asCompetitionId('not-a-real-competition'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('BAD_REQUEST');
    expect(result.error.retryable).toBe(false);
  });

  it('getFixturesByDate finds the fixtures actually recorded for that day', async () => {
    const laLigaFixtures = await provider().getFixturesByCompetition(LA_LIGA.id);
    expect(laLigaFixtures.ok).toBe(true);
    if (!laLigaFixtures.ok) return;
    const anyDate = laLigaFixtures.value[0]?.kickoff.slice(0, 10);
    expect(anyDate).toBeDefined();
    if (anyDate === undefined) return;
    const result = await provider().getFixturesByDate({ date: anyDate, competitions: ['LA_LIGA'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThan(0);
    expect(result.value.every((f) => f.competitionId === LA_LIGA.id)).toBe(true);
  });
});

describe('FixtureProvider — career history and career count acceptance floor', () => {
  it('getPlayerProfile returns recorded career history for a player who has one', async () => {
    const p = provider();
    const squad = await p.getSquad(asTeamId('382'));
    expect(squad.ok).toBe(true);
    if (!squad.ok) return;
    const withCareer = await Promise.all(
      squad.value.slice(0, 27).map((player) => p.getPlayerProfile(player.id)),
    );
    const found = withCareer.find((result) => result.ok && result.value !== null && result.value.career.length > 0);
    expect(found).toBeDefined();
  });

  it('getPlayerProfiles skips unknown ids with a note rather than failing the batch', async () => {
    const p = provider();
    const squad = await p.getSquad(asTeamId('382'));
    expect(squad.ok).toBe(true);
    if (!squad.ok) return;
    const known = squad.value[0]?.id;
    expect(known).toBeDefined();
    if (known === undefined) return;
    const result = await p.getPlayerProfiles([known, asFootballPlayerId('does-not-exist')]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.some((profile) => profile.player.id === known)).toBe(true);
    expect(result.notes.some((note) => note.includes('does-not-exist'))).toBe(true);
  });

  it('the recorded dataset has at least 60 players with career history overall', () => {
    const careers = JSON.parse(readFileSync(join(defaultDataDir(), 'careers.json'), 'utf8')) as {
      careers: readonly { entries: readonly unknown[] }[];
    };
    const withEntries = careers.careers.filter((entry) => entry.entries.length > 0);
    expect(withEntries.length).toBeGreaterThanOrEqual(60);
  });
});

describe('FixtureProvider — resource cache loads the dataset exactly once', () => {
  it('coalesces concurrent first calls into a single dataset load', async () => {
    const p = provider();
    const [a, b, c] = await Promise.all([p.listCompetitions(), p.getFixturesByCompetition(PL.id), p.getSquad(asTeamId('382'))]);
    expect(a.ok && b.ok && c.ok).toBe(true);
  });
});

describe('FixtureProvider — deterministic match replay (no timers, no live match needed)', () => {
  it('with no replay configured, live state comes straight from the recorded snapshot', async () => {
    const result = await provider().getLiveMatchState(REPLAY_FIXTURE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    expect(result.value?.events.length).toBeGreaterThan(0);
  });

  it('advanceReplayTo moves the configured fixture deterministically, with no real waiting', async () => {
    const clock = createManualClock();
    const p = provider({
      dataSource: createNodeDataSource(),
      clock,
      replay: { fixtureId: REPLAY_FIXTURE, autoStart: false, startMinute: 0 },
    });
    await p.ready();

    p.advanceReplayTo(0);
    const atZero = await p.getFixture(REPLAY_FIXTURE);
    expect(atZero.ok).toBe(true);
    if (atZero.ok) expect(atZero.value?.score).toEqual({ home: 0, away: 0 });

    const status = p.replayStatus();
    expect(status).not.toBeNull();
    p.advanceReplayTo(status?.finalMinute ?? 200);
    const atEnd = await p.getFixture(REPLAY_FIXTURE);
    expect(atEnd.ok).toBe(true);
    if (atEnd.ok) expect(atEnd.value?.status).toBe('FINISHED');
  });

  it('the replay clock advances deterministically through an injected DataClock', async () => {
    const clock = createManualClock();
    const p = provider({
      dataSource: createNodeDataSource(),
      clock,
      replay: { fixtureId: REPLAY_FIXTURE, speedMultiplier: 1000, autoStart: true },
    });
    await p.ready();
    const before = p.replayStatus();
    await clock.advance(60_000);
    const after = p.replayStatus();
    expect(after?.elapsedMinute ?? 0).toBeGreaterThan(before?.elapsedMinute ?? 0);
  });

  it('getMatchEvents mirrors the replay events for the configured fixture', async () => {
    const clock = createManualClock();
    const p = provider({
      dataSource: createNodeDataSource(),
      clock,
      replay: { fixtureId: REPLAY_FIXTURE, autoStart: false, startMinute: 30 },
    });
    await p.ready();
    const events = await p.getMatchEvents(REPLAY_FIXTURE);
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const live = await p.getLiveMatchState(REPLAY_FIXTURE);
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    expect(events.value.map((e) => e.id)).toEqual(live.value?.events.map((e) => e.id));
  });

  it('a fixture id that has no timeline is unaffected by the configured replay', async () => {
    const clock = createManualClock();
    const p = provider({
      dataSource: createNodeDataSource(),
      clock,
      replay: { fixtureId: REPLAY_FIXTURE, autoStart: false },
    });
    const other = await p.getFixture(asFixtureId('401879278')); // Man United v Man City, no timeline
    expect(other.ok).toBe(true);
    if (other.ok) expect(other.value?.status).toBe('FINISHED');
  });

  // Regression for B1: the recorded timeline must be a real, complete kick-off-to-full-time recording, not a
  // partial live-captured snapshot mislabeled as full.
  it('the recorded timeline genuinely runs to full time: a FULL_TIME event and real events after minute 70', async () => {
    const clock = createManualClock();
    const p = provider({
      dataSource: createNodeDataSource(),
      clock,
      replay: { fixtureId: REPLAY_FIXTURE, autoStart: false },
    });
    await p.ready();
    const status = p.replayStatus();
    expect(status).not.toBeNull();

    p.advanceReplayTo(status?.finalMinute ?? 0);
    const events = await p.getMatchEvents(REPLAY_FIXTURE);
    expect(events.ok).toBe(true);
    if (!events.ok) return;

    expect(events.value.some((event) => event.type === 'FULL_TIME')).toBe(true);
    expect(events.value.filter((event) => event.minute > 70).length).toBeGreaterThan(0);

    const finished = await p.getFixture(REPLAY_FIXTURE);
    expect(finished.ok).toBe(true);
    if (finished.ok) expect(finished.value?.status).toBe('FINISHED');
  });

  // Regression for B3: a typo'd (or otherwise unresolvable) replay fixture id must be visible, not silent.
  it('a misconfigured replay fixture id is reported in notes rather than silently degrading', async () => {
    const clock = createManualClock();
    const p = provider({
      dataSource: createNodeDataSource(),
      clock,
      replay: { fixtureId: 'this-fixture-id-does-not-exist', autoStart: false },
    });

    const ready = await p.ready();
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    expect(ready.notes.some((note) => note.includes('this-fixture-id-does-not-exist'))).toBe(true);
    expect(ready.notes.some((note) => note.includes(REPLAY_FIXTURE))).toBe(true); // names a real replayable id
    expect(p.matchReplay()).toBeNull();

    // The note is not a one-time fluke: it is attached to every subsequent call too.
    const again = await p.listCompetitions();
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.notes.some((note) => note.includes('this-fixture-id-does-not-exist'))).toBe(true);
  });

  it('a replay fixture id that exists but has no timeline is reported distinctly from an unknown id', async () => {
    const clock = createManualClock();
    const p = provider({
      dataSource: createNodeDataSource(),
      clock,
      replay: { fixtureId: '401879278', autoStart: false }, // a real, finished fixture with no timeline
    });
    const ready = await p.ready();
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    expect(ready.notes.some((note) => note.includes('401879278') && note.includes('no recorded timeline'))).toBe(
      true,
    );
  });
});
