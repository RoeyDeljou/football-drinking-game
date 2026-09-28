/**
 * The one-time 18+ / responsible-drinking confirmation every player passes through before they can
 * host or join their first room in this browser (CLAUDE.md: "Signup carries an 18+ confirmation and
 * a responsible-drinking notice"). There is no account signup screen left to carry that gate — every
 * user is a guest from this app's own perspective (see `apps/web/src/app/page.tsx`) — so it lives
 * here instead, gating both the host flow and the join flow directly, and is remembered afterward via
 * `lib/storage.ts` so it only asks once per browser, not once per room.
 */
import { loadAgeGateConfirmed, saveAgeGateConfirmed } from './storage';

/** Whether the age-gate has already been confirmed in this browser. */
export const isAgeGateConfirmed = (): boolean => loadAgeGateConfirmed();

/** Records the confirmation so future visits skip the prompt. */
export const confirmAgeGate = (): void => saveAgeGateConfirmed();

/** Pure decision the gate component renders off: an unconfirmed gate blocks the action it guards. */
export const ageGateBlocksAction = (confirmed: boolean): boolean => !confirmed;
