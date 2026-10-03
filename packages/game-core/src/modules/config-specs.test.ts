import { describe, expect, it } from 'vitest';
import { asGameModuleId } from '../ids.js';
import { GAME_CONFIG_SPECS, gameConfigSpecFor } from './config-specs.js';
import { createDefaultRegistry } from './registry.js';

const registry = createDefaultRegistry();
const specs = Object.values(GAME_CONFIG_SPECS).flatMap((spec) => (spec === undefined ? [] : [spec]));

const parses = (moduleId: string, config: unknown): boolean =>
  registry.get(asGameModuleId(moduleId))?.parseConfig(config).ok === true;

describe('GAME_CONFIG_SPECS', () => {
  it('covers exactly the customisable games, each a registered module with valid defaults', () => {
    expect(Object.keys(GAME_CONFIG_SPECS).sort()).toEqual(['M1', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9']);
    for (const spec of specs) {
      const module = registry.get(spec.moduleId);
      expect(module?.defaultConfig).toBe(spec.defaults);
      expect(parses(spec.moduleId, spec.defaults)).toBe(true);
      expect(new Set(spec.fields.map((field) => field.key)).size).toBe(spec.fields.length);
      for (const field of spec.fields) {
        // Required fields exist in the defaults; optional ones are absent (default mode).
        expect(field.key in spec.defaults).toBe(!field.optional);
      }
    }
    expect(gameConfigSpecFor(asGameModuleId('M6'))?.moduleId).toBe('M6');
    expect(gameConfigSpecFor(asGameModuleId('G1'))).toBeNull();
  });

  it('is plain JSON', () => {
    expect(JSON.parse(JSON.stringify(GAME_CONFIG_SPECS))).toEqual(GAME_CONFIG_SPECS);
  });

  it('pins every limit to the module schema', () => {
    for (const spec of specs) {
      const withValue = (key: string, value: unknown) => ({ ...spec.defaults, [key]: value });
      for (const field of spec.fields) {
        const ok = (value: unknown) => parses(spec.moduleId, withValue(field.key, value));
        switch (field.type) {
          case 'integer':
            // housePerCard needs house cells to be meaningful; probe it with enough of them.
            if (field.key === 'housePerCard') {
              const houseCells = Array.from({ length: 16 }, (_, index) => `h${index}`);
              const at = (value: number) => parses(spec.moduleId, { ...spec.defaults, size: 4, houseCells, housePerCard: value });
              expect([at(field.min), at(field.max), at(field.min - 1), at(field.max + 1)]).toEqual([true, true, false, false]);
              break;
            }
            expect([ok(field.min), ok(field.max), ok(field.min - 1), ok(field.max + 1), ok(field.min + 0.5)]).toEqual([
              true,
              true,
              false,
              false,
              false,
            ]);
            break;
          case 'boolean':
            expect([ok(true), ok(false), ok('yes')]).toEqual([true, true, false]);
            break;
          case 'choice':
            for (const option of field.options) expect(ok(option)).toBe(true);
            expect(ok('__nope__')).toBe(false);
            break;
          case 'multiChoice':
            expect(ok([...field.options])).toBe(true);
            expect(ok(field.options.slice(0, field.minItems))).toBe(true);
            expect(ok([])).toBe(field.minItems === 0);
            expect(ok([field.options[0], field.options[0]])).toBe(false);
            expect(ok(['__nope__'])).toBe(false);
            break;
          case 'labelOverrides': {
            const all = Object.fromEntries(field.options.map((option) => [option, 'y'.repeat(field.maxLength)]));
            expect(ok(all)).toBe(true);
            expect(ok({ [field.options[0] ?? '']: 'y'.repeat(field.maxLength + 1) })).toBe(false);
            expect(ok({ __nope__: 'x' })).toBe(false);
            break;
          }
          case 'textList': {
            const list = (count: number, length = 3) => Array.from({ length: count }, (_, index) => `${index}`.padEnd(length, 'z'));
            expect(ok(list(field.maxItems))).toBe(true);
            expect(ok(list(field.maxItems + 1))).toBe(false);
            expect(ok(list(field.minItems - 1))).toBe(false);
            expect(ok(list(1, field.maxLength))).toBe(true);
            expect(ok(list(1, field.maxLength + 1))).toBe(false);
            break;
          }
          case 'bingoCellPool': {
            const cell = (count: number, label?: string) => ({ event: 'FOUL', side: null, count, ...(label === undefined ? {} : { label }) });
            const pool = (size: number) => Array.from({ length: size }, (_, index) => cell((index % 10) + 1)).map((entry, index) => ({ ...entry, side: index < 10 ? null : index < 20 ? 'home' : 'away' }));
            expect(ok(pool(9))).toBe(true);
            expect(ok(pool(30))).toBe(true);
            expect(ok([cell(1, 'x'.repeat(field.labelMaxLength)), ...pool(9).slice(1)])).toBe(true);
            expect(ok([cell(1, 'x'.repeat(field.labelMaxLength + 1)), ...pool(9).slice(1)])).toBe(false);
            expect(ok(pool(field.minItems - 1))).toBe(false);
            expect(field.maxItems).toBeGreaterThanOrEqual(30);
            break;
          }
        }
      }
    }
  });
});
