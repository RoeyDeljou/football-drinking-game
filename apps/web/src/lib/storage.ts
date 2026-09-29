/**
 * Everything this app persists in `localStorage`: the active room's reconnect token (so a dropped
 * connection or a page refresh mid-game can resume instead of dead-ending the player) and the
 * one-time 18+/responsible-drinking age-gate confirmation (see `lib/ageGate.ts`). Guests are
 * first-class: none of this requires an account — sign-in/registration is not part of this app's
 * own UI (that seam is left for a future hub integration; see `IdentityProvider` in `apps/api`).
 */

export interface StoredRoom {
  readonly roomId: string;
  readonly pin: string;
  readonly playerId: string;
  readonly roomToken: string;
  readonly isHost: boolean;
}

const ROOM_KEY = 'fdg:room';
const PENDING_SELECTION_KEY = 'fdg:pending-selection';
const AGE_GATE_KEY = 'fdg:age-gate-confirmed';

const readJson = <T>(key: string): T | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const writeJson = (key: string, value: unknown): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can throw (blocked cookies/storage, private-browsing quota, a third-party-storage
    // restriction). Silently proceeding without persisting is safer than throwing here: a caller
    // like `AgeGateGuard.onContinue` calls `confirmAgeGate()` then unconditionally updates its own
    // state — if this threw, the confirmation would never take effect for the rest of the session,
    // leaving the guest stuck behind a gate that keeps requiring a "Continue" that does nothing. The
    // safe failure mode is "confirmed for this session but not remembered next time", not "unusable".
  }
};

const clearKey = (key: string): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(key);
};

export const loadRoom = (): StoredRoom | null => readJson<StoredRoom>(ROOM_KEY);
export const saveRoom = (room: StoredRoom): void => writeJson(ROOM_KEY, room);
export const clearRoom = (): void => clearKey(ROOM_KEY);

export const loadAgeGateConfirmed = (): boolean => readJson<true>(AGE_GATE_KEY) === true;
export const saveAgeGateConfirmed = (): void => writeJson(AGE_GATE_KEY, true);

/**
 * The game the host chose on the /host setup screen, carried to the room lobby (keyed by roomId) so
 * the room page can dispatch `SELECT_GAME` once connected. Cleared as soon as the server confirms or
 * rejects it, so a reload never loops.
 */
export interface PendingInitialSelection {
  readonly roomId: string;
  readonly moduleId: string;
}

export const savePendingSelection = (roomId: string, moduleId: string): void =>
  writeJson(PENDING_SELECTION_KEY, { roomId, moduleId } satisfies PendingInitialSelection);

export const loadPendingSelection = (roomId: string): string | null => {
  const stored = readJson<Partial<PendingInitialSelection>>(PENDING_SELECTION_KEY);
  if (stored === null || stored.roomId !== roomId || typeof stored.moduleId !== 'string') return null;
  return stored.moduleId;
};

export const clearPendingSelection = (): void => {
  try {
    clearKey(PENDING_SELECTION_KEY);
  } catch {
    // Blocked storage: nothing was persisted, so nothing to clear.
  }
};
