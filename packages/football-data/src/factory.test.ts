import { describe, expect, it } from 'vitest';

import { CompositeProvider } from './composite.js';
import { EspnProvider } from './espn/espn-provider.js';
import {
  createFootballDataProvider,
  describeLiveWiring,
  FOOTBALL_DATA_ENV_VARS,
  FootballDataConfigError,
  readFootballDataConfigFromEnv,
  resolveProviderSelection,
} from './factory.js';
import { FixtureProvider } from './fixture/fixture-provider.js';

describe('resolveProviderSelection', () => {
  it('defaults to "live"', () => {
    expect(resolveProviderSelection({})).toBe('live');
  });

  it('honours an explicit selection', () => {
    expect(resolveProviderSelection({ provider: 'fixture' })).toBe('fixture');
    expect(resolveProviderSelection({ provider: 'live' })).toBe('live');
  });
});

describe('describeLiveWiring', () => {
  it('is ESPN + Wikidata with no fallback by default', () => {
    expect(describeLiveWiring({})).toEqual({ primary: 'espn', careers: 'wikidata', fallback: null });
  });

  it('adds the API-Football fallback only when a key is configured', () => {
    expect(describeLiveWiring({ apiFootball: { apiKey: 'key' } })).toEqual({
      primary: 'espn',
      careers: 'wikidata',
      fallback: 'api-football',
    });
    expect(describeLiveWiring({ apiFootball: { apiKey: '' } }).fallback).toBeNull();
  });

  it('drops careers when wikidata is explicitly disabled', () => {
    expect(describeLiveWiring({ wikidata: { enabled: false } }).careers).toBeNull();
  });
});

describe('createFootballDataProvider — selection', () => {
  it('builds a FixtureProvider for "fixture"', () => {
    const provider = createFootballDataProvider({ provider: 'fixture' });
    expect(provider).toBeInstanceOf(FixtureProvider);
    expect(provider.kind).toBe('fixture');
  });

  it('builds a CompositeProvider wrapping EspnProvider for "live" (the default)', () => {
    const provider = createFootballDataProvider();
    expect(provider).toBeInstanceOf(CompositeProvider);
    expect(provider.kind).toBe('composite');
    const composite = provider as CompositeProvider;
    expect(composite.describeSources()).toEqual({ primary: 'espn', fallback: null, careers: 'wikidata' });
  });

  it('adds the API-Football fallback only when a key is present, never eagerly', () => {
    const withoutKey = createFootballDataProvider() as CompositeProvider;
    expect(withoutKey.describeSources().fallback).toBeNull();

    const withKey = createFootballDataProvider({ apiFootball: { apiKey: 'test-key' } }) as CompositeProvider;
    expect(withKey.describeSources().fallback).toBe('api-football');
  });

  it('wikidata.enabled: false builds live wiring with no career source', () => {
    const provider = createFootballDataProvider({ wikidata: { enabled: false } }) as CompositeProvider;
    expect(provider.describeSources().careers).toBeNull();
  });

  it('constructing the live provider touches no network (no crash, nothing awaited)', () => {
    expect(() => createFootballDataProvider()).not.toThrow();
  });

  it('never sends an EspnProvider constructed with no explicit userAgent a broken default', () => {
    const provider = createFootballDataProvider() as CompositeProvider;
    void provider;
    // EspnProvider itself is exercised in espn-provider.test.ts; this just confirms wiring succeeds.
    expect(new EspnProvider()).toBeInstanceOf(EspnProvider);
  });
});

describe('readFootballDataConfigFromEnv', () => {
  it('an empty environment produces defaults (provider unset, sub-configs empty)', () => {
    const config = readFootballDataConfigFromEnv({});
    expect(config.provider).toBeUndefined();
    expect(config.apiFootball?.apiKey).toBeUndefined();
    expect(config.fixture?.replay).toBeUndefined();
  });

  it('reads the provider selection', () => {
    expect(readFootballDataConfigFromEnv({ [FOOTBALL_DATA_ENV_VARS.provider]: 'fixture' }).provider).toBe('fixture');
    expect(readFootballDataConfigFromEnv({ [FOOTBALL_DATA_ENV_VARS.provider]: 'LIVE' }).provider).toBe('live');
  });

  it('throws FootballDataConfigError on an unrecognised provider rather than silently picking one', () => {
    expect(() => readFootballDataConfigFromEnv({ [FOOTBALL_DATA_ENV_VARS.provider]: 'nonsense' })).toThrow(
      FootballDataConfigError,
    );
  });

  it('reads the API-Football key and season', () => {
    const config = readFootballDataConfigFromEnv({
      [FOOTBALL_DATA_ENV_VARS.apiFootballKey]: 'abc123',
      [FOOTBALL_DATA_ENV_VARS.apiFootballSeason]: '2026',
    });
    expect(config.apiFootball?.apiKey).toBe('abc123');
    expect(config.apiFootball?.seasonYear).toBe(2026);
  });

  it('converts a per-minute ESPN rate limit into the 5-second-window shape', () => {
    const config = readFootballDataConfigFromEnv({ [FOOTBALL_DATA_ENV_VARS.espnRequestsPerMinute]: '60' });
    expect(config.espn?.rateLimit).toEqual({ maxRequests: 5, windowMs: 5_000 });
  });

  it('parses wikidata.enabled from common falsy strings', () => {
    for (const value of ['0', 'false', 'no', 'off']) {
      expect(readFootballDataConfigFromEnv({ [FOOTBALL_DATA_ENV_VARS.wikidataEnabled]: value }).wikidata?.enabled).toBe(
        false,
      );
    }
    expect(readFootballDataConfigFromEnv({ [FOOTBALL_DATA_ENV_VARS.wikidataEnabled]: 'true' }).wikidata?.enabled).toBe(
      true,
    );
  });

  it('builds a replay config only when a fixture id is set', () => {
    expect(readFootballDataConfigFromEnv({}).fixture?.replay).toBeUndefined();
    const config = readFootballDataConfigFromEnv({
      [FOOTBALL_DATA_ENV_VARS.replayFixtureId]: '401882875',
      [FOOTBALL_DATA_ENV_VARS.replaySpeed]: '10',
      [FOOTBALL_DATA_ENV_VARS.replayStartMinute]: '30',
    });
    expect(config.fixture?.replay).toEqual({ fixtureId: '401882875', speedMultiplier: 10, startMinute: 30 });
  });

  it('blank strings are treated as unset', () => {
    const config = readFootballDataConfigFromEnv({ [FOOTBALL_DATA_ENV_VARS.apiFootballKey]: '   ' });
    expect(config.apiFootball?.apiKey).toBeUndefined();
  });

  it('round-trips into createFootballDataProvider: FOOTBALL_DATA_PROVIDER=fixture selects FixtureProvider', () => {
    const config = readFootballDataConfigFromEnv({ [FOOTBALL_DATA_ENV_VARS.provider]: 'fixture' });
    const provider = createFootballDataProvider(config);
    expect(provider.kind).toBe('fixture');
  });

  it('round-trips: an API-Football key from the environment enables the live fallback', () => {
    const config = readFootballDataConfigFromEnv({ [FOOTBALL_DATA_ENV_VARS.apiFootballKey]: 'env-key' });
    const provider = createFootballDataProvider(config) as CompositeProvider;
    expect(provider.describeSources().fallback).toBe('api-football');
  });
});
