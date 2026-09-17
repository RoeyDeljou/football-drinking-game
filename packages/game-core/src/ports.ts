/**
 * Engine ports. Everything environmental reaches the engine through one of these interfaces,
 * which is what makes a whole session replayable from a seed plus an action log.
 *
 * There is no `Date.now()` and no `Math.random()` anywhere else in this package.
 */

/** Monotonic-enough wall clock, epoch milliseconds. */
export interface EngineClock {
  now(): number;
}

/** Seeded, deterministic randomness. */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [minInclusive, maxInclusive]. Returns `minInclusive` if the range is empty. */
  int(minInclusive: number, maxInclusive: number): number;
  /** One element, or `undefined` when `items` is empty. */
  pick<T>(items: readonly T[]): T | undefined;
  /** Up to `count` distinct elements (fewer if `items` is shorter). */
  sample<T>(items: readonly T[], count: number): readonly T[];
  /** A shuffled copy; the input is never mutated. */
  shuffle<T>(items: readonly T[]): readonly T[];
}

/** A clock frozen at a single instant — the default in tests. */
export const createFixedClock = (fixedNowMs: number): EngineClock => ({
  now: () => fixedNowMs,
});

export interface ControllableClock extends EngineClock {
  set(nowMs: number): void;
  advance(deltaMs: number): void;
}

/** A clock a test (or a replay driver) can move by hand. */
export const createControllableClock = (startMs: number): ControllableClock => {
  let current = startMs;
  return {
    now: () => current,
    set: (nowMs: number) => {
      current = nowMs;
    },
    advance: (deltaMs: number) => {
      current += deltaMs;
    },
  };
};

/** An `Rng` whose whole internal state is one serializable uint32, so it can live in `RoomState`. */
export interface ResumableRng extends Rng {
  /** The current internal state. Feeding it back to `RngSource.fromState` continues the sequence. */
  state(): number;
}

/**
 * The randomness port the reducer consumes. The engine keeps the RNG *state* in `RoomState.rngState`
 * and rebuilds the generator from it on every dispatch, so a room restored from any `RoomStore`
 * (memory, Redis, a hub's own store) continues exactly the same random sequence.
 */
export interface RngSource {
  /** Turn a room seed into the initial state stored in `RoomState.rngState`. */
  initialState(seed: number): number;
  fromState(state: number): ResumableRng;
}

/**
 * mulberry32 — small, fast, well-distributed, and identical on every platform, so a seed
 * reproduces a session byte for byte.
 */
export const createSeededRng = (seed: number): ResumableRng => {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (minInclusive: number, maxInclusive: number): number => {
    if (maxInclusive <= minInclusive) return minInclusive;
    const span = maxInclusive - minInclusive + 1;
    return minInclusive + Math.floor(next() * span);
  };

  const shuffle = <T>(items: readonly T[]): readonly T[] => {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = int(0, i);
      const a = copy[i];
      const b = copy[j];
      if (a === undefined || b === undefined) continue;
      copy[i] = b;
      copy[j] = a;
    }
    return copy;
  };

  return {
    next,
    int,
    pick: <T>(items: readonly T[]): T | undefined =>
      items.length === 0 ? undefined : items[int(0, items.length - 1)],
    sample: <T>(items: readonly T[], count: number): readonly T[] =>
      shuffle(items).slice(0, Math.max(0, Math.min(count, items.length))),
    shuffle,
    state: () => state,
  };
};

/** The default `RngSource`: mulberry32, whose state is its seed. */
export const MULBERRY32: RngSource = {
  initialState: (seed: number): number => seed >>> 0,
  fromState: (state: number): ResumableRng => createSeededRng(state),
};
