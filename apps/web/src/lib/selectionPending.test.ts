import { describe, expect, it } from 'vitest';
import {
  beginPending,
  pendingPhase,
  resolvePending,
  retryPending,
  SLOW_AFTER_MS,
  STALLED_AFTER_MS,
} from './selectionPending';

const click = (moduleId: string, now = 1_000, roomVersion = 5, errorToken: unknown = null) =>
  beginPending({ moduleId, now, roomVersion, errorToken });

const observe = (over: Partial<Parameters<typeof resolvePending>[1]> = {}) => ({
  selectionModuleId: null,
  roomVersion: 5,
  connected: true,
  errorToken: null,
  ...over,
});

describe('selection pending state machine', () => {
  it('a click makes that card pending', () => {
    const pending = click('G6');
    expect(pending.moduleId).toBe('G6');
    expect(pendingPhase(pending, 1_000)).toBe('pending');
    expect(resolvePending(pending, observe())).toBe(pending);
  });

  it('server confirmation clears it', () => {
    const pending = click('G6');
    expect(resolvePending(pending, observe({ selectionModuleId: 'G6', roomVersion: 6 }))).toBeNull();
  });

  it('does not treat a stale, older selection as confirmation (intermission: previous game still selected)', () => {
    const pending = click('G6');
    expect(resolvePending(pending, observe({ selectionModuleId: 'G1', roomVersion: 6 }))).toBe(pending);
  });

  it('re-selecting the already-selected game is only confirmed by a newer room version', () => {
    const pending = click('G1');
    expect(resolvePending(pending, observe({ selectionModuleId: 'G1', roomVersion: 5 }))).toBe(pending);
    expect(resolvePending(pending, observe({ selectionModuleId: 'G1', roomVersion: 6 }))).toBeNull();
  });

  it('a new room:error clears it, an error that was already showing at click time does not', () => {
    const oldError = { code: 'X' };
    const pending = click('G6', 1_000, 5, oldError);
    expect(resolvePending(pending, observe({ errorToken: oldError }))).toBe(pending);
    expect(resolvePending(pending, observe({ errorToken: { code: 'Y' } }))).toBeNull();
    expect(resolvePending(click('G6'), observe({ errorToken: { code: 'Y' } }))).toBeNull();
  });

  it('a disconnect clears it', () => {
    expect(resolvePending(click('G6'), observe({ connected: false }))).toBeNull();
  });

  it('last click wins', () => {
    const first = click('G1', 1_000);
    const second = click('G6', 5_000);
    expect(second.moduleId).toBe('G6');
    expect(resolvePending(second, observe({ selectionModuleId: 'G1', roomVersion: 6 }))).toBe(second);
    expect(first.moduleId).toBe('G1');
  });

  it('reports slow and stalled thresholds from an injected clock', () => {
    const pending = click('G6', 1_000);
    expect(pendingPhase(pending, 1_000 + SLOW_AFTER_MS - 1)).toBe('pending');
    expect(pendingPhase(pending, 1_000 + SLOW_AFTER_MS)).toBe('slow');
    expect(pendingPhase(pending, 1_000 + STALLED_AFTER_MS - 1)).toBe('slow');
    expect(pendingPhase(pending, 1_000 + STALLED_AFTER_MS)).toBe('stalled');
    expect(pendingPhase(null, 1_000)).toBe('idle');
  });

  it('retry re-targets the same module and restarts the clock', () => {
    const pending = click('G6', 1_000);
    const retried = retryPending(pending, { now: 100_000, roomVersion: 5, errorToken: null });
    expect(retried.moduleId).toBe('G6');
    expect(pendingPhase(retried, 100_000)).toBe('pending');
  });
});
