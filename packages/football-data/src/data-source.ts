/**
 * Where the recorded JSON comes from.
 *
 * The `FixtureProvider` reads its dataset through this port rather than touching the filesystem directly, so the
 * same provider works from `packages/football-data/data/` on a server, from a bundle in the browser, or from
 * objects handed in by a test. `createNodeDataSource()` is the default and the only place this package reads files.
 */

export interface DataSource {
  /** A label for error messages, e.g. the directory being read. */
  readonly description: string;
  /** Resolve a document by relative path (`'premier-league.json'`, `'timelines/x.json'`). Returns raw parsed JSON. */
  read(relativePath: string): Promise<unknown>;
  /** Whether the document exists. Used to make optional files (timelines) genuinely optional. */
  exists(relativePath: string): Promise<boolean>;
}

/** Serve a dataset from objects already in memory. Used by tests and by bundlers that inline the JSON. */
export function createInMemoryDataSource(
  documents: Readonly<Record<string, unknown>>,
  description = 'in-memory dataset',
): DataSource {
  return {
    description,
    read: (relativePath: string): Promise<unknown> => {
      if (!Object.prototype.hasOwnProperty.call(documents, relativePath)) {
        return Promise.reject(new Error(`document not found in ${description}: ${relativePath}`));
      }
      return Promise.resolve(documents[relativePath]);
    },
    exists: (relativePath: string): Promise<boolean> =>
      Promise.resolve(Object.prototype.hasOwnProperty.call(documents, relativePath)),
  };
}
