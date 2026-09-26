import type { BuildAppOptions, BuiltApp } from './app.js';
import { buildApp } from './app.js';
import type { WarmupHandle, WarmupOptions } from './engine/general-dataset-access.js';
import { startGeneralDatasetWarmup } from './engine/general-dataset-access.js';
import type { AppEnv } from './env.js';

export interface BootOptions extends BuildAppOptions {
  readonly port: number;
  readonly host: string;
  readonly warmup?: WarmupOptions;
}

export interface BootedApp extends BuiltApp {
  readonly warmup: WarmupHandle;
}

/**
 * Build, listen, and only *then* start the general-dataset warm-up in the background, so a cold
 * process is already loading the dataset before the first player picks a game, without ever
 * delaying `listen()` or `/health`. The warm-up never throws out of here (see
 * `startGeneralDatasetWarmup`).
 */
export const bootServer = async (env: AppEnv, options: BootOptions): Promise<BootedApp> => {
  const built = await buildApp({ ...options, env });
  await built.app.listen({ port: options.port, host: options.host });
  const warmup = startGeneralDatasetWarmup(built.generalDatasetAccess, options.warmup);
  return {
    ...built,
    warmup,
    close: async () => {
      warmup.cancel();
      await built.close();
    },
  };
};
