import { describe, expect, it } from 'vitest';
import type { CompetitionId, Fixture } from '@fdg/football-data';
import { asCompetitionId, fail, ok } from '@fdg/football-data';
import { createFixtureListCache } from './fixture-list-cache.js';

const competitionId: CompetitionId = asCompetitionId('premier-league');

describe('createFixtureListCache', () => {
  it('serves a second call within the TTL from cache, hitting the loader once', async () => {
    let now = 0;
    let calls = 0;
    const cache = createFixtureListCache({ ttlMs: 1000, now: () => now });
    const load = async () => {
      calls += 1;
      return ok<readonly Fixture[]>([]);
    };

    await cache.get(competitionId, load);
    now += 500;
    await cache.get(competitionId, load);

    expect(calls).toBe(1);
  });

  it('reloads once the TTL has expired', async () => {
    let now = 0;
    let calls = 0;
    const cache = createFixtureListCache({ ttlMs: 1000, now: () => now });
    const load = async () => {
      calls += 1;
      return ok<readonly Fixture[]>([]);
    };

    await cache.get(competitionId, load);
    now += 1001;
    await cache.get(competitionId, load);

    expect(calls).toBe(2);
  });

  it('never caches a failure, so the very next call retries the loader', async () => {
    const now = 0;
    let calls = 0;
    const cache = createFixtureListCache({ ttlMs: 1000, now: () => now });
    const load = async () => {
      calls += 1;
      return fail('UPSTREAM', 'boom');
    };

    const first = await cache.get(competitionId, load);
    const second = await cache.get(competitionId, load);

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(calls).toBe(2);
  });

  it('caches per competition id independently', async () => {
    const now = 0;
    let calls = 0;
    const cache = createFixtureListCache({ ttlMs: 1000, now: () => now });
    const load = async () => {
      calls += 1;
      return ok<readonly Fixture[]>([]);
    };
    const other: CompetitionId = asCompetitionId('la-liga');

    await cache.get(competitionId, load);
    await cache.get(other, load);

    expect(calls).toBe(2);
  });
});
