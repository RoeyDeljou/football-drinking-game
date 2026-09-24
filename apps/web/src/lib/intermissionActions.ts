/**
 * What the host's "continue" tap on the intermission screen should dispatch.
 *
 * The engine's `START_LOADING` action only ever accepts phase `'lobby'` (or a failed-loading
 * retry) — dispatching it from `'intermission'` is always rejected `WRONG_PHASE`. The action the
 * reducer actually accepts from `'intermission'` to begin a new session (same game or a different
 * one, after `SELECT_GAME`) is `START_SESSION` directly — loading is skipped because the room's
 * data (matchday bundle or general dataset) is already cached from the first session. Mid-session,
 * between rounds, the correct action is `ADVANCE`.
 *
 * See `packages/game-core/src/reducer.ts`: `START_SESSION` accepts `'lobby' | 'loading' |
 * 'intermission'`, `START_LOADING` accepts only `'lobby'` (or a failed retry).
 */
export type IntermissionContinueAction = { readonly type: 'ADVANCE' } | { readonly type: 'START_SESSION' };

export const intermissionContinueAction = (sessionFinished: boolean): IntermissionContinueAction =>
  sessionFinished ? { type: 'START_SESSION' } : { type: 'ADVANCE' };
