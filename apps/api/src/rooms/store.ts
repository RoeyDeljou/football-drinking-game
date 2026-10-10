/**
 * `RoomStore` — the realtime-state seam (see CLAUDE.md / docs/ARCHITECTURE.md). Rooms live here,
 * in memory, for the lifetime of the process. A Redis-backed implementation is a drop-in later:
 * every call site only ever sees this interface, never a `Map`.
 *
 * Durable, post-hoc data (accounts, finished sessions, round results, stats) lives in Postgres
 * via Prisma instead — see `src/persistence`.
 *
 * `RoomMeta` carries the one piece of server-owned context the engine itself has no concept of:
 * which live fixture (if any) a matchday room is tied to, so `buildRoundDataContext` knows what to
 * fetch. It travels next to `RoomState` rather than inside it, because it is transport bookkeeping,
 * not game state.
 *
 * A matchday room is either tied to one specific fixture (`fixtureId`) or, for "gameday mode", to a
 * whole competition whose currently-live fixtures rotate round to round (`gamedayCompetitionId`) —
 * never both. `gamedayCompetitionId` is optional (not just nullable) so every pre-existing call site
 * and test that only ever constructed `{ fixtureId }` literals keeps compiling unchanged; read it
 * through `meta.gamedayCompetitionId ?? null`.
 *
 * A general room may optionally scope itself to one competition (`generalCompetitionId`) instead of
 * drawing from every competition's combined data — see `engine/general-scope.ts` for how
 * `buildRoundDataContext` turns this into a filtered `GeneralDataset` view. `null`/absent (the
 * default) keeps drawing from the combined dataset, exactly as before this existed. Mutually
 * exclusive with `fixtureId`/`gamedayCompetitionId` in practice (only set on a `category: 'general'`
 * room), but not modelled as a discriminated union here for the same reason `gamedayCompetitionId`
 * isn't either — every field next to it already defaults independently.
 */

import type { CompetitionId, FixtureId } from '@fdg/football-data';
import type { RoomId, RoomState } from '@fdg/game-core';

export interface RoomMeta {
  /** The single fixture of a one-fixture matchday room. For a multi-fixture pool this is `null` (see `fixtureIds`). */
  readonly fixtureId: FixtureId | null;
  /**
   * Explicit rotation pool of a multi-fixture matchday room (2..20 fixtures, any competitions): rounds rotate across
   * them exactly like gameday mode does across a competition's live fixtures, but over THIS list. Absent/`null`/empty
   * for every other room. A one-fixture selection is stored as plain `fixtureId`, never as a pool of one.
   */
  readonly fixtureIds?: readonly FixtureId[] | null;
  /** Set only for a gameday room; absent/`null` for a single-fixture matchday room or a general room. */
  readonly gamedayCompetitionId?: CompetitionId | null;
  /** Set only for a competition-scoped general room; absent/`null` for the default combined dataset. */
  readonly generalCompetitionId?: CompetitionId | null;
}

/** The explicit multi-fixture pool, or `null` when the room is not one. */
export const poolFixtureIds = (meta: RoomMeta): readonly FixtureId[] | null =>
  meta.fixtureIds !== undefined && meta.fixtureIds !== null && meta.fixtureIds.length > 1 ? meta.fixtureIds : null;

/** Every fixture a matchday room is tied to, for display: the single fixture, the pool, or `[]` (general / gameday). */
export const roomFixtureIds = (meta: RoomMeta): readonly FixtureId[] =>
  poolFixtureIds(meta) ?? (meta.fixtureId === null ? [] : [meta.fixtureId]);

/** Rounds rotate across several fixtures: gameday mode (a competition's live fixtures) or an explicit pool. */
export const isRotationRoom = (meta: RoomMeta): boolean =>
  (meta.gamedayCompetitionId ?? null) !== null || poolFixtureIds(meta) !== null;

export const EMPTY_ROOM_META: RoomMeta = {
  fixtureId: null,
  gamedayCompetitionId: null,
  generalCompetitionId: null,
};

export interface RoomRecord {
  readonly state: RoomState;
  readonly meta: RoomMeta;
}

export interface RoomStore {
  load(roomId: RoomId): Promise<RoomRecord | null>;
  save(record: RoomRecord): Promise<void>;
  findByPin(pin: string): Promise<RoomRecord | null>;
  delete(roomId: RoomId): Promise<void>;
  /** For an idle-room sweep / metrics; not required for correctness. */
  listIds(): Promise<readonly RoomId[]>;
}

export class InMemoryRoomStore implements RoomStore {
  private readonly rooms = new Map<RoomId, RoomRecord>();
  private readonly pinIndex = new Map<string, RoomId>();

  async load(roomId: RoomId): Promise<RoomRecord | null> {
    return this.rooms.get(roomId) ?? null;
  }

  async save(record: RoomRecord): Promise<void> {
    this.rooms.set(record.state.id, record);
    this.pinIndex.set(record.state.pin, record.state.id);
  }

  async findByPin(pin: string): Promise<RoomRecord | null> {
    const roomId = this.pinIndex.get(pin);
    if (roomId === undefined) return null;
    return this.rooms.get(roomId) ?? null;
  }

  async delete(roomId: RoomId): Promise<void> {
    const room = this.rooms.get(roomId);
    if (room !== undefined) this.pinIndex.delete(room.state.pin);
    this.rooms.delete(roomId);
  }

  async listIds(): Promise<readonly RoomId[]> {
    return [...this.rooms.keys()];
  }
}
