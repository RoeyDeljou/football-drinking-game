import type { EngineDeps, GameCategory, GameModuleRegistry, RoomAction, RoomState } from '@fdg/game-core';
import { activeSession, createDefaultRegistry, MULBERRY32 } from '@fdg/game-core';
import type { AppContext } from '../context.js';
import type { RoomMeta } from '../rooms/store.js';
import { buildRoundDataContext } from './data-context.js';

/** One shared registry instance for the whole process — modules are stateless. */
export const registry: GameModuleRegistry = createDefaultRegistry();

const resolveCategory = (room: RoomState, action: RoomAction): GameCategory | null => {
  if (action.type === 'SELECT_GAME') {
    return registry.get(action.moduleId)?.category ?? null;
  }
  if (room.selection !== null) {
    return registry.get(room.selection.moduleId)?.category ?? null;
  }
  const session = activeSession(room);
  return session === undefined ? null : session.category;
};

/** Builds the `EngineDeps` a single dispatch needs: the server-owned clock, RNG, module registry
 * and football data context, the last resolved fresh for every dispatch (cheap: matchday reads a
 * per-room cache, general reads a process-wide cache). */
export const buildEngineDeps = async (
  ctx: AppContext,
  room: RoomState,
  meta: RoomMeta,
  action: RoomAction,
): Promise<EngineDeps> => {
  const category = resolveCategory(room, action);
  const data = await buildRoundDataContext(ctx, room.id, meta, category);
  return {
    clock: { now: () => Date.now() },
    rng: MULBERRY32,
    modules: registry,
    data,
  };
};
