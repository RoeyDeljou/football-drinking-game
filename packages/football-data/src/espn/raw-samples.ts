/**
 * Loader for the real recorded raw ESPN payloads in `data/raw-samples/espn/`.
 *
 * Fetched once (2026-09-16) with a descriptive User-Agent and saved verbatim — see
 * `data/raw-samples/espn/README.md`. Used by `normalize.test.ts` so the adapter's normalizers are exercised
 * against genuine upstream shapes with no network.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultDataDir } from '../node-data-source.js';

export type EspnRawSampleName =
  | 'scoreboard-esp.1'
  | 'summary-finished-psg-slovan'
  | 'summary-live-atm-osasuna'
  | 'teams-eng.1'
  | 'roster-mancity';

export function espnRawSamplesDir(): string {
  return join(defaultDataDir(), 'raw-samples', 'espn');
}

/** Read one recorded raw ESPN payload. Returns `unknown` on purpose: callers must validate it. */
export function loadEspnRawSample(name: EspnRawSampleName): unknown {
  const text = readFileSync(join(espnRawSamplesDir(), `${name}.json`), 'utf8');
  return JSON.parse(text) as unknown;
}
