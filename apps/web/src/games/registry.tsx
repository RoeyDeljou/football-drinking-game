/**
 * Every Phase-5/6 game registers here the same way: one `GameModuleId` → one screen component that
 * only reads the per-recipient `ProjectedRound`/`ProjectedRoom` and calls `onSubmit` with a raw
 * answer payload. Nothing else in the client needs to change to add a game.
 */

import type { ComponentType } from 'react';
import { G1GuessThePlayer } from './G1GuessThePlayer';
import { G6TriviaRush } from './G6TriviaRush';
import { M1MatchMarkets } from './M1MatchMarkets';
import { M2WhoIsThatPlayer } from './M2WhoIsThatPlayer';
import { M3ShirtNumber } from './M3ShirtNumber';
import type { GameScreenProps } from './types';

export const GAME_SCREENS: Record<string, ComponentType<GameScreenProps>> = {
  M1: M1MatchMarkets,
  M2: M2WhoIsThatPlayer,
  M3: M3ShirtNumber,
  G1: G1GuessThePlayer,
  G6: G6TriviaRush,
};

export const GAME_CATALOG: readonly {
  readonly id: string;
  readonly name: string;
  readonly category: 'matchday' | 'general';
  readonly blurb: string;
}[] = [
  { id: 'M1', name: 'Match Markets', category: 'matchday', blurb: 'Betting-style slip on the whole match.' },
  { id: 'M2', name: "Who's That Player?", category: 'matchday', blurb: 'Guess who the fact describes.' },
  { id: 'M3', name: 'Shirt Number', category: 'matchday', blurb: "Guess a starter's squad number." },
  { id: 'G1', name: 'Guess the Player', category: 'general', blurb: 'Clues unlock one at a time.' },
  { id: 'G6', name: 'Trivia Rush', category: 'general', blurb: 'Rapid-fire multiple choice.' },
];

/** The display name for a `GameModuleId`, falling back to the raw id for a not-yet-cataloged game
 * rather than ever showing nothing. */
export const gameName = (moduleId: string): string => GAME_CATALOG.find((game) => game.id === moduleId)?.name ?? moduleId;
