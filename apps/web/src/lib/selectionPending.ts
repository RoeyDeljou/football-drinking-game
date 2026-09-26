/**
 * Pure state machine for the game picker's optimistic "pending" state.
 *
 * `SELECT_GAME` for a general game can take a long time the first time (the server may be waking
 * up and downloading real football data). Until the server answers, the UI must show honest
 * progress — but server truth stays authoritative: a game is only "selected" once `room.selection`
 * says so. This module only tracks *which click is awaiting an answer and for how long*. It never
 * decides anything about rules; time is injected (`now`) so it is deterministic in tests.
 */

export const SLOW_AFTER_MS = 8_000;
export const STALLED_AFTER_MS = 90_000;

export interface PendingSelection {
  readonly moduleId: string;
  readonly startedAt: number;
  /** `room.version` when clicked — a same-game re-select is only confirmed by a newer version. */
  readonly versionAtClick: number;
  /** Identity of the last `room:error` seen at click time; a different non-null one clears. */
  readonly errorTokenAtClick: unknown;
}

export type PendingState = PendingSelection | null;

export type PendingPhase = 'idle' | 'pending' | 'slow' | 'stalled';

/** A click. Clicking while another card is pending simply replaces it: the last click wins. */
export const beginPending = (input: {
  readonly moduleId: string;
  readonly now: number;
  readonly roomVersion: number;
  readonly errorToken: unknown;
}): PendingSelection => ({
  moduleId: input.moduleId,
  startedAt: input.now,
  versionAtClick: input.roomVersion,
  errorTokenAtClick: input.errorToken,
});

/** "Try again": re-send the same selection and restart the clock. */
export const retryPending = (
  pending: PendingSelection,
  input: { readonly now: number; readonly roomVersion: number; readonly errorToken: unknown },
): PendingSelection => beginPending({ moduleId: pending.moduleId, ...input });

export interface PendingObservation {
  readonly selectionModuleId: string | null;
  readonly roomVersion: number;
  readonly connected: boolean;
  readonly errorToken: unknown;
}

/**
 * Decide whether the pending state survives the latest server observation. Clears when the server
 * confirmed the selection, a `room:error` arrived, or the socket is no longer connected.
 */
export const resolvePending = (pending: PendingState, observed: PendingObservation): PendingState => {
  if (pending === null) return null;
  if (!observed.connected) return null;
  if (observed.errorToken !== null && observed.errorToken !== pending.errorTokenAtClick) return null;
  if (observed.selectionModuleId === pending.moduleId && observed.roomVersion > pending.versionAtClick) {
    return null;
  }
  return pending;
};

export const pendingPhase = (pending: PendingState, now: number): PendingPhase => {
  if (pending === null) return 'idle';
  const elapsed = now - pending.startedAt;
  if (elapsed >= STALLED_AFTER_MS) return 'stalled';
  if (elapsed >= SLOW_AFTER_MS) return 'slow';
  return 'pending';
};
