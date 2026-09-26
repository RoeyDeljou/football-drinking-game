import cors from '@fastify/cors';
import {
  createFootballDataProvider,
  createGeneralDatasetLoader,
  readFootballDataConfigFromEnv,
} from '@fdg/football-data';
import type { GeneralDatasetLoader } from '@fdg/football-data';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { Server as SocketIoServer } from 'socket.io';
import { registerAuthRoutes } from './auth/routes.js';
import type { AppContext } from './context.js';
import type { GeneralDatasetAccess } from './engine/general-dataset-access.js';
import { createGeneralDatasetAccess } from './engine/general-dataset-access.js';
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
}

export const buildApp = async (options: BuildAppOptions = {}): Promise<BuiltApp> => {
  const env = options.env ?? loadEnv();
  const prisma = options.prisma ?? createPrismaClient(env.DATABASE_URL);

  const footballData = createFootballDataProvider(readFootballDataConfigFromEnv(process.env));
  const generalDatasetAccess = createGeneralDatasetAccess(
    options.generalDatasetLoader ?? createGeneralDatasetLoader(footballData),
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
    generalDatasetAccess,
    close: async () => {
      gateway.close();
      io.disconnectSockets(true);
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await app.close();
      await prisma.$disconnect();
    },
  };
};
