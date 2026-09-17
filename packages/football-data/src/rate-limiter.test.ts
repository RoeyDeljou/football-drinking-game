import { describe, expect, it } from 'vitest';

import { createManualClock } from './clock.js';
import { RateLimiter, RateLimitQueueFullError } from './rate-limiter.js';

describe('RateLimiter', () => {
  it('queues past the window ceiling and releases as the window rolls forward', async () => {
    const clock = createManualClock();
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 1_000, maxConcurrent: 10 }, clock);

    const started: number[] = [];
    const tasks = [0, 1, 2, 3].map((index) =>
      limiter.schedule(() => {
        started.push(index);
        return Promise.resolve(index);
      }),
    );

    await clock.flush();
    expect(started).toEqual([0, 1]);
    expect(limiter.queueLength).toBe(2);

    // Nothing more can start until the oldest start falls out of the window.
    await clock.advance(999);
    expect(started).toEqual([0, 1]);

    await clock.advance(1);
    expect(started).toEqual([0, 1, 2, 3]);
    expect(limiter.queueLength).toBe(0);
    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2, 3]);
  });

  it('preserves arrival order when releasing queued work', async () => {
    const clock = createManualClock();
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 100, maxConcurrent: 5 }, clock);
    const order: string[] = [];
    const tasks = ['a', 'b', 'c'].map((label) =>
      limiter.schedule(() => {
        order.push(label);
        return Promise.resolve(label);
      }),
    );

    await clock.flush();
    expect(order).toEqual(['a']);
    await clock.advance(100);
    expect(order).toEqual(['a', 'b']);
    await clock.advance(100);
    expect(order).toEqual(['a', 'b', 'c']);
    await Promise.all(tasks);
  });

  it('honours the concurrency limit independently of the window', async () => {
    const clock = createManualClock();
    const limiter = new RateLimiter({ maxRequests: 100, windowMs: 60_000, maxConcurrent: 2 }, clock);

    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const tasks = [0, 1, 2, 3].map(() =>
      limiter.schedule(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
      }),
    );

    await clock.flush();
    expect(peak).toBe(2);
    expect(limiter.activeCount).toBe(2);
    expect(limiter.queueLength).toBe(2);

    while (releases.length > 0) {
      releases.shift()?.();
      await clock.flush();
    }
    await Promise.all(tasks);
    expect(peak).toBe(2);
  });

  it('releases the concurrency slot even when the task rejects', async () => {
    const clock = createManualClock();
    const limiter = new RateLimiter({ maxRequests: 100, windowMs: 60_000, maxConcurrent: 1 }, clock);

    const first = limiter.schedule(() => Promise.reject(new Error('nope')));
    await expect(first).rejects.toThrow('nope');
    await clock.flush();

    await expect(limiter.schedule(() => Promise.resolve('fine'))).resolves.toBe('fine');
    expect(limiter.activeCount).toBe(0);
  });

  it('rejects rather than queueing without bound', async () => {
    const clock = createManualClock();
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 10_000, maxConcurrent: 1, maxQueueDepth: 1 }, clock);

    const running = limiter.schedule(() => new Promise<void>(() => undefined));
    const queued = limiter.schedule(() => Promise.resolve());
    await clock.flush();

    expect(limiter.queueLength).toBe(1);
    await expect(limiter.schedule(() => Promise.resolve())).rejects.toBeInstanceOf(RateLimitQueueFullError);

    void running;
    void queued;
  });

  it('reports scheduling telemetry', async () => {
    const clock = createManualClock();
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 500, maxConcurrent: 4 }, clock);
    const tasks = [limiter.schedule(() => Promise.resolve(1)), limiter.schedule(() => Promise.resolve(2))];
    await clock.flush();
    expect(limiter.stats().scheduled).toBe(2);
    expect(limiter.stats().delayed).toBeGreaterThan(0);
    await clock.advance(500);
    await Promise.all(tasks);
  });
});
