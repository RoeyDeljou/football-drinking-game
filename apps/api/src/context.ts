import type { FootballDataProvider, GeneralDataset } from '@fdg/football-data';
import type { PrismaClient } from './db/client.js';
import type { AppEnv } from './env.js';
import type { IdentityProvider } from './identity/types.js';
import type { RoomStore } from './rooms/store.js';

/**
 * Everything a route handler or socket handler needs, assembled once at boot and threaded through
 * Fastify's `app.decorate`. Nothing here is global mutable module state, which is what keeps the
 * integration tests able to boot multiple independent server instances in one process.
 */
export interface AppContext {
  readonly env: AppEnv;
  readonly prisma: PrismaClient;
  readonly identity: IdentityProvider;
  readonly roomStore: RoomStore;
  readonly footballData: FootballDataProvider;
  /** The general-games dataset: built lazily by the loader (or earlier by the boot warm-up), cached
   * for the process lifetime, and an empty dataset during a failure cool-down. See
   * engine/general-dataset-access.ts. */
  readonly generalDataset: () => Promise<GeneralDataset>;
  readonly roomTokenSecret: Uint8Array;
}
