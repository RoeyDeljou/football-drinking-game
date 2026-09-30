/**
 * The module registry.
 *
 * Adding a game means adding a file and one entry in `STANDALONE_MODULES` (or whatever list the host
 * app builds its registry from). Nothing in the engine switches on a module id. A new
 * `simultaneous-answer` game also joins its category's Mixed rotation automatically, because the Mixed
 * modules are built over `STANDALONE_MODULES` and filter it themselves (see `mixed.ts`).
 */

import type { DataQuality } from '@fdg/football-data';
import type { PlayabilityResult } from '../data.js';
import { checkModulePlayable } from '../data.js';
import { EngineInvariantError } from '../errors.js';
import type { GameModuleId } from '../ids.js';
import type { EngineGameModule, GameCategory } from '../module.js';
import { g1GuessThePlayer } from './g1-guess-the-player.js';
import { g3CareerPath } from './g3-career-path.js';
import { g6TriviaRush } from './g6-trivia-rush.js';
import { m1MatchMarkets } from './m1-match-markets.js';
import { m2WhoIsThatPlayer } from './m2-who-is-that-player.js';
import { m3ShirtNumber } from './m3-shirt-number.js';
import { m5EventRoulette } from './m5-event-roulette.js';
import { m6MatchBingo } from './m6-match-bingo.js';
import { m7MinuteSniper } from './m7-minute-sniper.js';
import { m10LineupRecall } from './m10-lineup-recall.js';
import { createMixedModule, G_MIX_ID, M_MIX_ID } from './mixed.js';

export interface ModulePlayability {
  readonly module: EngineGameModule;
  readonly playability: PlayabilityResult;
}

export interface GameModuleRegistry {
  get(id: GameModuleId): EngineGameModule | undefined;
  has(id: GameModuleId): boolean;
  list(): readonly EngineGameModule[];
  listByCategory(category: GameCategory): readonly EngineGameModule[];
  /** What the host's game picker renders: every module plus why it is or is not playable. */
  listPlayability(quality: DataQuality | null): readonly ModulePlayability[];
}

export const createModuleRegistry = (modules: readonly EngineGameModule[]): GameModuleRegistry => {
  const byId = new Map<GameModuleId, EngineGameModule>();
  for (const module of modules) {
    if (byId.has(module.id)) {
      throw new EngineInvariantError(`duplicate game module id: ${module.id}`);
    }
    byId.set(module.id, module);
  }
  const ordered = [...byId.values()];

  return {
    get: (id) => byId.get(id),
    has: (id) => byId.has(id),
    list: () => ordered,
    listByCategory: (category) => ordered.filter((module) => module.category === category),
    listPlayability: (quality) =>
      ordered.map((module) => ({
        module,
        playability: checkModulePlayable(module, quality),
      })),
  };
};

/** Every individually playable game — also the pool the Mixed rotations draw from. */
export const STANDALONE_MODULES: readonly EngineGameModule[] = [
  m1MatchMarkets,
  m2WhoIsThatPlayer,
  m3ShirtNumber,
  m5EventRoulette,
  m6MatchBingo,
  m7MinuteSniper,
  m10LineupRecall,
  g1GuessThePlayer,
  g3CareerPath,
  g6TriviaRush,
];

/**
 * Mixable games kept OUT of the default Mixed rotation until their web screen ships (a Mixed round
 * whose sub-game has no `GAME_SCREENS` entry cannot be rendered). They stay registered and remain
 * selectable via an explicit `config.modules`. Empty now that every mixable game has a screen
 * (M10 joined when `GAME_SCREENS['M10']` landed); add an id here to hold a future game back.
 */
export const MIXED_ROTATION_EXCLUDED: readonly GameModuleId[] = [];

/**
 * Matchday "all games in one": by default rotates M2, M3 and M10 (M10 skips itself per round when the
 * lineups are unconfirmed, and has two XIs per fixture). Never M1, M5, M6 or M7: live rounds that wait on the match, not one self-contained
 * question (`isMixable` filters them out).
 */
export const matchdayMixed: EngineGameModule = createMixedModule({
  id: M_MIX_ID,
  category: 'matchday',
  pool: STANDALONE_MODULES,
  excludeFromDefault: MIXED_ROTATION_EXCLUDED,
});

/** General "all games in one": rotates G1, G3, G6. */
export const generalMixed: EngineGameModule = createMixedModule({
  id: G_MIX_ID,
  category: 'general',
  pool: STANDALONE_MODULES,
  excludeFromDefault: MIXED_ROTATION_EXCLUDED,
});

/**
 * The default playable set: each category's Mixed mode first (the main game mode), then its
 * standalone games. (The name predates Phase 5; it now also carries the Phase-5 games shipped so far.)
 */
export const PHASE_1_MODULES: readonly EngineGameModule[] = [
  matchdayMixed,
  m1MatchMarkets,
  m2WhoIsThatPlayer,
  m3ShirtNumber,
  m5EventRoulette,
  m6MatchBingo,
  m7MinuteSniper,
  m10LineupRecall,
  generalMixed,
  g1GuessThePlayer,
  g3CareerPath,
  g6TriviaRush,
];

export const createDefaultRegistry = (): GameModuleRegistry => createModuleRegistry(PHASE_1_MODULES);
