/**
 * Pure lookup tables describing the room connection's terminal states — split out from
 * `room-context.tsx` (a "use client" component file) so they're trivially unit-testable without
 * needing a DOM/JSX test environment.
 */

/**
 * `connect_error` codes that can never be recovered by retrying the same connection — socket.io's
 * default infinite-retry loop must be stopped and the fatal-error screen (with its "Back to start"
 * escape hatch) shown instead. `ROOM_TERMINAL` belongs here: the engine rejects every action on a
 * finished/aborted room (`reducer.ts`), so retrying a reconnect to one can only ever fail again —
 * without it here, a reconnect to an ended room falls through to `setStatus('reconnecting')` and
 * retries forever on a bare, control-free spinner.
 */
export const FATAL_CONNECT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ROOM_NOT_FOUND',
  'INVALID_ROOM_TOKEN',
  'INVALID_AUTH',
  'UNAUTHENTICATED',
  'PLAYER_KICKED',
  'ROOM_TERMINAL',
]);

/** A room in one of these phases is over for good — nothing can resume it, so it must not keep
 * offering "Rejoin" from the landing page once it gets here. */
export const TERMINAL_ROOM_PHASES: ReadonlySet<string> = new Set(['finished', 'aborted']);

/** Whether a `ProjectedRoom.phase` value means the room's stored session should be forgotten. */
export const isTerminalRoomPhase = (phase: string): boolean => TERMINAL_ROOM_PHASES.has(phase);
