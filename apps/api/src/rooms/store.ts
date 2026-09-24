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
 */

import type { FixtureId } from '@fdg/football-data';
import type { RoomId, RoomState } from '@fdg/game-core';

export interface RoomMeta {
  readonly fixtureId: FixtureId | null;
}

export const EMPTY_ROOM_META: RoomMeta = { fixtureId: null };

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
