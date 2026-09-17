/**
 * Branded engine ids.
 *
 * `PlayerId` is a *participant* in a room (a human holding a phone). A footballer is a
 * `FootballPlayerId` and lives in `@fdg/football-data` — the two must never be mixed up,
 * which is exactly what the brands prevent.
 */

export type RoomId = string & { readonly __brand: 'RoomId' };
export type PlayerId = string & { readonly __brand: 'PlayerId' };
export type SessionId = string & { readonly __brand: 'SessionId' };
export type RoundId = string & { readonly __brand: 'RoundId' };
export type GameModuleId = string & { readonly __brand: 'GameModuleId' };

export const asRoomId = (value: string): RoomId => value as RoomId;
export const asPlayerId = (value: string): PlayerId => value as PlayerId;
export const asSessionId = (value: string): SessionId => value as SessionId;
export const asRoundId = (value: string): RoundId => value as RoundId;
export const asGameModuleId = (value: string): GameModuleId => value as GameModuleId;

/**
 * A map keyed by a branded id. Reads are `T | undefined` because `noUncheckedIndexedAccess`
 * is on, which is the behaviour we want at every call site.
 */
export type ById<K extends string, T> = Readonly<Partial<Record<K, T>>>;
