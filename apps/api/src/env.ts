/**
 * All `process.env` reads for `apps/api` happen here and nowhere else (plus the one bridge into
 * `@fdg/football-data`'s own env reader). Everything downstream receives a typed, validated config
 * object instead of touching `process.env` directly.
 *
 * Secrets (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ROOM_TOKEN_SECRET`) have **no default value**
 * in the schema. In `production` they are required, must be at least 32 characters, and are
 * rejected outright if they match one of the literal strings this file used to ship as a default —
 * so a misconfigured production deployment fails to boot instead of silently trusting a secret an
 * attacker can read straight out of this source file. Only outside production does this module fill
 * in a secret that was left unset, and even then with a fresh random value generated per process
 * boot (`crypto.randomBytes`), never a fixed literal — so `npm run dev`/tests work with zero setup
 * without ever being a real credential anyone could hardcode an exploit against.
 */

import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Every literal this file (or `.env.example`) has ever shipped as a "just for local dev" secret.
 * Kept explicit and separate from the schema defaults (which no longer exist) so pasting one of
 * these into a production `.env` by mistake is still caught.
 */
const KNOWN_INSECURE_SECRETS = new Set([
  'dev-access-secret-change-me-please-32chars',
  'dev-refresh-secret-change-me-please-32chars',
  'dev-room-token-secret-change-me-32chars',
  // .env.example placeholders — also caught by the length check on their own (each is under 32
  // characters), but listed explicitly too: defense in depth against a future .env.example edit
  // that happens to lengthen them past the length floor without anyone noticing they'd then pass.
  'replace-me-access',
  'replace-me-refresh',
  'replace-me-room-token',
  // Earlier (longer) placeholders this file has shipped — kept so an old copied .env is still caught.
  'replace-with-your-own-openssl-rand-hex-32-output-1',
  'replace-with-your-own-openssl-rand-hex-32-output-2',
  'replace-with-your-own-openssl-rand-hex-32-output-3',
]);

const SECRET_KEYS = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'ROOM_TOKEN_SECRET'] as const;
type SecretKey = (typeof SECRET_KEYS)[number];

const rawEnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1).default('postgresql://fdg:fdg@localhost:5432/fdg?schema=public'),

    JWT_ACCESS_SECRET: z.string().min(1).optional(),
    JWT_REFRESH_SECRET: z.string().min(1).optional(),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
    ROOM_TOKEN_SECRET: z.string().min(1).optional(),

    PORT: z.coerce.number().int().positive().default(4000),
    HOST: z.string().min(1).default('0.0.0.0'),
    CORS_ORIGIN: z.string().min(1).default('*'),

    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== 'production') return;
    for (const key of SECRET_KEYS) {
      const secret = value[key];
      if (secret === undefined || secret.length < 32) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} must be set in production, to a random string of at least 32 characters (e.g. \`openssl rand -hex 32\`).`,
        });
        continue;
      }
      if (KNOWN_INSECURE_SECRETS.has(secret)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is set to a known development default. Generate a real secret before deploying to production.`,
        });
      }
    }
    // Explicit CORS allowlist only. `*` in production would let any origin's browser send
    // credentialed requests (refresh-token cookies, room tokens) to this API.
    if (value.CORS_ORIGIN === '*') {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGIN'],
        message:
          'CORS_ORIGIN must be an explicit, comma-separated allowlist in production, never "*".',
      });
    }
  });

export interface AppEnv {
  readonly DATABASE_URL: string;
  readonly JWT_ACCESS_SECRET: string;
  readonly JWT_REFRESH_SECRET: string;
  readonly JWT_ACCESS_TTL_SECONDS: number;
  readonly JWT_REFRESH_TTL_SECONDS: number;
  readonly ROOM_TOKEN_SECRET: string;
  readonly PORT: number;
  readonly HOST: string;
  readonly CORS_ORIGIN: string;
  readonly NODE_ENV: 'development' | 'test' | 'production';
}

/** Only reachable when `NODE_ENV !== 'production'` — `superRefine` above already guarantees every
 * secret is present (and not a known-insecure literal) whenever it is. */
const devFallbackSecret = (): string => randomBytes(32).toString('hex');

export const loadEnv = (source: NodeJS.ProcessEnv = process.env): AppEnv => {
  const parsed = rawEnvSchema.parse(source);
  const isProduction = parsed.NODE_ENV === 'production';

  const resolveSecret = (key: SecretKey): string => {
    const value = parsed[key];
    if (value !== undefined) return value;
    if (isProduction) {
      // Unreachable: superRefine rejects a missing secret in production before we get here.
      throw new Error(`${key} is required in production`);
    }
    return devFallbackSecret();
  };

  return {
    ...parsed,
    JWT_ACCESS_SECRET: resolveSecret('JWT_ACCESS_SECRET'),
    JWT_REFRESH_SECRET: resolveSecret('JWT_REFRESH_SECRET'),
    ROOM_TOKEN_SECRET: resolveSecret('ROOM_TOKEN_SECRET'),
  };
};
