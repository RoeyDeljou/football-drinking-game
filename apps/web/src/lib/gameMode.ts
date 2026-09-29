/**
 * Pure logic behind the "Shuffle game" vs "Select Mini Game" control.
 *
 * Shuffle maps to the category's Mixed rotation (`G-MIX` / `M-MIX`). Select Mini Game exposes the
 * category's individual games (everything in the catalog that is not a MIX entry). This module only
 * maps a UI choice to a `GameModuleId` and validates it; it never decides rules or scoring.
 */

import { GAME_CATALOG } from '../games/catalog';

export type GameCategory = 'matchday' | 'general';
export type GameMode = 'shuffle' | 'select';

export interface ModeChoice {
  readonly mode: GameMode;
  /** Only meaningful when `mode === 'select'`. */
  readonly miniGameId: string | null;
}

export interface CatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly category: GameCategory;
  readonly blurb: string;
}

const SHUFFLE_IDS: Record<GameCategory, string> = { matchday: 'M-MIX', general: 'G-MIX' };

export const SHUFFLE_LABEL = 'Shuffle game';
export const SELECT_LABEL = 'Select Mini Game';
export const NO_MINI_GAME_MESSAGE = 'Pick a mini game, or switch back to Shuffle game.';

/** The default: shuffle, nothing picked. */
export const DEFAULT_CHOICE: ModeChoice = { mode: 'shuffle', miniGameId: null };

export const shuffleModuleId = (category: GameCategory): string => SHUFFLE_IDS[category];

export const isShuffleModuleId = (moduleId: string): boolean => moduleId === 'G-MIX' || moduleId === 'M-MIX';

/** The category's individual games: non-MIX catalog entries filtered by category. */
export const miniGamesFor = (category: GameCategory, catalog: readonly CatalogEntry[] = GAME_CATALOG): readonly CatalogEntry[] =>
  catalog.filter((game) => game.category === category && !isShuffleModuleId(game.id));

/** The module id a choice resolves to, or `null` when "Select Mini Game" has no pick yet (or the
 * pick does not belong to this category). */
export const resolveModuleId = (
  category: GameCategory,
  choice: ModeChoice,
  catalog: readonly CatalogEntry[] = GAME_CATALOG,
): string | null => {
  if (choice.mode === 'shuffle') return shuffleModuleId(category);
  if (choice.miniGameId === null) return null;
  return miniGamesFor(category, catalog).some((game) => game.id === choice.miniGameId) ? choice.miniGameId : null;
};

/** A clear message when the choice cannot be created/started, otherwise `null`. */
export const validateChoice = (
  category: GameCategory,
  choice: ModeChoice,
  catalog: readonly CatalogEntry[] = GAME_CATALOG,
): string | null => (resolveModuleId(category, choice, catalog) === null ? NO_MINI_GAME_MESSAGE : null);

/** Switching category always resets to Shuffle. */
export const choiceAfterCategoryChange = (): ModeChoice => DEFAULT_CHOICE;

/** Inverse of `resolveModuleId`: the control state that represents an existing selection. */
export const choiceFromModuleId = (moduleId: string | null): ModeChoice =>
  moduleId === null || isShuffleModuleId(moduleId) ? DEFAULT_CHOICE : { mode: 'select', miniGameId: moduleId };

/** Short user-facing label for a selection, e.g. for the lobby summary. */
export const choiceLabel = (moduleId: string, catalog: readonly CatalogEntry[] = GAME_CATALOG): string =>
  isShuffleModuleId(moduleId)
    ? SHUFFLE_LABEL
    : (catalog.find((game) => game.id === moduleId)?.name ?? moduleId);
