/**
 * Pure decision for the host's automatic `SELECT_GAME` after "Create room" on /host.
 *
 * The chosen module id is stashed in storage (`lib/storage.ts`, keyed by roomId); once the host's
 * room page is connected and the room is a fresh lobby with no selection, it is dispatched exactly
 * once through the normal `selectGame` path, so the same pending / slow / stalled / retry feedback
 * shows. The stored choice is cleared as soon as the server has answered (either way), so a reload
 * never loops.
 */

export type InitialSelectionAction = 'none' | 'dispatch' | 'clear';

export const decideInitialSelection = (input: {
  /** The stored module id for this room, if any. */
  readonly stored: string | null;
  readonly isHost: boolean;
  readonly phase: string;
  readonly selectionModuleId: string | null;
  readonly connected: boolean;
  /** True while a dispatch of the stored choice is in flight (or already answered this mount). */
  readonly dispatched: boolean;
}): InitialSelectionAction => {
  if (input.stored === null || !input.isHost) return 'none';
  // The lobby is over, or the server already holds a selection (ours confirmed, or a manual one):
  // the stored choice has nothing left to do.
  if (input.phase !== 'lobby' || input.selectionModuleId !== null) return 'clear';
  if (!input.connected || input.dispatched) return 'none';
  return 'dispatch';
};
