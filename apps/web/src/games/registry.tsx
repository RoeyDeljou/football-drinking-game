/**
 * Every Phase-5/6 game registers here the same way: one `GameModuleId` → one screen component that
 * only reads the per-recipient `ProjectedRound`/`ProjectedRoom` and calls `onSubmit` with a raw
 * answer payload. Nothing else in the client needs to change to add a game.
 */

import type { ComponentType } from 'react';
import { G1GuessThePlayer } from './G1GuessThePlayer';
import { G3CareerPath } from './G3CareerPath';
import { G6TriviaRush } from './G6TriviaRush';
import { M1MatchMarkets } from './M1MatchMarkets';
import { M2WhoIsThatPlayer } from './M2WhoIsThatPlayer';
import { M3ShirtNumber } from './M3ShirtNumber';
import { MixedGameScreen } from './MixedGameScreen';
import type { GameScreenProps } from './types';

export const GAME_SCREENS: Record<string, ComponentType<GameScreenProps>> = {
  M1: M1MatchMarkets,
  M2: M2WhoIsThatPlayer,
  M3: M3ShirtNumber,
  G1: G1GuessThePlayer,
  G3: G3CareerPath,
  G6: G6TriviaRush,
  'G-MIX': MixedGameScreen,
  'M-MIX': MixedGameScreen,
};

export const GAME_CATALOG: readonly {
  readonly id: string;
  readonly name: string;
  readonly category: 'matchday' | 'general';
  readonly blurb: string;
}[] = [
  {
    id: 'M-MIX',
    name: 'Full Match Mix',
    category: 'matchday',
    blurb: 'Every matchday question game in one rotation — never the same round twice.',
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
    id: 'G-MIX',
    name: 'All-Star Mix',
    category: 'general',
    blurb: 'Every general game in one rotation — a different question style each round.',
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
