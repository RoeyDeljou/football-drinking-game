/**
 * Node filesystem `DataSource`. The only module in this package that imports `node:fs`.
 *
 * Kept in its own file so a browser bundle can import everything else without pulling in Node built-ins — point
 * `FixtureProvider` at `createInMemoryDataSource()` instead and this module is never loaded.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DataSource } from './data-source.js';

/**
 * Absolute path of the packaged `data/` directory.
 * Resolves the same from `src/` under Vitest and from `dist/` after a build.
 */
export function defaultDataDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'data');
}

export function createNodeDataSource(dataDir: string = defaultDataDir()): DataSource {
  const root = isAbsolute(dataDir) ? dataDir : resolve(process.cwd(), dataDir);
  return {
    description: root,
    read: async (relativePath: string): Promise<unknown> => {
      const full = join(root, relativePath);
      const text = await readFile(full, 'utf8');
      return JSON.parse(text) as unknown;
    },
    exists: (relativePath: string): Promise<boolean> => Promise.resolve(existsSync(join(root, relativePath))),
  };
}
