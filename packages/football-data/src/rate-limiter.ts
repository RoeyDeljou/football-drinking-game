/**
 * Sliding-window rate limiter with a bounded queue.
 *
 * API-Football's free tier allows a small number of requests per minute. Rather than discovering that with 429s,
 * we hold the line locally: at most `maxRequests` starts inside any `windowMs`, at most `maxConcurrent` in flight,
 * everything else queued in arrival order.
 *
 * All waiting goes through the injected `DataClock`, so a test can queue four calls, assert two started, advance
 * the clock and assert the other two then ran — with no real time passing.
 */

import type { DataClock } from './clock.js';

export interface RateLimitConfig {
  /** Maximum request starts inside one window. */
  readonly maxRequests: number;
  readonly windowMs: number;
  /** Maximum simultaneous in-flight requests. */
  readonly maxConcurrent: number;
  /** Reject rather than queue past this depth. Default 200. */
  readonly maxQueueDepth?: number | undefined;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 30,
  windowMs: 60_000,
  maxConcurrent: 4,
  maxQueueDepth: 200,
};

/** Thrown only by `schedule` when the queue is full; providers convert it into a `RATE_LIMITED` DataResult. */
export class RateLimitQueueFullError extends Error {
  constructor(depth: number) {
    super(`rate limiter queue is full (${String(depth)} waiting)`);
    this.name = 'RateLimitQueueFullError';
  }
}

interface QueuedTask {
  readonly run: () => void;
}

export class RateLimiter {
  private readonly clock: DataClock;
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxConcurrent: number;
  private readonly maxQueueDepth: number;

  private starts: number[] = [];
  private queue: QueuedTask[] = [];
  private active = 0;
  private waking = false;
  private totalScheduled = 0;
  private totalDelayed = 0;

  constructor(config: RateLimitConfig, clock: DataClock) {
    this.clock = clock;
    this.maxRequests = Math.max(1, config.maxRequests);
    this.windowMs = Math.max(1, config.windowMs);
    this.maxConcurrent = Math.max(1, config.maxConcurrent);
    this.maxQueueDepth = config.maxQueueDepth ?? 200;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get activeCount(): number {
    return this.active;
  }

  stats(): { scheduled: number; delayed: number; queued: number; active: number } {
    return { scheduled: this.totalScheduled, delayed: this.totalDelayed, queued: this.queue.length, active: this.active };
  }

  /** Run `task` as soon as the window and the concurrency limit allow. Preserves arrival order. */
  async schedule<T>(task: () => Promise<T>): Promise<T> {
    this.totalScheduled += 1;
    if (this.queue.length >= this.maxQueueDepth) {
      throw new RateLimitQueueFullError(this.queue.length);
    }

    await new Promise<void>((resolve) => {
      this.queue.push({ run: resolve });
      this.pump();
    });

    // `pump` has already claimed the concurrency slot and recorded the window start for this task.
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.pump();
    }
  }

  /** Release every queued slot the current window allows, then arrange a wake-up for the rest. */
  private pump(): void {
    this.dropExpiredStarts();

    while (this.queue.length > 0 && this.active < this.maxConcurrent && this.starts.length < this.maxRequests) {
      const next = this.queue.shift();
      if (next === undefined) break;
      // Claim both the concurrency slot and the window slot here, so the next loop iteration sees them.
      this.active += 1;
      this.starts.push(this.clock.now());
      next.run();
    }

    if (this.queue.length === 0 || this.waking) return;

    const waitMs = this.msUntilSlot();
    if (waitMs === null) return;

    this.waking = true;
    this.totalDelayed += 1;
    void this.clock.sleep(waitMs).then(() => {
      this.waking = false;
      this.pump();
    });
  }

  private dropExpiredStarts(): void {
    const cutoff = this.clock.now() - this.windowMs;
    this.starts = this.starts.filter((at) => at > cutoff);
  }

  /** How long until a window slot frees up, or null when we are only waiting on concurrency. */
  private msUntilSlot(): number | null {
    if (this.starts.length < this.maxRequests) return null;
    const oldest = this.starts[0];
    if (oldest === undefined) return null;
    return Math.max(1, oldest + this.windowMs - this.clock.now());
  }
}
