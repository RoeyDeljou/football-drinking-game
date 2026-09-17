import { describe, expect, it } from 'vitest';
import { createControllableClock, createFixedClock, createSeededRng } from './ports.js';

describe('EngineClock', () => {
  it('a fixed clock never moves', () => {
    const clock = createFixedClock(123);
    expect(clock.now()).toBe(123);
    expect(clock.now()).toBe(123);
  });

  it('a controllable clock can be set and advanced', () => {
    const clock = createControllableClock(1_000);
    clock.advance(500);
    expect(clock.now()).toBe(1_500);
    clock.set(42);
    expect(clock.now()).toBe(42);
  });
});

describe('Rng', () => {
  it('is fully determined by its seed', () => {
    const a = createSeededRng(7);
    const b = createSeededRng(7);
    const drawA = [a.next(), a.int(1, 100), a.shuffle([1, 2, 3, 4, 5])];
    const drawB = [b.next(), b.int(1, 100), b.shuffle([1, 2, 3, 4, 5])];
    expect(drawA).toEqual(drawB);
  });

  it('produces different streams for different seeds', () => {
    expect(createSeededRng(1).next()).not.toBe(createSeededRng(2).next());
  });

  it('keeps next() inside [0, 1)', () => {
    const rng = createSeededRng(99);
    for (let i = 0; i < 500; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('keeps int() inside the requested range and handles degenerate ranges', () => {
    const rng = createSeededRng(5);
    for (let i = 0; i < 200; i += 1) {
      const value = rng.int(3, 6);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(6);
    }
    expect(rng.int(4, 4)).toBe(4);
    expect(rng.int(9, 2)).toBe(9);
  });

  it('picks nothing from an empty list', () => {
    expect(createSeededRng(1).pick([])).toBeUndefined();
  });

  it('samples distinct elements and never more than exist', () => {
    const rng = createSeededRng(11);
    const sample = rng.sample([1, 2, 3, 4], 10);
    expect(sample).toHaveLength(4);
    expect(new Set(sample).size).toBe(4);
    expect(rng.sample([1, 2, 3], -1)).toHaveLength(0);
  });

  it('shuffles without mutating the input and keeps every element', () => {
    const rng = createSeededRng(3);
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = rng.shuffle(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(input);
  });
});
