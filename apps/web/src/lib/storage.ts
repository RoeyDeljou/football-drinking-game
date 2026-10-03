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
const ROOM_SETUP_KEY = 'fdg:room-setup';

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
  /** The host's custom game settings (`SELECT_GAME.config`); absent = the game's defaults. */
  readonly config?: Record<string, unknown>;
}

export const savePendingSelection = (roomId: string, moduleId: string, config: Record<string, unknown> | null = null): void =>
  writeJson(PENDING_SELECTION_KEY, { roomId, moduleId, ...(config === null ? {} : { config }) } satisfies PendingInitialSelection);

export const loadPendingConfig = (roomId: string): Record<string, unknown> | null => {
  const stored = readJson<Partial<PendingInitialSelection>>(PENDING_SELECTION_KEY);
  if (stored === null || stored.roomId !== roomId || typeof stored.config !== 'object' || stored.config === null) return null;
  return stored.config;
};

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

/**
 * What the host set up on /host, kept (keyed by roomId) for the lobby summary: the room's category,
 * known before the server round trip that otherwise supplies it, and a short label for the chosen
 * scope ("Premier League", "Arsenal vs Chelsea", "Live gameday · La Liga"). Display only — the
 * server stays the source of truth for what the room actually is.
 */
export interface StoredRoomSetup {
  readonly roomId: string;
  readonly category: 'matchday' | 'general';
  readonly scopeLabel: string;
}

export const saveRoomSetup = (setup: StoredRoomSetup): void => writeJson(ROOM_SETUP_KEY, setup);

export const loadRoomSetup = (roomId: string): StoredRoomSetup | null => {
  const stored = readJson<Partial<StoredRoomSetup>>(ROOM_SETUP_KEY);
  if (
    stored === null ||
    stored.roomId !== roomId ||
    (stored.category !== 'matchday' && stored.category !== 'general') ||
    typeof stored.scopeLabel !== 'string'
  ) {
    return null;
  }
  return { roomId, category: stored.category, scopeLabel: stored.scopeLabel };
};
