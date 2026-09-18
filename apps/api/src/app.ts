import cors from '@fastify/cors';
import {
  createFootballDataProvider,
  createGeneralDatasetLoader,
  EMPTY_DATA_QUALITY,
  readFootballDataConfigFromEnv,
} from '@fdg/football-data';
import type { GeneralDataset } from '@fdg/football-data';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { Server as SocketIoServer } from 'socket.io';
import { registerAuthRoutes } from './auth/routes.js';
import type { AppContext } from './context.js';
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
  close(): Promise<void>;
}

const emptyGeneralDataset = (): GeneralDataset => ({
  builtAt: new Date(0).toISOString(),
  competitions: [],
  teams: [],
  players: [],
  seasonStats: [],
  profiles: [],
  leaderboards: [],
  guessableStats: [],
  quality: EMPTY_DATA_QUALITY,
  gameAvailability: [],
  playersById: new Map(),
  statsByPlayer: new Map(),
  profilesByPlayer: new Map(),
  guessableStatsByPlayer: new Map(),
});

export interface BuildAppOptions {
  readonly env?: AppEnv;
  readonly prisma?: PrismaClient;
}

export const buildApp = async (options: BuildAppOptions = {}): Promise<BuiltApp> => {
  const env = options.env ?? loadEnv();
  const prisma = options.prisma ?? createPrismaClient(env.DATABASE_URL);

  const footballData = createFootballDataProvider(readFootballDataConfigFromEnv(process.env));
  const generalDatasetLoader = createGeneralDatasetLoader(footballData);
  let generalDatasetFallback: GeneralDataset | null = null;

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
    generalDataset: async () => {
      const result = await generalDatasetLoader.load();
      if (result.ok) return result.value;
      generalDatasetFallback ??= emptyGeneralDataset();
      return generalDatasetFallback;
    },
    roomTokenSecret: new TextEncoder().encode(env.ROOM_TOKEN_SECRET),
  };

  const app = Fastify({ logger: env.NODE_ENV !== 'test' });
  await app.register(cors, { origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',') });

  app.get('/health', async () => ({ ok: true }));

  registerAuthRoutes(app, ctx);
  registerFriendsRoutes(app, ctx);
  registerRoomRoutes(app, ctx);

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
    close: async () => {
      gateway.close();
      io.disconnectSockets(true);
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await app.close();
      await prisma.$disconnect();
    },
  };
};
