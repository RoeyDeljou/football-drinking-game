/**
 * How the server reaches the general-games dataset (`GeneralDataset`: players, season stats,
 * profiles, leaderboards for the top-5 leagues + UCL).
 *
 * What actually happens (this replaces an older claim that it was "built once at startup" — nothing
 * did that): `createGeneralDatasetLoader` builds the dataset lazily on first use, from live provider
 * calls that are rate-limited to roughly one request per second, i.e. tens of seconds. Every
 * dispatch for a room with a general selection awaits it inside that room's dispatch queue, so on a
 * cold process the first SELECT_GAME sat silent for ~36s. Two things fix that:
 *
 *  1. `startGeneralDatasetWarmup` kicks the build off in the background right after the server is
 *     listening (never delaying `listen()`/`/health`, never throwing), with one delayed retry.
 *  2. Failures are not sticky *and* not repeated at full price: a failed build serves an empty
 *     dataset for a short cool-down (so every dispatch in that window returns immediately instead of
 *     each re-running a ~36s build), then the next call retries the real load. The underlying loader
 *     never caches a failure and coalesces concurrent callers onto one in-flight build.
 */

import type { GeneralDataset, GeneralDatasetLoader } from '@fdg/football-data';
import { EMPTY_DATA_QUALITY } from '@fdg/football-data';

export const emptyGeneralDataset = (): GeneralDataset => ({
  builtAt: new Date(0).toISOString(),
  competitions: [],
  teams: [],
  players: [],
  seasonStats: [],
  profiles: [],
  leaderboards: [],
  guessableStats: [],
  quality: EMPTY_DATA_QUALITY,
  gameAvailability: [],
  playersById: new Map(),
  statsByPlayer: new Map(),
  profilesByPlayer: new Map(),
  guessableStatsByPlayer: new Map(),
});

export interface GeneralDatasetAccess {
  /** What `AppContext.generalDataset` is: the real dataset, or an empty one during a failure cool-down. */
  get(): Promise<GeneralDataset>;
  /** Attempt the real load now (ignoring any cool-down). Resolves true on success; never throws. */
  warm(): Promise<boolean>;
  /** Where the most recent successful load came from (a stored snapshot vs a live build) and how old the data is. */
  lastLoad(): GeneralDatasetLoadInfo | null;
}

export interface GeneralDatasetLoadInfo {
  readonly source: 'snapshot' | 'live build';
  readonly ageMs: number;
}

export interface GeneralDatasetAccessOptions {
  readonly cooldownMs?: number;
  readonly now?: () => number;
  readonly log?: (message: string, error?: unknown) => void;
}

export const DEFAULT_FAILURE_COOLDOWN_MS = 30_000;

export const createGeneralDatasetAccess = (
  loader: GeneralDatasetLoader,
  options: GeneralDatasetAccessOptions = {},
): GeneralDatasetAccess => {
  const cooldownMs = options.cooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message, error) => console.error(message, error ?? ''));
  const fallback = emptyGeneralDataset();
  let failedAt: number | null = null;
  // What the loader held when we last recorded a successful load, and where it came from. The loader's own
  // `fromCache` flag is true for ANY in-memory hit (including one that was live-built earlier), so it cannot
  // be used alone: 'snapshot' is claimed only when the dataset was first loaded into an empty loader and came
  // from the store. If the loader later swaps its dataset (a refresh), the source becomes 'live build'.
  let recorded: { dataset: GeneralDataset; source: 'snapshot' | 'live build' } | null = null;

  const attempt = async (): Promise<GeneralDataset | null> => {
    try {
      const wasEmpty = loader.peek() === null;
      const result = await loader.load();
      if (result.ok) {
        failedAt = null;
        if (recorded === null || recorded.dataset !== result.value) {
          recorded = {
            dataset: result.value,
            source: wasEmpty && result.fromCache ? 'snapshot' : 'live build',
          };
        }
        return result.value;
      }
      log(`[general-dataset] load failed: ${result.error.message}`);
    } catch (error) {
      log('[general-dataset] load threw:', error);
    }
    failedAt = now();
    return null;
  };

  return {
    get: async () => {
      const cached = loader.peek();
      if (cached !== null) return cached;
      if (failedAt !== null && now() - failedAt < cooldownMs) return fallback;
      return (await attempt()) ?? fallback;
    },
    warm: async () => (await attempt()) !== null,
    lastLoad: () => {
      if (recorded === null) return null;
      const current = loader.peek();
      if (current !== null && current !== recorded.dataset)
        recorded = { dataset: current, source: 'live build' };
      const builtAt = Date.parse(recorded.dataset.builtAt);
      return {
        source: recorded.source,
        ageMs: Number.isNaN(builtAt) ? 0 : Math.max(0, now() - builtAt),
      };
    },
  };
};

const formatAge = (ageMs: number): string => {
  const minutes = Math.round(ageMs / 60_000);
  return minutes < 90 ? `${minutes}m` : `${(ageMs / 3_600_000).toFixed(1)}h`;
};

export interface WarmupOptions {
  /** Delay before the single retry after a failed warm-up. */
  readonly retryDelayMs?: number;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
}

export interface WarmupHandle {
  /** Resolves when the first attempt (and, if it failed, the retry) has finished. Never rejects. */
  readonly done: Promise<void>;
  /** Cancel a pending retry (used on shutdown). */
  cancel(): void;
}

/**
 * Fire-and-forget warm-up. Returns immediately; safe to call right after `listen()`.
 */
export const startGeneralDatasetWarmup = (
  access: Pick<GeneralDatasetAccess, 'warm'> & Partial<Pick<GeneralDatasetAccess, 'lastLoad'>>,
  options: WarmupOptions = {},
): WarmupHandle => {
  const retryDelayMs = options.retryDelayMs ?? 45_000;
  const log = options.log ?? ((message) => console.warn(message));
  const now = options.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;
  let cancelled = false;

  const run = async (label: string): Promise<boolean> => {
    const started = now();
    try {
      const ok = await access.warm();
      const took = now() - started;
      if (ok) {
        const info = access.lastLoad?.() ?? null;
        const detail = info === null ? '' : `, source: ${info.source}, data age: ${formatAge(info.ageMs)}`;
        log(`[warmup] general dataset ready (${label}) in ${took}ms${detail}`);
      } else log(`[warmup] general dataset warm-up failed (${label}) after ${took}ms`);
      return ok;
    } catch (error) {
      log(`[warmup] general dataset warm-up threw (${label}): ${String(error)}`);
      return false;
    }
  };

  const done = (async (): Promise<void> => {
    if (await run('attempt 1')) return;
    if (cancelled) return;
    log(`[warmup] retrying once in ${retryDelayMs}ms`);
    await new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, retryDelayMs);
      timer.unref?.();
    });
    timer = null;
    if (cancelled) return;
    await run('retry');
  })().catch((error: unknown) => {
    log(`[warmup] unexpected error: ${String(error)}`);
  });

  return {
    done,
    cancel: () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      wake?.();
    },
  };
};
