/**
 * The game catalog: plain data (no React), so pure logic in `lib/` (mode -> moduleId mapping) and
 * its tests can import it without pulling in any game screen. `registry.tsx` re-exports it.
 */

export const GAME_CATALOG: readonly {
  readonly id: string;
  readonly name: string;
  readonly category: 'matchday' | 'general';
  readonly blurb: string;
}[] = [
  {
    id: 'M-MIX',
    name: 'Shuffle game',
    category: 'matchday',
    blurb: 'Rotates through every mini game — a fresh style each round.',
  },
  {
    id: 'M1',
    name: 'Match Markets',
    category: 'matchday',
    blurb: 'Pick the result, goals, and scorers before kickoff — you drink as your picks lose.',
  },
  {
    id: 'M2',
    name: "Who's That Player?",
    category: 'matchday',
    blurb: 'One clue about a player on the pitch right now — be first to name who it is.',
  },
  {
    id: 'M3',
    name: 'Shirt Number',
    category: 'matchday',
    blurb: "See a real starter, guess their shirt number — closest guess wins.",
  },
  {
    id: 'M7',
    name: 'Minute Sniper',
    category: 'matchday',
    blurb: 'Pick the minute of the next goal — closest wins, furthest drinks.',
  },
  {
    id: 'M10',
    name: 'Lineup Recall',
    category: 'matchday',
    blurb: 'Name the starting XI from memory, against the clock — a sip for every one you miss.',
  },
  {
    id: 'G-MIX',
    name: 'Shuffle game',
    category: 'general',
    blurb: 'Rotates through every mini game — a fresh style each round.',
  },
  {
    id: 'G1',
    name: 'Guess the Player',
    category: 'general',
    blurb: 'Clues about a real footballer reveal one at a time — name them before your friends.',
  },
  {
    id: 'G3',
    name: 'Career Path',
    category: 'general',
    blurb: 'Their clubs reveal one at a time, oldest first — name the player before the big reveal.',
  },
  {
    id: 'G6',
    name: 'Trivia Rush',
    category: 'general',
    blurb: 'Fast multiple-choice football questions — the quickest right answer scores most.',
  },
];

/** The display name for a `GameModuleId`, falling back to the raw id for a not-yet-cataloged game
 * rather than ever showing nothing. */
export const gameName = (moduleId: string): string => GAME_CATALOG.find((game) => game.id === moduleId)?.name ?? moduleId;
