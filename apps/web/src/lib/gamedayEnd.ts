/**
 * The "no more live matches" end-of-gameday condition (see the known gap `CLAUDE.md`/the host task
 * flagged: once every live fixture in a gameday room's competition finishes mid-session, the next
 * `ADVANCE` a host tries has nothing left to rotate through). The engine surfaces that as a rejected
 * action rather than a crash or a silently stuck room — `ROUND_GENERATION_FAILED` when `buildRound`
 * itself fails against an empty data context (the actual path today, see
 * `packages/game-core/src/reducer.ts`'s `ADVANCE` case), or `DATA_UNAVAILABLE` wherever a
 * `checkModulePlayable` check runs first. Both are treated identically here: in a gameday room, either
 * one means the same thing to a host — nothing left to play, wrap it up — never "try again", which is
 * what the generic copy for those codes implies elsewhere.
 */

const GAMEDAY_EXHAUSTED_CODES: ReadonlySet<string> = new Set(['ROUND_GENERATION_FAILED', 'DATA_UNAVAILABLE']);

/** Whether a rejection code, seen in a gameday room, means "every live match this room was rotating
 * through has ended" rather than some other, retryable failure. */
export const isGamedayExhaustedErrorCode = (code: string): boolean => GAMEDAY_EXHAUSTED_CODES.has(code);

/**
 * Whether the room screen should show the dedicated "no more live matches" end-of-session banner
 * (with its own "End room" action) instead of the generic dismissable error banner.
 *
 * Two conditions must both hold, not just a matching error code: this is a gameday room, *and* the
 * rejected action was `ADVANCE` (the only action that actually tries to generate a fresh round mid-
 * session). `DATA_UNAVAILABLE` in particular is not unique to "nothing left to rotate through" — it's
 * also `SELECT_GAME`'s ordinary "this specific game needs data we don't have" rejection
 * (`checkModulePlayable`, see `packages/game-core/src/reducer.ts`), which can fire for a perfectly
 * healthy gameday room whose live matches just don't happen to carry what one particular game module
 * wants (e.g. no player profiles for "Who's That Player?"). Without the action check, picking an
 * unplayable game in a gameday room would misreport as "the whole gameday just ended".
 */
export const shouldShowGamedayExhaustedBanner = (
  isGameday: boolean,
  errorCode: string | null,
  rejectedActionWasAdvance: boolean,
): boolean => isGameday && rejectedActionWasAdvance && errorCode !== null && isGamedayExhaustedErrorCode(errorCode);
