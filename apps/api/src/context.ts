import type { FootballDataProvider, GeneralDataset } from '@fdg/football-data';
import type { FixtureListCache } from './competitions/fixture-list-cache.js';
import type { PrismaClient } from './db/client.js';
import type { AppEnv } from './env.js';
import type { IdentityProvider } from './identity/types.js';
import type { LiveIngestion } from './live/ingestion.js';
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
  /** Short-TTL cache in front of `getFixturesByCompetition`, see competitions/fixture-list-cache.ts. */
  readonly fixtureListCache: FixtureListCache;
  /** How often a gameday room's live-fixture pool is re-polled, see engine/data-context.ts's
   * `refreshGamedayLiveSet` (default `GAMEDAY_LIVE_POLL_MS`, overridable in tests). */
  readonly gamedayLivePollMs: number;
  /** Live-event ingestion (see live/ingestion.ts). Optional so hand-built contexts keep compiling;
   * `buildApp` always supplies it. `dispatchAction` notifies it after every dispatch. */
  readonly liveIngestion?: LiveIngestion;
}
