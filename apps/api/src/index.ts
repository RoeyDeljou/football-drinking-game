import { buildApp } from './app.js';
import { loadEnv } from './env.js';

const main = async (): Promise<void> => {
  const env = loadEnv();
  const { app } = await buildApp({ env });
  await app.listen({ port: env.PORT, host: env.HOST });
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
