import { describe, expect, it } from 'vitest';

import {
  allEspnSlugs,
  COMPETITION_CODES,
  COMPETITION_CONFIGS,
  COMPETITIONS,
  competitionConfigByEspnSlug,
} from './competitions.js';

describe('allEspnSlugs', () => {
  it('returns just the primary slug for a single-slug competition, unchanged from before', () => {
    expect(allEspnSlugs(COMPETITIONS.PREMIER_LEAGUE)).toEqual(['eng.1']);
    expect(allEspnSlugs(COMPETITIONS.CHAMPIONS_LEAGUE)).toEqual(['uefa.champions']);
  });

  it('returns the primary slug plus every additional slug, in order, for National Teams', () => {
    const slugs = allEspnSlugs(COMPETITIONS.NATIONAL_TEAMS);
    expect(slugs[0]).toBe('fifa.friendly');
    expect(slugs).toContain('uefa.nations');
    expect(slugs).toContain('fifa.worldq.uefa');
    expect(slugs).toContain('fifa.worldq.conmebol');
    // No duplicates.
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe('COMPETITION_CODES / COMPETITION_CONFIGS — seven supported competitions', () => {
  it('has exactly seven competitions, Champions League first and National Teams second', () => {
    expect(COMPETITION_CODES).toHaveLength(7);
    expect(COMPETITION_CODES[0]).toBe('CHAMPIONS_LEAGUE');
    expect(COMPETITION_CODES[1]).toBe('NATIONAL_TEAMS');
    expect(COMPETITION_CONFIGS).toHaveLength(7);
  });

  it('National Teams config has the exact shape the task specifies', () => {
    const config = COMPETITIONS.NATIONAL_TEAMS;
    expect(config.code).toBe('NATIONAL_TEAMS');
    expect(config.id).toBe('national-teams');
    expect(config.name).toBe('National Teams');
    expect(config.isCup).toBe(true);
    expect(config.espnAdditionalSlugs?.length).toBeGreaterThan(0);
  });

  it('every competition still has a unique id, code and espnSlug', () => {
    const ids = COMPETITION_CONFIGS.map((entry) => entry.id);
    const codes = COMPETITION_CONFIGS.map((entry) => entry.code);
    expect(new Set(ids).size).toBe(COMPETITION_CONFIGS.length);
    expect(new Set(codes).size).toBe(COMPETITION_CONFIGS.length);
  });
});

describe('competitionConfigByEspnSlug — resolves any of a competition’s slugs, not just the primary', () => {
  it('resolves a domestic league by its one slug, unchanged from before', () => {
    expect(competitionConfigByEspnSlug('eng.1')?.code).toBe('PREMIER_LEAGUE');
  });

  it('resolves National Teams from its primary slug and from an additional slug alike', () => {
    expect(competitionConfigByEspnSlug('fifa.friendly')?.code).toBe('NATIONAL_TEAMS');
    expect(competitionConfigByEspnSlug('uefa.nations')?.code).toBe('NATIONAL_TEAMS');
    expect(competitionConfigByEspnSlug('fifa.worldq.conmebol')?.code).toBe('NATIONAL_TEAMS');
  });

  it('returns null for a slug nothing maps to', () => {
    expect(competitionConfigByEspnSlug('not.a.real.slug')).toBeNull();
  });
});
