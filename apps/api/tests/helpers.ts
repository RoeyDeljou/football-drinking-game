import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { io as ioClient } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import type { BuiltApp } from '../src/app.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';

const apiDir = fileURLToPath(new URL('..', import.meta.url));

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION', reason);
});

export interface TestServer extends BuiltApp {
  readonly baseUrl: string;
  readonly socketUrl: string;
  stop(): Promise<void>;
}

/**
 * Base connection string for the local Postgres the whole suite shares (see root
 * `docker-compose.yml` — `docker compose up -d` before `npm test`). Every test server gets its own
 * throwaway `?schema=` inside this same database so parallel test files never see each other's
 * rows, without needing a separate database per file.
 */
const baseDatabaseUrl = (): string =>
  process.env.DATABASE_URL ?? 'postgresql://fdg:fdg@localhost:5432/fdg?schema=public';

const withSchema = (url: string, schema: string): string => {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', schema);
  return parsed.toString();
};

/**
 * Boots a real server against a fresh, migrated schema inside the shared local Postgres instance —
 * never the fixture-provider network. Postgres, not SQLite, so the suite exercises exactly what
 * production runs (see apps/api/prisma/schema.prisma).
 */
export const startTestServer = async (): Promise<TestServer> => {
  process.env.FOOTBALL_DATA_PROVIDER = 'fixture';

  const schema = `test_${randomBytes(8).toString('hex')}`;
  const databaseUrl = withSchema(baseDatabaseUrl(), schema);

  try {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  } catch (error) {
    throw new Error(
      'Failed to migrate the test database schema. Is a local Postgres running? ' +
        '(`docker compose up -d` from the repo root, then re-run tests.) ' +
        `Underlying error: ${String(error)}`,
    );
  }

  const env = loadEnv({
    ...process.env,
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    FOOTBALL_DATA_PROVIDER: 'fixture',
  });

  const built = await buildApp({ env });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const address = built.app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    ...built,
    baseUrl,
    socketUrl: baseUrl,
    stop: async () => {
      // Drop the throwaway schema before disconnecting — `built.close()` tears down the same
      // Prisma client this runs on, so it must happen first, not after.
      await built.ctx.prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await built.close();
    },
  };
};

export const connectSocket = (
  server: TestServer,
  auth: Record<string, unknown>,
): Promise<ClientSocket> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(server.socketUrl, { auth, transports: ['websocket'], forceNew: true });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error: Error) => reject(error));
  });

/**
 * Connects and returns both the raw socket and a `StateTracker` whose `room:state` listener is
 * registered *before* the socket ever connects — not after awaiting `room:joined`. The server can
 * (and does, in practice — socket.io batches packets flushed in the same tick) deliver `room:joined`
 * and the very first `room:state` in one synchronous dispatch to the client; a listener attached only
 * after `await`-ing `room:joined` can lose that first `room:state` for good, and every later
 * `waitFor` call hangs until its own timeout. Attaching before `connect` makes that race impossible.
 */
export const connectAndTrack = async <T extends { phase: string } = ProjectedRoomLike>(
  server: TestServer,
  auth: Record<string, unknown>,
): Promise<{ socket: ClientSocket; state: StateTracker<T>; joined: RoomJoinedPayload }> => {
  const socket = ioClient(server.socketUrl, { auth, transports: ['websocket'], forceNew: true });
  const state = trackState<T>(socket);
  const joinedPromise = waitForEvent<RoomJoinedPayload>(socket, 'room:joined');

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (error: Error) => reject(error));
  });

  const joined = await joinedPromise;
  return { socket, state, joined };
};

interface ProjectedRoomLike {
  readonly phase: string;
}

export interface RoomJoinedPayload {
  readonly roomId: string;
  readonly pin: string;
  readonly playerId: string;
  readonly isHost: boolean;
  readonly roomToken: string;
}

export const waitForEvent = <T = unknown>(socket: ClientSocket, event: string): Promise<T> =>
  new Promise((resolve) => {
    socket.once(event, (payload: T) => resolve(payload));
  });

/**
 * Tracks every `room:state` broadcast a socket receives so `waitForState` can check the latest
 * known state immediately (not just future ones) — otherwise a state that arrives between two
 * `waitForState` calls is silently missed and the second call hangs forever.
 */
export interface StateTracker<T> {
  latest(): T | undefined;
  waitFor(predicate: (state: T) => boolean, timeoutMs?: number): Promise<T>;
}

export const trackState = <T extends { phase: string }>(socket: ClientSocket): StateTracker<T> => {
  let latest: T | undefined;
  const waiters: { predicate: (state: T) => boolean; resolve: (state: T) => void }[] = [];

  socket.on('room:state', (state: T) => {
    latest = state;
    for (const waiter of [...waiters]) {
      if (waiter.predicate(state)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(state);
      }
    }
  });

  return {
    latest: () => latest,
    waitFor: (predicate, timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        if (latest !== undefined && predicate(latest)) {
          resolve(latest);
          return;
        }
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
  };
};

export const jsonFetch = async (
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const body: unknown = text.length === 0 ? null : JSON.parse(text);
  return { status: response.status, body };
};
