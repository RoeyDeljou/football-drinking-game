/**
 * Postgres-backed `GeneralDatasetStore` (the port lives in `@fdg/football-data`). One row, keyed
 * `general`. The payload is opaque JSON here: `createGeneralDatasetLoader` validates it with Zod on
 * every read, so this module never interprets it and never throws on garbage — it just hands the
 * stored Json back.
 */

import type { GeneralDatasetStore } from '@fdg/football-data';
import type { Prisma } from '@prisma/client';
import type { PrismaClient } from '../db/client.js';

export const GENERAL_DATASET_ROW_ID = 'general';

export const createPrismaGeneralDatasetStore = (
  prisma: Pick<PrismaClient, 'generalDatasetSnapshot'>,
): GeneralDatasetStore => ({
  read: async () => {
    const row = await prisma.generalDatasetSnapshot.findUnique({ where: { id: GENERAL_DATASET_ROW_ID } });
    if (row === null) return null;
    return { snapshot: row.payload as unknown, savedAt: row.savedAt.toISOString() };
  },
  write: async (snapshot, meta) => {
    const payload = snapshot as unknown as Prisma.InputJsonValue;
    const builtAt = new Date(meta.builtAt);
    await prisma.generalDatasetSnapshot.upsert({
      where: { id: GENERAL_DATASET_ROW_ID },
      create: { id: GENERAL_DATASET_ROW_ID, builtAt, playerCount: meta.playerCount, payload },
      update: { builtAt, playerCount: meta.playerCount, payload },
    });
  },
});
