/**
 * Build the general-games dataset from the live providers and store it in Postgres, so the server
 * can load it instantly at startup. Run by `.github/workflows/sync-dataset.yml` every few hours,
 * or by hand: `npm run sync:dataset` (from the repo root; needs DATABASE_URL, and
 * FOOTBALL_DATA_PROVIDER=live for real data).
 *
 * This is not a server: it needs only DATABASE_URL (+ optional provider keys), never the JWT
 * secrets or the CORS production guard, so it deliberately does not go through `loadEnv`.
 */

import { createGeneralDatasetLoader } from '@fdg/football-data';
import { createPrismaClient } from '../db/client.js';
import { runDatasetSync } from '../engine/dataset-sync.js';
import { createFootballDataFromEnv } from '../engine/football-data-provider.js';
import { createPrismaGeneralDatasetStore } from '../engine/general-dataset-store.js';

/** Render's external Postgres endpoint requires TLS; Prisma will not insist on it unless told to. */
const withTlsForRender = (url: string): string => {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('.render.com') && !parsed.searchParams.has('sslmode')) {
      parsed.searchParams.set('sslmode', 'require');
      return parsed.toString();
    }
  } catch {
    // leave an unparseable URL for Prisma to report
  }
  return url;
};

const main = async (): Promise<number> => {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    console.error('[sync] DATABASE_URL is required.');
    return 1;
  }
  const prisma = createPrismaClient(withTlsForRender(databaseUrl));
  try {
    const store = createPrismaGeneralDatasetStore(prisma);
    const loader = createGeneralDatasetLoader(createFootballDataFromEnv(process.env), {
      store,
      onWarning: (message) => console.warn(`[dataset] ${message}`),
    });
    const outcome = await runDatasetSync({ loader, store });
    await loader.flushWrites();
    return outcome.exitCode;
  } finally {
    await prisma.$disconnect();
  }
};

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error('[sync] FAILED:', error);
    process.exit(1);
  },
);
