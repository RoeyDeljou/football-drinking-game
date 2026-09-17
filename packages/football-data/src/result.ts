/**
 * Typed results for every provider call.
 *
 * Providers never throw: a network failure, a rate-limit wall or an unparseable upstream payload all come back as
 * `DataResult` failures with a provider-agnostic `DataError`. Provider internals (fetch errors, Zod issues,
 * RapidAPI status bodies) are summarised into `message` and never leak as objects.
 */

export type DataErrorKind =
  /** Could not reach the upstream service at all. */
  | 'NETWORK'
  /** Upstream refused because the caller is over quota (HTTP 429), or the local rate limiter gave up. */
  | 'RATE_LIMITED'
  /** Upstream answered with a 5xx or an application-level error payload. */
  | 'UPSTREAM'
  /** Upstream answered, but the payload did not match the expected schema. */
  | 'INVALID_RESPONSE'
  /** The request itself was rejected as malformed or unauthorised (4xx other than 429). */
  | 'BAD_REQUEST'
  /** The provider is missing the configuration it needs (e.g. no API key). */
  | 'NOT_CONFIGURED'
  /** The request exceeded its timeout. */
  | 'TIMEOUT';

export interface DataError {
  readonly kind: DataErrorKind;
  /** Human-readable, safe to log. Never contains an API key. */
  readonly message: string;
  /** HTTP status when there was one. */
  readonly status: number | null;
  /** Whether retrying the same call later could plausibly succeed. */
  readonly retryable: boolean;
  /** Number of attempts actually made, including the first. */
  readonly attempts: number;
}

export interface DataOk<T> {
  readonly ok: true;
  readonly value: T;
  /** Non-fatal observations about the payload — partial data, projected lineups, dropped rows. */
  readonly notes: readonly string[];
  /** True when the value came from the TTL cache rather than a fresh upstream call. */
  readonly fromCache: boolean;
}

export interface DataFail {
  readonly ok: false;
  readonly error: DataError;
}

export type DataResult<T> = DataOk<T> | DataFail;

export function ok<T>(value: T, notes: readonly string[] = [], fromCache = false): DataOk<T> {
  return { ok: true, value, notes, fromCache };
}

export function fail(
  kind: DataErrorKind,
  message: string,
  options: { status?: number | null; retryable?: boolean; attempts?: number } = {},
): DataFail {
  const retryable =
    options.retryable ?? (kind === 'NETWORK' || kind === 'RATE_LIMITED' || kind === 'UPSTREAM' || kind === 'TIMEOUT');
  return {
    ok: false,
    error: {
      kind,
      message,
      status: options.status ?? null,
      retryable,
      attempts: options.attempts ?? 1,
    },
  };
}

export function isOk<T>(result: DataResult<T>): result is DataOk<T> {
  return result.ok;
}

export function isFail<T>(result: DataResult<T>): result is DataFail {
  return !result.ok;
}

export function unwrapOr<T>(result: DataResult<T>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** Map an ok value, preserving notes and cache provenance; failures pass through untouched. */
export function mapResult<A, B>(result: DataResult<A>, mapper: (value: A) => B): DataResult<B> {
  return result.ok ? ok(mapper(result.value), result.notes, result.fromCache) : result;
}

/** Add notes to an ok result. Failures pass through untouched. */
export function withNotes<T>(result: DataResult<T>, extra: readonly string[]): DataResult<T> {
  if (!result.ok || extra.length === 0) return result;
  return ok(result.value, [...result.notes, ...extra], result.fromCache);
}

/** Turn an unknown thrown value into a `DataError` message without leaking provider objects. */
export function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message;
  if (typeof thrown === 'string') return thrown;
  return 'unknown error';
}
