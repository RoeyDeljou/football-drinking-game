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
import { M10LineupRecall } from './M10LineupRecall';
import { M2WhoIsThatPlayer } from './M2WhoIsThatPlayer';
import { M3ShirtNumber } from './M3ShirtNumber';
import { M7MinuteSniper } from './M7MinuteSniper';
import { MixedGameScreen } from './MixedGameScreen';
import type { GameScreenProps } from './types';

export const GAME_SCREENS: Record<string, ComponentType<GameScreenProps>> = {
  M1: M1MatchMarkets,
  M2: M2WhoIsThatPlayer,
  M3: M3ShirtNumber,
  M7: M7MinuteSniper,
  M10: M10LineupRecall,
  G1: G1GuessThePlayer,
  G3: G3CareerPath,
  G6: G6TriviaRush,
  'G-MIX': MixedGameScreen,
  'M-MIX': MixedGameScreen,
};

export { GAME_CATALOG, gameName } from './catalog';
