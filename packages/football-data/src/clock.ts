/**
 * The time port for the data layer.
 *
 * Everything time-dependent — cache TTLs, the rate-limit window, retry backoff, the match replay clock — reads
 * `now()` and waits through `sleep()`. Tests inject `createManualClock()` so nothing in this package ever waits on
 * a real timer, and a whole matchday can be replayed instantly.
 */

export interface DataClock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** Resolve after `ms` of this clock's time. */
  sleep(ms: number): Promise<void>;
}

export const systemDataClock: DataClock = {
  now: () => Date.now(),
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, ms));
    }),
};

export interface ManualClock extends DataClock {
  /** Jump forward, resolving every sleep that falls inside the interval in timestamp order. */
  advance(ms: number): Promise<void>;
  /** Jump to an absolute timestamp. Never moves backwards. */
  advanceTo(timestamp: number): Promise<void>;
  /** Let pending microtasks settle without moving time. */
  flush(): Promise<void>;
  /** How many sleeps are still outstanding. */
  readonly pending: number;
}

interface PendingSleep {
  readonly at: number;
  readonly seq: number;
  readonly resolve: () => void;
}

const settleMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
};

/**
 * A fully controlled clock. `sleep()` never touches a real timer; it only resolves when `advance()` passes its
 * deadline, which is what makes rate-limit and backoff tests deterministic.
 */
export function createManualClock(startAt = 0): ManualClock {
  let current = startAt;
  let sequence = 0;
  let sleeps: PendingSleep[] = [];

  const flush = async (): Promise<void> => {
    await settleMicrotasks();
  };

  const advanceTo = async (timestamp: number): Promise<void> => {
    const target = Math.max(current, timestamp);
    // Let anything already in flight register its sleep before we decide what falls inside the interval.
    await flush();
    for (;;) {
      let next: PendingSleep | undefined;
      for (const candidate of sleeps) {
        if (candidate.at > target) continue;
        if (next === undefined || candidate.at < next.at || (candidate.at === next.at && candidate.seq < next.seq)) {
          next = candidate;
        }
      }
      if (next === undefined) break;
      const chosen = next;
      sleeps = sleeps.filter((entry) => entry !== chosen);
      current = Math.max(current, chosen.at);
      chosen.resolve();
      await flush();
    }
    current = target;
    await flush();
  };

  return {
    now: () => current,
    sleep: (ms: number) => {
      if (ms <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        sequence += 1;
        sleeps.push({ at: current + ms, seq: sequence, resolve });
      });
    },
    advance: (ms: number) => advanceTo(current + ms),
    advanceTo,
    flush,
    get pending(): number {
      return sleeps.length;
    },
  };
}
