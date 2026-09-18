/**
 * Regression for the QA-reported login timing oracle: `login` used to return almost immediately for
 * an unknown email (no argon2 call at all) but pay a real `argon2.verify` cost for a known one — a
 * measured ~5x gap an attacker can use to enumerate registered emails without ever guessing a
 * password. `LocalIdentityProvider.login` now runs `argon2.verify` against a fixed dummy hash on the
 * miss path too, so both cases pay comparable cost.
 *
 * Timing assertions are inherently noisy, so this uses a generous ratio (not a tight bound) and
 * several iterations to average out jitter — the goal is to catch a *5x-class* regression, not to
 * assert perfect constant-time behaviour.
 */

import { describe, expect, it } from 'vitest';
import type { TestServer } from './helpers.js';
import { jsonFetch, startTestServer } from './helpers.js';

const timeLogin = async (server: TestServer, email: string, password: string): Promise<number> => {
  const start = process.hrtime.bigint();
  await jsonFetch(`${server.baseUrl}/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  const end = process.hrtime.bigint();
  return Number(end - start) / 1_000_000; // ms
};

describe('login timing oracle regression', () => {
  it('an unknown email takes comparable time to a known email with a wrong password', async () => {
    const server = await startTestServer();
    try {
      await jsonFetch(`${server.baseUrl}/auth/register`, {
        method: 'POST',
        body: JSON.stringify({
          email: 'timing-known@example.com',
          password: 'correct-horse-battery-staple',
          displayName: 'Known User',
          ageConfirmed18: true,
        }),
      });

      const iterations = 5;
      let knownTotal = 0;
      let unknownTotal = 0;
      for (let i = 0; i < iterations; i += 1) {
        knownTotal += await timeLogin(server, 'timing-known@example.com', 'wrong-password');
        unknownTotal += await timeLogin(server, `timing-unknown-${i}@example.com`, 'wrong-password');
      }
      const knownAvg = knownTotal / iterations;
      const unknownAvg = unknownTotal / iterations;

      // Before the fix this ratio was ~0.2 (unknown ~5x faster). A real fix keeps it close to 1;
      // this asserts it is at least in the same order of magnitude, generously.
      expect(unknownAvg).toBeGreaterThan(knownAvg * 0.4);
    } finally {
      await server.stop();
    }
  }, 60_000);
});
