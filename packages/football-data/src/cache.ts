/**
 * TTL cache plus request coalescing — the two halves of "never spend an API call we already spent".
 *
 * - **TTL cache**: per-endpoint expiry, so a fixture list is not re-fetched every time a lobby re-renders.
 * - **Coalescing**: N concurrent callers asking for the same key produce exactly one upstream call and all receive
 *   the same answer. This is what keeps twenty players joining a room at once from becoming twenty API calls.
 *
 * Failures are never cached, so a transient outage does not get pinned for the whole TTL.
 */

import type { DataClock } from './clock.js';
import type { DataResult } from './result.js';

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  /** Calls that joined an already in-flight request instead of starting their own. */
  readonly coalesced: number;
  readonly evictions: number;
  readonly entries: number;
}

export interface TtlCacheOptions {
  readonly clock: DataClock;
  /** Hard cap on retained entries; the oldest-written entry is evicted first. Default 500. */
  readonly maxEntries?: number | undefined;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
  readonly storedAt: number;
  readonly notes: readonly string[];
}

/**
 * Per-endpoint TTLs in milliseconds. Live data is polled often; squads and season stats barely change.
 * Every value here is overridable through provider config, and the live ones are the documented poll intervals.
 */
export interface CacheTtlConfig {
  readonly competitions: number;
  readonly fixtures: number;
  readonly fixture: number;
  readonly lineups: number;
  readonly squad: number;
  readonly seasonStats: number;
  readonly playerProfile: number;
  readonly liveMatch: number;
  readonly matchEvents: number;
}

export const DEFAULT_CACHE_TTL: CacheTtlConfig = {
  competitions: 24 * 60 * 60 * 1000,
  fixtures: 10 * 60 * 1000,
  fixture: 60 * 1000,
  lineups: 5 * 60 * 1000,
  squad: 12 * 60 * 60 * 1000,
  seasonStats: 6 * 60 * 60 * 1000,
  playerProfile: 24 * 60 * 60 * 1000,
  liveMatch: 15 * 1000,
  matchEvents: 15 * 1000,
};

export class ResourceCache {
  private readonly clock: DataClock;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<DataResult<unknown>>>();

  private hits = 0;
  private misses = 0;
  private coalesced = 0;
  private evictions = 0;

  constructor(options: TtlCacheOptions) {
    this.clock = options.clock;
    this.maxEntries = options.maxEntries ?? 500;
  }

  /**
   * Return a cached value if it is still fresh, otherwise run `loader` exactly once for this key even if several
   * callers arrive together. Only successful results are stored. `ttlMs` may be a function of the loaded value, so a
   * finished match can be cached for hours while a live one expires in seconds.
   */
  async fetch<T>(
    key: string,
    ttlMs: number | ((value: T) => number),
    loader: () => Promise<DataResult<T>>,
  ): Promise<DataResult<T>> {
    const cached = this.peek<T>(key);
    if (cached !== null) {
      this.hits += 1;
      return { ok: true, value: cached.value, notes: cached.notes, fromCache: true };
    }

    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      this.coalesced += 1;
      return (await existing) as DataResult<T>;
    }

    this.misses += 1;
    const pending = (async (): Promise<DataResult<unknown>> => {
      const result = await loader();
      if (result.ok) {
        const ttl = typeof ttlMs === 'function' ? ttlMs(result.value) : ttlMs;
        if (ttl > 0) this.store(key, result.value, ttl, result.notes);
      }
      return result;
    })();

    this.inFlight.set(key, pending);
    try {
      return (await pending) as DataResult<T>;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Read without loading. Returns null when absent or expired (expired entries are dropped). */
  peek<T>(key: string): { value: T; notes: readonly string[] } | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= this.clock.now()) {
      this.entries.delete(key);
      this.evictions += 1;
      return null;
    }
    return { value: entry.value as T, notes: entry.notes };
  }

  set<T>(key: string, value: T, ttlMs: number, notes: readonly string[] = []): void {
    this.store(key, value, ttlMs, notes);
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  /** Drop every entry whose key starts with `prefix` — used to flush one endpoint family. */
  invalidatePrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      coalesced: this.coalesced,
      evictions: this.evictions,
      entries: this.entries.size,
    };
  }

  private store(key: string, value: unknown, ttlMs: number, notes: readonly string[]): void {
    const now = this.clock.now();
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + ttlMs, storedAt: now, notes });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
  }
}

/** Build a stable cache key from an endpoint name and its parameters. */
export function cacheKey(endpoint: string, params: Readonly<Record<string, string | number | null | undefined>>): string {
  const parts = Object.keys(params)
    .sort()
    .filter((name) => params[name] !== null && params[name] !== undefined)
    .map((name) => `${name}=${String(params[name])}`);
  return parts.length === 0 ? endpoint : `${endpoint}?${parts.join('&')}`;
}
