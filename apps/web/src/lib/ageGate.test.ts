import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `ageGate.ts` reads/writes through `lib/storage.ts`, which gates every operation behind
 * `typeof window === 'undefined'`. There is no DOM in this suite's `node` test environment, so we
 * stand up a minimal `window.localStorage` fake for the duration of these tests — this exercises the
 * real `storage.ts` read/write path rather than mocking it away, mirroring the pattern used for the
 * (now-removed) signed-in session persistence tests.
 */
const memory = new Map<string, string>();
const localStorageFake: Storage = {
  get length() {
    return memory.size;
  },
  clear: () => memory.clear(),
  getItem: (key: string) => memory.get(key) ?? null,
  key: (index: number) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key: string) => {
    memory.delete(key);
  },
  setItem: (key: string, value: string) => {
    memory.set(key, value);
  },
};
vi.stubGlobal('window', { localStorage: localStorageFake });

import { ageGateBlocksAction, confirmAgeGate, isAgeGateConfirmed } from './ageGate';

describe('ageGateBlocksAction', () => {
  it('blocks when not confirmed', () => {
    expect(ageGateBlocksAction(false)).toBe(true);
  });

  it('does not block once confirmed', () => {
    expect(ageGateBlocksAction(true)).toBe(false);
  });
});

describe('the age gate, persisted via storage.ts', () => {
  beforeEach(() => {
    memory.clear();
  });

  it('is not confirmed by default, blocking host/join', () => {
    expect(isAgeGateConfirmed()).toBe(false);
    expect(ageGateBlocksAction(isAgeGateConfirmed())).toBe(true);
  });

  it('confirming once persists and does not re-prompt', () => {
    expect(isAgeGateConfirmed()).toBe(false);
    confirmAgeGate();
    expect(isAgeGateConfirmed()).toBe(true);
    // A second read (e.g. a second visit to /host or /join in the same browser session) must not
    // see a fresh, unconfirmed state.
    expect(isAgeGateConfirmed()).toBe(true);
  });

  it('confirmed state survives a reload (a fresh read from storage, not an in-memory flag)', () => {
    confirmAgeGate();
    // Simulate a full page reload: nothing in this module keeps its own in-memory cache, so a
    // brand-new read must still see the value that was persisted to `localStorage`.
    expect(isAgeGateConfirmed()).toBe(true);
  });

  it('confirming never throws even when storage writes are blocked (private browsing, cookies off)', () => {
    const originalSetItem = localStorageFake.setItem;
    localStorageFake.setItem = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    try {
      expect(() => confirmAgeGate()).not.toThrow();
    } finally {
      localStorageFake.setItem = originalSetItem;
    }
  });
});
