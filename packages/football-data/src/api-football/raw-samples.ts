/**
 * Loader for the recorded raw API-Football payloads in `data/raw-samples/`.
 *
 * Used by the adapter tests and by anyone wiring a mock `HttpClient`: the samples are the real upstream envelope
 * shape, so a fake client that serves them exercises exactly the same Zod validation and normalization path a live
 * request would.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultDataDir } from '../node-data-source.js';

export type RawSampleName =
  | 'fixtures'
  | 'fixtures-partial'
  | 'lineups'
  | 'lineups-incomplete'
  | 'events'
  | 'statistics'
  | 'fixture-players'
  | 'squads'
  | 'players'
  | 'transfers'
  | 'error-envelope';

export function rawSamplesDir(): string {
  return join(defaultDataDir(), 'raw-samples');
}

/** Read one recorded raw envelope. Returns `unknown` on purpose: callers must validate it. */
export function loadRawSample(name: RawSampleName): unknown {
  const text = readFileSync(join(rawSamplesDir(), `${name}.json`), 'utf8');
  return JSON.parse(text) as unknown;
}
