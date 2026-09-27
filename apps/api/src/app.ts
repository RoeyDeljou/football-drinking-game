import cors from '@fastify/cors';
import { createGeneralDatasetLoader } from '@fdg/football-data';
import type { FootballDataProvider, GeneralDatasetLoader } from '@fdg/football-data';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { Server as SocketIoServer } from 'socket.io';
import { registerAuthRoutes } from './auth/routes.js';
import { registerCompetitionRoutes } from './competitions/routes.js';
import { createFixtureListCache } from './competitions/fixture-list-cache.js';
import type { AppContext } from './context.js';
import { GAMEDAY_LIVE_POLL_MS } from './engine/data-context.js';
import type { GeneralDatasetAccess } from './engine/general-dataset-access.js';
import { createGeneralDatasetAccess } from './engine/general-dataset-access.js';
import { createFootballDataFromEnv } from './engine/football-data-provider.js';
import { createPrismaGeneralDatasetStore } from './engine/general-dataset-store.js';
import { createPrismaClient, type PrismaClient } from './db/client.js';
import type { AppEnv } from './env.js';
import { loadEnv } from './env.js';
import { registerFriendsRoutes } from './friends/routes.js';
import { LocalIdentityProvider } from './identity/local-identity-provider.js';
import { createRealtimeGateway } from './realtime/gateway.js';
import type { RealtimeGateway } from './realtime/gateway.js';
import { registerRoomRoutes } from './rooms/routes.js';
import { InMemoryRoomStore } from './rooms/store.js';

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly io: SocketIoServer;
  readonly ctx: AppContext;
  readonly gateway: RealtimeGateway;
  /** Real-load / warm-up access to the general dataset (see engine/general-dataset-access.ts). */
  readonly generalDatasetAccess: GeneralDatasetAccess;
  close(): Promise<void>;
}

export interface BuildAppOptions {
  readonly env?: AppEnv;
  readonly prisma?: PrismaClient;
  /** Test seam: a slow/failing/fixture-backed loader instead of the provider-backed one. */
  readonly generalDatasetLoader?: GeneralDatasetLoader;
  readonly generalDatasetCooldownMs?: number;
  /** Test seam: a wrapped/counting provider instead of the one built from the environment. */
  readonly footballData?: FootballDataProvider;
  /** Test seam: override the fixture-list cache TTL (default 90s, see competitions/fixture-list-cache.ts). */
  readonly fixtureListCacheTtlMs?: number;
  /** Test seam: override how often a gameday room's live-fixture pool is re-polled (default 90s, see
   * engine/data-context.ts's `GAMEDAY_LIVE_POLL_MS`). */
  readonly gamedayLivePollMs?: number;
}

const FLUSH_WRITES_TIMEOUT_MS = 3000;

export const buildApp = async (options: BuildAppOptions = {}): Promise<BuiltApp> => {
  const env = options.env ?? loadEnv();
  const prisma = options.prisma ?? createPrismaClient(env.DATABASE_URL);

  const footballData = options.footballData ?? createFootballDataFromEnv(process.env);
  const generalDatasetLoader =
    options.generalDatasetLoader ??
    createGeneralDatasetLoader(footballData, {
      // Stored snapshot first (instant start); a stale one is refreshed in the background.
      store: createPrismaGeneralDatasetStore(prisma),
      onWarning: (message) => console.warn(`[dataset] ${message}`),
    });
  const generalDatasetAccess = createGeneralDatasetAccess(
    generalDatasetLoader,
    options.generalDatasetCooldownMs === undefined ? {} : { cooldownMs: options.generalDatasetCooldownMs },
  );

  const ctx: AppContext = {
    env,
    prisma,
    identity: new LocalIdentityProvider({
      prisma,
      jwtAccessSecret: env.JWT_ACCESS_SECRET,
      jwtRefreshSecret: env.JWT_REFRESH_SECRET,
      accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
      refreshTtlSeconds: env.JWT_REFRESH_TTL_SECONDS,
    }),
    roomStore: new InMemoryRoomStore(),
    footballData,
    generalDataset: () => generalDatasetAccess.get(),
    roomTokenSecret: new TextEncoder().encode(env.ROOM_TOKEN_SECRET),
    fixtureListCache: createFixtureListCache(
      options.fixtureListCacheTtlMs === undefined ? {} : { ttlMs: options.fixtureListCacheTtlMs },
    ),
    gamedayLivePollMs: options.gamedayLivePollMs ?? GAMEDAY_LIVE_POLL_MS,
  };

  const app = Fastify({ logger: env.NODE_ENV !== 'test' });
  await app.register(cors, { origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',') });

  app.get('/health', async () => ({ ok: true }));

  registerAuthRoutes(app, ctx);
  registerFriendsRoutes(app, ctx);
  registerRoomRoutes(app, ctx);
  registerCompetitionRoutes(app, ctx);

  await app.ready();

  const io = new SocketIoServer(app.server, {
    cors: { origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',') },
  });
  const gateway = createRealtimeGateway(io, ctx);

  return {
    app,
    io,
    ctx,
    gateway,
    generalDatasetAccess,
    close: async () => {
      gateway.close();
      io.disconnectSockets(true);
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await app.close();
      // Let an in-flight fire-and-forget snapshot write settle before Prisma goes away, but never hang shutdown on it.
      if ('flushWrites' in generalDatasetLoader && typeof generalDatasetLoader.flushWrites === 'function') {
        const flush = (generalDatasetLoader.flushWrites as () => Promise<void>)().catch(() => undefined);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, FLUSH_WRITES_TIMEOUT_MS);
        });
        await Promise.race([flush, timeout]);
        clearTimeout(timer);
      }
      await prisma.$disconnect();
    },
  };
};
