// @ts-check
import { builtinModules } from 'node:module';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Platform modules that must never be imported by packages/game-core.
 * This enforces invariant #1 in CLAUDE.md: the engine stays pure TypeScript.
 */
const FORBIDDEN_IN_ENGINE = [
  'fs',
  'node:fs',
  'path',
  'node:path',
  'http',
  'node:http',
  'crypto',
  'node:crypto',
  'react',
  'react-dom',
  'next',
  'socket.io',
  'socket.io-client',
  '@prisma/client',
  'fastify',
];

/** Every Node built-in, bare and `node:`-prefixed (`fs`, `node:fs`, `stream/web`, `worker_threads`, …). */
const NODE_BUILTINS = [
  ...new Set(builtinModules.flatMap((name) => (name.startsWith('node:') ? [name] : [name, `node:${name}`]))),
];

const ENGINE_PURITY_MESSAGE =
  'packages/game-core must stay platform-agnostic. Inject this capability through a port interface instead.';
const ENGINE_DETERMINISM_MESSAGE =
  'packages/game-core must be deterministic: time comes from EngineClock and randomness from the RngSource port.';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      '**/.vitest/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Applies to engine source and its tests alike: neither needs a platform module, a real clock or
    // real randomness (tests drive the injected clock and a seeded RngSource).
    files: ['packages/game-core/**/*.ts'],
    rules: {
      // Replaced by the type-aware variant below, which can allow `import type` per path.
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            ...[...new Set([...FORBIDDEN_IN_ENGINE, ...NODE_BUILTINS])].map((name) => ({
              name,
              message: ENGINE_PURITY_MESSAGE,
            })),
            {
              name: '@fdg/football-data',
              allowTypeImports: true,
              message:
                'game-core may only `import type` from @fdg/football-data; runtime data arrives through RoundDataContext.',
            },
          ],
          patterns: [
            {
              group: [
                'node:*',
                'react',
                'react/*',
                'react-dom',
                'react-dom/*',
                'next',
                'next/*',
                '@prisma/*',
              ],
              message: ENGINE_PURITY_MESSAGE,
            },
            {
              group: ['@fdg/football-data/*'],
              allowTypeImports: true,
              message: 'game-core may only `import type` from @fdg/football-data.',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: ENGINE_DETERMINISM_MESSAGE },
        { object: 'Math', property: 'random', message: ENGINE_DETERMINISM_MESSAGE },
        { object: 'performance', property: 'now', message: ENGINE_DETERMINISM_MESSAGE },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: ENGINE_DETERMINISM_MESSAGE,
        },
        {
          // Blocks globalThis.Date.now(), globalThis.Math.random(), globalThis.setTimeout(...), and
          // every other globalThis.<anything> — a named-global restriction is worthless if the same
          // global is one `globalThis.` away. No legitimate engine code needs this indirection.
          selector: 'MemberExpression[object.name="globalThis"]',
          message: `${ENGINE_PURITY_MESSAGE} (via globalThis)`,
        },
        {
          // Blocks dynamic import(), including import('node:fs') or import('@fdg/football-data') —
          // the static-import restrictions above are worthless if a runtime import can route around
          // them. Engine imports must all be statically analyzable.
          selector: 'ImportExpression',
          message: `${ENGINE_PURITY_MESSAGE} (dynamic import)`,
        },
      ],
      // Blocks eval('require("fs")') and any other eval-based escape from static analysis.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'Engine code must not read the environment; inject configuration.' },
        { name: 'window', message: 'Engine code must not touch the DOM.' },
        { name: 'document', message: 'Engine code must not touch the DOM.' },
        { name: 'fetch', message: 'Engine code must not perform I/O; data arrives via injected ports.' },
        { name: 'setTimeout', message: 'Engine code must not schedule work; the server dispatches TICK.' },
        { name: 'setInterval', message: 'Engine code must not schedule work; the server dispatches TICK.' },
        { name: 'setImmediate', message: 'Engine code must not schedule work; the server dispatches TICK.' },
        {
          name: 'queueMicrotask',
          message: 'Engine code must not schedule work; the server dispatches TICK.',
        },
        { name: 'performance', message: ENGINE_DETERMINISM_MESSAGE },
        { name: 'crypto', message: ENGINE_DETERMINISM_MESSAGE },
        { name: 'globalThis', message: `${ENGINE_PURITY_MESSAGE} (via globalThis)` },
        { name: 'eval', message: 'Engine code must not use eval; it defeats static analysis.' },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/*.config.{js,ts}', 'eslint.config.js'],
    rules: {
      'no-console': 'off',
    },
  },
  prettier,
);
