import { createFootballDataProvider, readFootballDataConfigFromEnv } from '@fdg/football-data';
import type { FootballDataProvider } from '@fdg/football-data';

/** The one place the API (server and sync script alike) builds its provider from the environment. */
export const createFootballDataFromEnv = (env: NodeJS.ProcessEnv = process.env): FootballDataProvider =>
  createFootballDataProvider(readFootballDataConfigFromEnv(env));
