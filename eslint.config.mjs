// @ts-check
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
    files: ['packages/game-core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: FORBIDDEN_IN_ENGINE.map((name) => ({
            name,
            message:
              'packages/game-core must stay platform-agnostic. Inject this capability through a port interface instead.',
          })),
          patterns: [
            {
              group: ['node:*', 'react*', 'next/*', '@prisma/*'],
              message:
                'packages/game-core must stay platform-agnostic. Inject this capability through a port interface instead.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'Engine code must not read the environment; inject configuration.' },
        { name: 'window', message: 'Engine code must not touch the DOM.' },
        { name: 'document', message: 'Engine code must not touch the DOM.' },
        { name: 'fetch', message: 'Engine code must not perform I/O; data arrives via injected ports.' },
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
