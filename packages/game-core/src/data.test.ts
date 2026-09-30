import type { DataQuality } from '@fdg/football-data';
import { describe, expect, it } from 'vitest';
import { checkModulePlayable, DATA_REQUIREMENT_KEYS, EMPTY_DATA_CONTEXT } from './data.js';
import { createDefaultRegistry } from './modules/registry.js';
import { FULL_QUALITY } from './harness.test-utils.js';

const quality = (overrides: Partial<DataQuality> = {}): DataQuality => ({
  ...FULL_QUALITY,
  ...overrides,
});

describe('checkModulePlayable with dataRequirementsAnyOf', () => {
  const mixedLike = {
    dataRequirements: ['hasLineups'] as const,
    dataRequirementsAnyOf: [['hasLineups', 'hasPlayerSeasonStats'], ['hasLineups', 'hasShirtNumbers']] as const,
  };

  it('is playable when the base and at least one alternative are met', () => {
    expect(checkModulePlayable(mixedLike, quality({ hasShirtNumbers: false })).playable).toBe(true);
    expect(checkModulePlayable(mixedLike, quality({ hasPlayerSeasonStats: false })).playable).toBe(true);
  });

  it('is not playable when no alternative is met, and reports the closest one', () => {
    const result = checkModulePlayable(
      { dataRequirements: [], dataRequirementsAnyOf: [['hasCareerHistory', 'hasMarketValues'], ['hasPlayerSeasonStats']] },
      quality({ hasCareerHistory: false, hasMarketValues: false, hasPlayerSeasonStats: false }),
    );
    expect(result).toMatchObject({ playable: false, code: 'MISSING_DATA', missing: ['hasPlayerSeasonStats'] });
  });

  it('combines base gaps with the closest alternative, without duplicates', () => {
    const result = checkModulePlayable(mixedLike, quality({ hasLineups: false, hasShirtNumbers: false }));
    expect(result.playable).toBe(false);
    expect(result.missing).toEqual(['hasLineups']);
  });

  it('refuses when quality is unknown and an alternative has requirements', () => {
    const result = checkModulePlayable({ dataRequirements: [], dataRequirementsAnyOf: [['hasCareerHistory']] }, null);
    expect(result).toMatchObject({ playable: false, code: 'UNKNOWN_DATA_QUALITY', missing: ['hasCareerHistory'] });
  });

  it('treats an empty alternative as always met, and an empty list as no extra condition', () => {
    expect(checkModulePlayable({ dataRequirements: [], dataRequirementsAnyOf: [['hasLineups'], []] }, null).playable).toBe(true);
    expect(checkModulePlayable({ dataRequirements: [], dataRequirementsAnyOf: [] }, null).playable).toBe(true);
  });
});

describe('checkModulePlayable', () => {
  it('always allows a module with no requirements, even with no report', () => {
    expect(checkModulePlayable({ dataRequirements: [] }, null)).toEqual({
      playable: true,
      code: 'OK',
      missing: [],
      notes: [],
    });
  });

  it('refuses a module with requirements when data quality is unknown', () => {
    const result = checkModulePlayable({ dataRequirements: ['hasLineups'] }, null);
    expect(result.playable).toBe(false);
    expect(result.code).toBe('UNKNOWN_DATA_QUALITY');
    expect(result.missing).toEqual(['hasLineups']);
  });

  it('lists exactly the missing capabilities', () => {
    const result = checkModulePlayable(
      { dataRequirements: ['hasLineups', 'hasShirtNumbers', 'hasLiveEvents'] },
      quality({ hasShirtNumbers: false, hasLiveEvents: false }),
    );
    expect(result.playable).toBe(false);
    expect(result.code).toBe('MISSING_DATA');
    expect(result.missing).toEqual(['hasShirtNumbers', 'hasLiveEvents']);
  });

  it('passes the provider notes through for the host UI', () => {
    const result = checkModulePlayable(
      { dataRequirements: ['hasLineups'] },
      quality({ hasLineups: false, notes: ['lineups publish one hour before kickoff'] }),
    );
    expect(result.notes).toEqual(['lineups publish one hour before kickoff']);
  });

  it('covers every boolean flag of DataQuality', () => {
    const flags = Object.keys(FULL_QUALITY).filter((key) => key !== 'notes');
    expect([...DATA_REQUIREMENT_KEYS].sort()).toEqual(flags.sort());
  });
});

describe('registry playability', () => {
  it('reports every module with its reason, matchday games first-class', () => {
    const registry = createDefaultRegistry();
    const rows = registry.listPlayability(quality({ hasLiveEvents: false }));
    const m1 = rows.find((row) => row.module.id === 'M1');
    const g6 = rows.find((row) => row.module.id === 'G6');
    expect(m1?.playability.playable).toBe(false);
    expect(m1?.playability.missing).toEqual(['hasLiveEvents']);
    expect(g6?.playability.playable).toBe(true);
  });

  it('greys out every matchday game when there is no data at all', () => {
    const registry = createDefaultRegistry();
    const rows = registry.listPlayability(EMPTY_DATA_CONTEXT.quality);
    expect(rows.filter((row) => row.playability.playable)).toHaveLength(0);
  });

  it('splits the catalog by category', () => {
    const registry = createDefaultRegistry();
    expect(registry.listByCategory('matchday').map((module) => module.id)).toEqual(['M-MIX', 'M1', 'M2', 'M3', 'M5', 'M6', 'M7', 'M10']);
    expect(registry.listByCategory('general').map((module) => module.id)).toEqual(['G-MIX', 'G1', 'G3', 'G6']);
  });
});
