import { describe, expect, it } from 'vitest';

import { cacheKey, ResourceCache } from './cache.js';
import { createManualClock } from './clock.js';
import type { DataResult } from './result.js';
import { fail, ok } from './result.js';

describe('cacheKey', () => {
  it('is stable regardless of parameter order and drops empty values', () => {
    expect(cacheKey('fixtures', { season: 2025, league: 39 })).toBe('fixtures?league=39&season=2025');
    expect(cacheKey('fixtures', { league: 39, season: 2025 })).toBe('fixtures?league=39&season=2025');
    expect(cacheKey('fixtures', { league: 39, team: null, page: undefined })).toBe('fixtures?league=39');
    expect(cacheKey('competitions', {})).toBe('competitions');
  });
});

describe('ResourceCache', () => {
  it('serves a cached value inside the TTL and re-loads after it expires', async () => {
    const clock = createManualClock(1_000);
    const cache = new ResourceCache({ clock });
    let calls = 0;
    const loader = (): Promise<DataResult<number>> => {
      calls += 1;
      return Promise.resolve(ok(calls));
    };

    const first = await cache.fetch('k', 5_000, loader);
    expect(first.ok && first.value).toBe(1);
    expect(first.ok && first.fromCache).toBe(false);

    await clock.advance(4_999);
    const second = await cache.fetch('k', 5_000, loader);
    expect(second.ok && second.value).toBe(1);
    expect(second.ok && second.fromCache).toBe(true);
    expect(calls).toBe(1);

    // The entry expires exactly at storedAt + ttl.
    await clock.advance(1);
    const third = await cache.fetch('k', 5_000, loader);
    expect(third.ok && third.value).toBe(2);
    expect(third.ok && third.fromCache).toBe(false);
    expect(calls).toBe(2);

    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().misses).toBe(2);
  });

  it('preserves the notes recorded with a cached value', async () => {
    const clock = createManualClock();
    const cache = new ResourceCache({ clock });
    const first = await cache.fetch('k', 1_000, () => Promise.resolve(ok(7, ['projected lineup'])));
    expect(first.ok && first.notes).toEqual(['projected lineup']);
    const second = await cache.fetch('k', 1_000, () => Promise.resolve(ok(99)));
    expect(second.ok && second.notes).toEqual(['projected lineup']);
  });

  it('coalesces concurrent identical requests into a single load', async () => {
    const clock = createManualClock();
    const cache = new ResourceCache({ clock });
    let calls = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loader = async (): Promise<DataResult<string>> => {
      calls += 1;
      await gate;
      return ok('value');
    };

    const inflight = [
      cache.fetch('same', 1_000, loader),
      cache.fetch('same', 1_000, loader),
      cache.fetch('same', 1_000, loader),
      cache.fetch('same', 1_000, loader),
    ];
    await clock.flush();
    expect(cache.inFlightCount).toBe(1);

    release?.();
    const results = await Promise.all(inflight);

    expect(calls).toBe(1);
    expect(results.every((result) => result.ok && result.value === 'value')).toBe(true);
    expect(cache.stats().coalesced).toBe(3);
    expect(cache.stats().misses).toBe(1);
  });

  it('does not coalesce different keys', async () => {
    const clock = createManualClock();
    const cache = new ResourceCache({ clock });
    let calls = 0;
    const loader = (): Promise<DataResult<number>> => {
      calls += 1;
      return Promise.resolve(ok(calls));
    };
    await Promise.all([cache.fetch('a', 1_000, loader), cache.fetch('b', 1_000, loader)]);
    expect(calls).toBe(2);
    expect(cache.stats().coalesced).toBe(0);
  });

  it('never caches a failure, so a transient outage is not pinned for the whole TTL', async () => {
    const clock = createManualClock();
    const cache = new ResourceCache({ clock });
    let calls = 0;
    const loader = (): Promise<DataResult<string>> => {
      calls += 1;
      return Promise.resolve(calls === 1 ? fail('UPSTREAM', 'boom', { status: 503 }) : ok('recovered'));
    };

    const first = await cache.fetch('k', 60_000, loader);
    expect(first.ok).toBe(false);

    const second = await cache.fetch('k', 60_000, loader);
    expect(second.ok && second.value).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('invalidates by key and by prefix', async () => {
    const clock = createManualClock();
    const cache = new ResourceCache({ clock });
    await cache.fetch('fixtures?league=39', 60_000, () => Promise.resolve(ok(1)));
    await cache.fetch('fixtures?league=140', 60_000, () => Promise.resolve(ok(2)));
    await cache.fetch('players?league=39', 60_000, () => Promise.resolve(ok(3)));

    cache.invalidate('fixtures?league=39');
    expect(cache.peek('fixtures?league=39')).toBeNull();
    expect(cache.peek('fixtures?league=140')).not.toBeNull();

    cache.invalidatePrefix('fixtures');
    expect(cache.peek('fixtures?league=140')).toBeNull();
    expect(cache.peek('players?league=39')).not.toBeNull();
  });

  it('evicts the oldest entry once maxEntries is exceeded', async () => {
    const clock = createManualClock();
    const cache = new ResourceCache({ clock, maxEntries: 2 });
    await cache.fetch('a', 60_000, () => Promise.resolve(ok('a')));
    await cache.fetch('b', 60_000, () => Promise.resolve(ok('b')));
    await cache.fetch('c', 60_000, () => Promise.resolve(ok('c')));

    expect(cache.peek('a')).toBeNull();
    expect(cache.peek('b')).not.toBeNull();
    expect(cache.peek('c')).not.toBeNull();
    expect(cache.stats().entries).toBe(2);
  });

  it('skips storing when the TTL is zero', async () => {
    const clock = createManualClock();
    const cache = new ResourceCache({ clock });
    let calls = 0;
    const loader = (): Promise<DataResult<number>> => {
      calls += 1;
      return Promise.resolve(ok(calls));
    };
    await cache.fetch('k', 0, loader);
    await cache.fetch('k', 0, loader);
    expect(calls).toBe(2);
  });
});
