/**
 * Pure logic for the host's multi-match picker: which fixtures are ticked, the sticky summary line,
 * the lobby scope label, and how the competitions are grouped (live first). One ticked fixture makes a
 * single-match room, several make a rotation room; the server decides what that means, the client just
 * sends `fixtureIds`.
 */

import type { Competition, FixtureSummary } from './api';
import { isFixtureLive } from './matchdayPicker';

/** The server accepts 1..20 fixtures per room. */
export const MAX_FIXTURES = 20;

export interface PickedFixture {
  readonly fixture: FixtureSummary;
  readonly competitionName: string;
}

/** Ticked fixtures in the order they were ticked. */
export type FixtureSelection = readonly PickedFixture[];

export const isPicked = (selection: FixtureSelection, fixtureId: string): boolean =>
  selection.some((entry) => entry.fixture.fixtureId === fixtureId);

/** Tick or untick one fixture. Ticking past `MAX_FIXTURES` is ignored. */
export const toggleFixture = (selection: FixtureSelection, picked: PickedFixture): FixtureSelection => {
  if (isPicked(selection, picked.fixture.fixtureId)) {
    return selection.filter((entry) => entry.fixture.fixtureId !== picked.fixture.fixtureId);
  }
  return selection.length >= MAX_FIXTURES ? selection : [...selection, picked];
};

/** "All in <competition>": tick everything listed (already-ticked ones stay), up to the cap. */
export const selectAll = (selection: FixtureSelection, picks: readonly PickedFixture[]): FixtureSelection => {
  const next = [...selection];
  for (const pick of picks) {
    if (next.length >= MAX_FIXTURES) break;
    if (!isPicked(next, pick.fixture.fixtureId)) next.push(pick);
  }
  return next;
};

/** Untick every fixture of one competition. */
export const clearGroup = (selection: FixtureSelection, competitionId: string): FixtureSelection =>
  selection.filter((entry) => entry.fixture.competitionId !== competitionId);

/** True when everything listed in the group is already ticked. */
export const groupFullyPicked = (selection: FixtureSelection, picks: readonly PickedFixture[]): boolean =>
  picks.length > 0 && picks.every((pick) => isPicked(selection, pick.fixture.fixtureId));

/** "3 matches selected · Premier League ×2, La Liga ×1" (competitions in tick order). */
export const selectionSummary = (selection: FixtureSelection): string => {
  if (selection.length === 0) return 'No matches selected';
  const counts = new Map<string, number>();
  for (const entry of selection) counts.set(entry.competitionName, (counts.get(entry.competitionName) ?? 0) + 1);
  const parts = [...counts.entries()].map(([name, count]) => `${name} ×${count}`);
  return `${selection.length} ${selection.length === 1 ? 'match' : 'matches'} selected · ${parts.join(', ')}`;
};

/** Lobby scope label: "Arsenal vs Chelsea" for one match, "Arsenal v Chelsea +2 more" for several. */
export const scopeLabelForFixtures = (
  fixtures: readonly { readonly homeTeam: { readonly name: string }; readonly awayTeam: { readonly name: string } }[],
): string => {
  const first = fixtures[0];
  if (first === undefined) return 'Matchday';
  if (fixtures.length === 1) return `${first.homeTeam.name} vs ${first.awayTeam.name}`;
  return `${first.homeTeam.name} v ${first.awayTeam.name} +${fixtures.length - 1} more`;
};

export interface CompetitionGroup {
  readonly competition: Pick<Competition, 'id' | 'name'>;
  readonly liveCount: number;
}

/** Competitions with live matches first (most live first), the rest in their given order. */
export const orderCompetitions = (
  competitions: readonly Pick<Competition, 'id' | 'name'>[],
  liveFixtures: readonly Pick<FixtureSummary, 'competitionId' | 'status'>[],
): readonly CompetitionGroup[] => {
  const live = new Map<string, number>();
  for (const fixture of liveFixtures) {
    if (isFixtureLive(fixture)) live.set(fixture.competitionId, (live.get(fixture.competitionId) ?? 0) + 1);
  }
  return competitions
    .map((competition, index) => ({ competition, liveCount: live.get(competition.id) ?? 0, index }))
    .sort((a, b) => (b.liveCount > 0 ? 1 : 0) - (a.liveCount > 0 ? 1 : 0) || b.liveCount - a.liveCount || a.index - b.index)
    .map(({ competition, liveCount }) => ({ competition, liveCount }));
};

/** Live fixtures first (by kickoff), then upcoming by kickoff; finished or cancelled ones are dropped. */
export const listableFixtures = (fixtures: readonly FixtureSummary[]): readonly FixtureSummary[] =>
  fixtures
    .filter((fixture) => fixture.status !== 'FINISHED' && fixture.status !== 'CANCELLED')
    .slice()
    .sort((a, b) => Number(isFixtureLive(b)) - Number(isFixtureLive(a)) || Date.parse(a.kickoff) - Date.parse(b.kickoff));

/** Merge two lists of one competition's fixtures by id (later entries win), e.g. the live sweep plus the full list. */
export const mergeFixtures = (...lists: readonly (readonly FixtureSummary[])[]): readonly FixtureSummary[] => {
  const byId = new Map<string, FixtureSummary>();
  for (const list of lists) for (const fixture of list) byId.set(fixture.fixtureId, fixture);
  return [...byId.values()];
};
