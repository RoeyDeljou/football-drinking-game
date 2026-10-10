import { scopeLabelForFixtures } from './fixtureSelection';

/**
 * The short scope line the lobby summary shows next to the category, built from what the host
 * picked on /host. Kept pure so the wording is tested in one place.
 */
export const setupScopeLabel = (input: {
  readonly category: 'matchday' | 'general';
  /** General: the scoped competition's name, or `null` for "All competitions". */
  readonly generalCompetitionName: string | null;
  /** Matchday: every ticked fixture ("Arsenal vs Chelsea", or "Arsenal v Chelsea +2 more"). */
  readonly fixtures: readonly { readonly homeTeam: { readonly name: string }; readonly awayTeam: { readonly name: string } }[];
}): string => {
  if (input.category === 'general') return input.generalCompetitionName ?? 'All competitions';
  return scopeLabelForFixtures(input.fixtures);
};
