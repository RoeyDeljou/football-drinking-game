import { buildApp } from './app.js';
import { loadEnv } from './env.js';

// Defense-in-depth, not the primary fix: every real fire-and-forget call site in this codebase
// (gateway.ts's socket handlers, its tick loop, loading.ts's progress dispatches) must catch its
// own rejections explicitly — see the `guarded` helper in `realtime/gateway.ts`. This handler exists
// only as a backstop so the *next* unguarded one someone adds degrades to "logged and ignored"
// instead of Node's default: an unhandled rejection kills the process. With today's in-memory
// `RoomStore`, killing the process wipes every live room for every player currently in the app —
// so letting that default behavior stand is not an acceptable failure mode here.
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled rejection (see the site that threw it — this is a backstop, not the fix):', reason);
});

const main = async (): Promise<void> => {
  const env = loadEnv();
  const { app } = await buildApp({ env });
  await app.listen({ port: env.PORT, host: env.HOST });
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
