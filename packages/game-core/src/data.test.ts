import type { DataQuality } from '@fdg/football-data';
import { describe, expect, it } from 'vitest';
import { checkModulePlayable, DATA_REQUIREMENT_KEYS, EMPTY_DATA_CONTEXT } from './data.js';
import { createDefaultRegistry } from './modules/registry.js';
import { FULL_QUALITY } from './harness.test-utils.js';

const quality = (overrides: Partial<DataQuality> = {}): DataQuality => ({
  ...FULL_QUALITY,
  ...overrides,
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
    expect(registry.listByCategory('matchday').map((module) => module.id)).toEqual(['M1', 'M2', 'M3']);
    expect(registry.listByCategory('general').map((module) => module.id)).toEqual(['G1', 'G6']);
  });
});
