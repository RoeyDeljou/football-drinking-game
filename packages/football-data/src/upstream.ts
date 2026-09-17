/**
 * The shared upstream pipeline for the free JSON sources (ESPN, Wikidata):
 *
 *   TTL cache (+ coalescing)  →  rate limiter  →  HTTP with retry/backoff  →  Zod validation
 *
 * Every request either comes back as validated data or as a typed `DataResult` failure. Nothing throws, and no
 * provider-specific object (fetch error, Zod issue, HTML error page) escapes.
 */

import type { z } from 'zod';

import type { CacheStats } from './cache.js';
import { ResourceCache } from './cache.js';
import type { DataClock } from './clock.js';
import type { HttpClient, HttpOutcome, RetryConfig } from './http.js';
import { requestWithRetry } from './http.js';
import type { RateLimitConfig } from './rate-limiter.js';
import { RateLimiter, RateLimitQueueFullError } from './rate-limiter.js';
import type { DataResult } from './result.js';
import { describeThrown, fail, ok } from './result.js';

export interface UpstreamClientOptions {
  /** Human name used in error messages, e.g. `ESPN`. */
  readonly name: string;
  readonly http: HttpClient;
  readonly clock: DataClock;
  readonly retry: RetryConfig;
  readonly rateLimit: RateLimitConfig;
  readonly timeoutMs: number;
  /** Sent with every request — at minimum a descriptive User-Agent. */
  readonly headers: Readonly<Record<string, string>>;
  readonly maxCacheEntries?: number | undefined;
}

export interface UpstreamTelemetry {
  readonly cache: CacheStats;
  readonly rateLimit: ReturnType<RateLimiter['stats']>;
  /** Requests that actually left the process (retries counted once per logical request). */
  readonly upstreamCalls: number;
}

export class UpstreamClient {
  private readonly options: UpstreamClientOptions;
  private readonly cache: ResourceCache;
  private readonly limiter: RateLimiter;
  private upstreamCalls = 0;

  constructor(options: UpstreamClientOptions) {
    this.options = options;
    this.cache = new ResourceCache({ clock: options.clock, maxEntries: options.maxCacheEntries ?? 1_000 });
    this.limiter = new RateLimiter(options.rateLimit, options.clock);
  }

  telemetry(): UpstreamTelemetry {
    return { cache: this.cache.stats(), rateLimit: this.limiter.stats(), upstreamCalls: this.upstreamCalls };
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** Read a cached value without a request. */
  peek<T>(key: string): T | null {
    return this.cache.peek<T>(key)?.value ?? null;
  }

  /**
   * GET `url` as JSON, cached under `key` for `ttlMs` (or a TTL computed from the parsed value), validated against
   * `schema`. Concurrent identical calls share one request.
   */
  getJson<S extends z.ZodTypeAny>(
    key: string,
    url: string,
    ttlMs: number | ((value: z.infer<S>) => number),
    schema: S,
  ): Promise<DataResult<z.infer<S>>> {
    return this.cache.fetch<z.infer<S>>(key, ttlMs, async () => {
      let outcome: DataResult<HttpOutcome>;
      try {
        outcome = await this.limiter.schedule(() => {
          this.upstreamCalls += 1;
          return requestWithRetry({
            http: this.options.http,
            clock: this.options.clock,
            retry: this.options.retry,
            request: { url, headers: this.options.headers, timeoutMs: this.options.timeoutMs },
          });
        });
      } catch (thrown) {
        if (thrown instanceof RateLimitQueueFullError) {
          return fail('RATE_LIMITED', `${this.options.name}: ${thrown.message}`, { retryable: true });
        }
        return fail('NETWORK', `${this.options.name}: ${describeThrown(thrown)}`, { retryable: true });
      }

      if (!outcome.ok) {
        const { error } = outcome;
        const message =
          error.status === 403
            ? `${this.options.name} refused the request (HTTP 403); its edge blocks some User-Agents — send a ` +
              'descriptive one with a contact URL, e.g. "MyApp/1.0 (+https://example.com)"'
            : `${this.options.name}: ${error.message}`;
        return fail(error.status === 403 ? 'BAD_REQUEST' : error.kind, message, {
          status: error.status,
          retryable: error.retryable,
          attempts: error.attempts,
        });
      }

      const { response, telemetry } = outcome.value;
      const parsed = schema.safeParse(response.body);
      if (!parsed.success) {
        const bodyKind = typeof response.body === 'string' ? ' (body was not JSON)' : '';
        return fail(
          'INVALID_RESPONSE',
          `${this.options.name}: unexpected payload${bodyKind} — ${parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ')}`,
          { status: response.status, retryable: false, attempts: telemetry.attempts },
        );
      }
      const notes =
        telemetry.attempts > 1
          ? [`${this.options.name} request needed ${String(telemetry.attempts)} attempts (backoff applied).`]
          : [];
      return ok(parsed.data as z.infer<S>, notes);
    });
  }
}
