/**
 * The module registry.
 *
 * Adding a game means adding a file and one entry in `PHASE_1_MODULES` (or whatever list the host
 * app builds its registry from). Nothing in the engine switches on a module id.
 */

import type { DataQuality } from '@fdg/football-data';
import type { PlayabilityResult } from '../data.js';
import { checkModulePlayable } from '../data.js';
import { EngineInvariantError } from '../errors.js';
import type { GameModuleId } from '../ids.js';
import type { EngineGameModule, GameCategory } from '../module.js';
import { g1GuessThePlayer } from './g1-guess-the-player.js';
import { g6TriviaRush } from './g6-trivia-rush.js';
import { m1MatchMarkets } from './m1-match-markets.js';
import { m2WhoIsThatPlayer } from './m2-who-is-that-player.js';
import { m3ShirtNumber } from './m3-shirt-number.js';

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

/** The Phase-1 playable set. */
export const PHASE_1_MODULES: readonly EngineGameModule[] = [
  m1MatchMarkets,
  m2WhoIsThatPlayer,
  m3ShirtNumber,
  g1GuessThePlayer,
  g6TriviaRush,
];

export const createDefaultRegistry = (): GameModuleRegistry => createModuleRegistry(PHASE_1_MODULES);
