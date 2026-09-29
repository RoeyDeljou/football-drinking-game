/**
 * The short scope line the lobby summary shows next to the category, built from what the host
 * picked on /host. Kept pure so the wording is tested in one place.
 */
export const setupScopeLabel = (input: {
  readonly category: 'matchday' | 'general';
  /** General: the scoped competition's name, or `null` for "All competitions". */
  readonly generalCompetitionName: string | null;
  /** Matchday: the league the fixture list came from. */
  readonly matchdayCompetitionName: string | null;
  readonly gameday: boolean;
  readonly fixture: { readonly homeTeam: { readonly name: string }; readonly awayTeam: { readonly name: string } } | null;
}): string => {
  if (input.category === 'general') return input.generalCompetitionName ?? 'All competitions';
  if (input.gameday) {
    return input.matchdayCompetitionName === null ? 'Live gameday' : `Live gameday · ${input.matchdayCompetitionName}`;
  }
  if (input.fixture !== null) return `${input.fixture.homeTeam.name} vs ${input.fixture.awayTeam.name}`;
  return input.matchdayCompetitionName ?? 'Matchday';
};
