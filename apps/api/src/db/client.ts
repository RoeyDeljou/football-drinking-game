import { PrismaClient } from '@prisma/client';

export type { PrismaClient } from '@prisma/client';

export const createPrismaClient = (databaseUrl: string): PrismaClient =>
  new PrismaClient({ datasources: { db: { url: databaseUrl } } });
