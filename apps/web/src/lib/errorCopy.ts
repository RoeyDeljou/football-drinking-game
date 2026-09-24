/**
 * Maps the engine's/gateway's machine-oriented rejection codes to short player-facing copy. The
 * engine explicitly documents `EngineRejection.detail` as "machine-oriented, not user-facing copy"
 * (a Zod issue, an id, a raw epoch timestamp) — nothing from `detail` or a raw `code` should ever
 * reach a player directly. This is the one place that translation happens.
 */

export interface RoomErrorLike {
  readonly code: string;
  readonly detail: string | null;
  readonly submissionCode?: string | null;
}

const REJECTION_COPY: Record<string, string> = {
  ROOM_TERMINAL: 'This room has already ended.',
  WRONG_PHASE: 'That’s not possible right now — try again in a moment.',
  NOT_HOST: 'Only the host can do that.',
  PLAYER_NOT_FOUND: 'That player is no longer in the room.',
  PLAYER_ALREADY_JOINED: 'You’re already in this room.',
  PLAYER_KICKED: 'You were removed from this room.',
  NICKNAME_TAKEN: 'That nickname is already taken in this room.',
  ROOM_FULL: 'This room is full.',
  LATE_JOIN_DISABLED: 'This room isn’t accepting new players right now.',
  CANNOT_KICK_HOST: 'The host can’t be removed.',
  INVALID_SETTINGS: 'Those settings aren’t valid.',
  UNKNOWN_MODULE: 'That game isn’t available.',
  INVALID_CONFIG: 'That game’s settings aren’t valid.',
  DATA_UNAVAILABLE: 'Not enough match data to play that game right now.',
  NO_GAME_SELECTED: 'Pick a game first.',
  LOADING_INCOMPLETE: 'Loading hasn’t finished yet.',
  NOT_ENOUGH_PLAYERS: 'Need more players to start.',
  TOO_MANY_PLAYERS: 'Too many players for this game.',
  ROUND_GENERATION_FAILED: 'Couldn’t build the next round — try again.',
  NO_ACTIVE_SESSION: 'No game is running right now.',
  SESSION_FINISHED: 'That game has finished — pick a new one.',
  ROUND_NOT_FOUND: 'That round has already moved on.',
  ROUND_CLOSED: 'Answers are closed for this round.',
  DEADLINE_PASSED: 'Too slow — the answer window closed.',
  DUPLICATE_SUBMISSION: 'You’ve already answered this round.',
  INVALID_SUBMISSION: 'That answer wasn’t accepted.',
  NOT_YOUR_TURN: 'It’s not your turn yet.',
  PLAYER_ELIMINATED: 'You’re out of this round.',
  UNKNOWN_LOADING_STEP: 'Something went wrong loading the match.',
  ROUND_NOT_LOCKABLE: 'This round can’t be locked manually.',
  // Gateway-level (apps/api/src/realtime/gateway.ts), never produced by the reducer.
  INVALID_PAYLOAD: 'That action wasn’t understood.',
  FORBIDDEN: 'You can’t do that.',
  ROOM_NOT_FOUND: 'That room doesn’t exist anymore.',
  INVALID_ROOM_TOKEN: 'Your seat expired — rejoin with the PIN.',
  INVALID_AUTH: 'Couldn’t connect — try rejoining.',
  UNAUTHENTICATED: 'Please sign in again.',
};

const SUBMISSION_COPY: Record<string, string> = {
  SCHEMA: 'That answer wasn’t valid.',
  UNKNOWN_OPTION: 'That pick isn’t on the board.',
  OUT_OF_RANGE: 'That guess is out of range.',
  INCOMPLETE: 'Fill in every pick before submitting.',
  NOT_ALLOWED: 'That submission isn’t allowed.',
  MARKET_SETTLED: 'That market has already been settled.',
  SLIP_LOCKED: 'Kick-off happened — the slip is locked.',
};

export const errorMessage = (error: RoomErrorLike): string => {
  if (error.submissionCode !== undefined && error.submissionCode !== null) {
    const submissionCopy = SUBMISSION_COPY[error.submissionCode];
    if (submissionCopy !== undefined) return submissionCopy;
  }
  return REJECTION_COPY[error.code] ?? 'Something went wrong. Try again.';
};
