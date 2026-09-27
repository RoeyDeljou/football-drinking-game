import { describe, expect, it } from 'vitest';
import type { Fixture } from '@fdg/football-data';
import { asCompetitionId, asFixtureId, asSeasonId, asTeamId } from '@fdg/football-data';
import { selectRelevantFixtures } from './routes.js';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');

const team = (name: string) => ({ id: asTeamId(name), name, shortName: name, crestUrl: null, country: null });

const fixture = (id: string, kickoffIso: string, status: Fixture['status']): Fixture => ({
  id: asFixtureId(id),
  competitionId: asCompetitionId('premier-league'),
  season: asSeasonId('2026/27'),
  kickoff: kickoffIso,
  status,
  minute: status === 'LIVE' ? 41 : null,
  homeTeam: team('Home'),
  awayTeam: team('Away'),
  score: null,
  halfTimeScore: null,
  venue: null,
  round: null,
});

describe('selectRelevantFixtures', () => {
  const live = fixture('live-1', '2026-09-27T11:30:00.000Z', 'LIVE');
  const soonUpcoming = fixture('soon', '2026-09-28T18:00:00.000Z', 'SCHEDULED');
  const laterUpcoming = fixture('later', '2026-10-05T18:00:00.000Z', 'SCHEDULED');
  const outsideWindow = fixture('too-far', '2026-10-20T18:00:00.000Z', 'SCHEDULED');
  const past = fixture('past', '2026-09-01T18:00:00.000Z', 'FINISHED');
  const postponed = fixture('postponed', '2026-09-29T18:00:00.000Z', 'POSTPONED');

  const all = [outsideWindow, past, laterUpcoming, live, postponed, soonUpcoming];

  it('combines live and upcoming (within 14 days), live first, each soonest-first, excluding past/postponed/out-of-window', () => {
    const result = selectRelevantFixtures(all, undefined, NOW);
    expect(result.map((f) => f.id)).toEqual([live, soonUpcoming, laterUpcoming].map((f) => f.id));
  });

  it('window=live returns only fixtures in progress', () => {
    const result = selectRelevantFixtures(all, 'live', NOW);
    expect(result.map((f) => f.id)).toEqual([live.id]);
  });

  it('window=upcoming returns only scheduled fixtures inside the window, soonest first', () => {
    const result = selectRelevantFixtures(all, 'upcoming', NOW);
    expect(result.map((f) => f.id)).toEqual([soonUpcoming.id, laterUpcoming.id]);
  });

  it('a fixture exactly at the 14-day boundary is included; one day past it is not', () => {
    const boundary = fixture('boundary', new Date(NOW + 14 * 24 * 60 * 60 * 1000).toISOString(), 'SCHEDULED');
    const pastBoundary = fixture('past-boundary', new Date(NOW + 15 * 24 * 60 * 60 * 1000).toISOString(), 'SCHEDULED');
    const result = selectRelevantFixtures([boundary, pastBoundary], 'upcoming', NOW);
    expect(result.map((f) => f.id)).toEqual([boundary.id]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(selectRelevantFixtures([past, postponed, outsideWindow], undefined, NOW)).toEqual([]);
  });

  it('caps the result at 20 fixtures', () => {
    const many = Array.from({ length: 30 }, (_unused, index) =>
      fixture(`f${String(index)}`, new Date(NOW + index * 60_000).toISOString(), 'SCHEDULED'),
    );
    expect(selectRelevantFixtures(many, 'upcoming', NOW)).toHaveLength(20);
  });
});
