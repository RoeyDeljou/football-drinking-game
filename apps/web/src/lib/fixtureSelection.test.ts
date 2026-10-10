import { describe, expect, it } from 'vitest';
import type { FixtureSummary } from './api';
import {
  clearGroup,
  listableFixtures,
  mergeFixtures,
  MAX_FIXTURES,
  orderCompetitions,
  scopeLabelForFixtures,
  selectAll,
  selectionSummary,
  toggleFixture,
  type PickedFixture,
} from './fixtureSelection';

const fx = (id: string, competitionId: string, status: FixtureSummary['status'] = 'LIVE', kickoff = '2026-10-10T15:00:00Z'): FixtureSummary => ({
  fixtureId: id,
  kickoff,
  status,
  minute: status === 'LIVE' ? 30 : null,
  competitionId,
  homeTeam: { name: `H${id}`, crestUrl: null },
  awayTeam: { name: `A${id}`, crestUrl: null },
});
const pick = (id: string, competitionId: string, name: string): PickedFixture => ({ fixture: fx(id, competitionId), competitionName: name });

describe('selection', () => {
  it('toggles on and off', () => {
    const one = toggleFixture([], pick('1', 'pl', 'Premier League'));
    expect(one).toHaveLength(1);
    expect(toggleFixture(one, pick('1', 'pl', 'Premier League'))).toHaveLength(0);
  });

  it('caps at 20', () => {
    let selection: readonly PickedFixture[] = [];
    for (let i = 0; i < MAX_FIXTURES + 5; i += 1) selection = toggleFixture(selection, pick(String(i), 'pl', 'PL'));
    expect(selection).toHaveLength(MAX_FIXTURES);
    expect(selectAll(selection, [pick('x', 'pl', 'PL')])).toHaveLength(MAX_FIXTURES);
  });

  it('selects all in a group without duplicating, and clears one group', () => {
    const start = toggleFixture([], pick('1', 'pl', 'PL'));
    const all = selectAll(start, [pick('1', 'pl', 'PL'), pick('2', 'pl', 'PL'), pick('3', 'll', 'La Liga')]);
    expect(all.map((entry) => entry.fixture.fixtureId)).toEqual(['1', '2', '3']);
    expect(clearGroup(all, 'pl').map((entry) => entry.fixture.fixtureId)).toEqual(['3']);
  });
});

describe('labels', () => {
  it('summarises the selection by competition', () => {
    expect(selectionSummary([])).toBe('No matches selected');
    const selection = [pick('1', 'pl', 'Premier League'), pick('2', 'll', 'La Liga'), pick('3', 'pl', 'Premier League')];
    expect(selectionSummary(selection)).toBe('3 matches selected · Premier League ×2, La Liga ×1');
    expect(selectionSummary(selection.slice(0, 1))).toBe('1 match selected · Premier League ×1');
  });

  it('names one match "A vs B" and several "A v B +n more"', () => {
    const one = [fx('1', 'pl')];
    expect(scopeLabelForFixtures(one)).toBe('H1 vs A1');
    expect(scopeLabelForFixtures([fx('1', 'pl'), fx('2', 'pl'), fx('3', 'pl')])).toBe('H1 v A1 +2 more');
  });
});

describe('grouping', () => {
  it('puts competitions with live matches first', () => {
    const groups = orderCompetitions(
      [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
      [fx('1', 'c'), fx('2', 'c'), fx('3', 'b')],
    );
    expect(groups.map((group) => group.competition.id)).toEqual(['c', 'b', 'a']);
    expect(groups[0]?.liveCount).toBe(2);
  });

  it('lists live first, drops finished, and merges by id', () => {
    const list = listableFixtures([
      fx('up', 'pl', 'SCHEDULED', '2026-10-10T18:00:00Z'),
      fx('done', 'pl', 'FINISHED'),
      fx('live', 'pl', 'LIVE'),
    ]);
    expect(list.map((entry) => entry.fixtureId)).toEqual(['live', 'up']);
    expect(mergeFixtures([fx('1', 'pl', 'LIVE')], [fx('1', 'pl', 'LIVE'), fx('2', 'pl', 'SCHEDULED')])).toHaveLength(2);
  });
});
