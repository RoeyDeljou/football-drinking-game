import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decideInitialSelection } from './initialSelection';
import { clearPendingSelection, loadPendingSelection, savePendingSelection } from './storage';

const base = {
  stored: 'G-MIX',
  isHost: true,
  phase: 'lobby',
  selectionModuleId: null,
  connected: true,
  dispatched: false,
} as const;

describe('decideInitialSelection', () => {
  it('dispatches once for a connected host in a fresh lobby', () => {
    expect(decideInitialSelection(base)).toBe('dispatch');
  });

  it('waits until connected, and never dispatches twice', () => {
    expect(decideInitialSelection({ ...base, connected: false })).toBe('none');
    expect(decideInitialSelection({ ...base, dispatched: true })).toBe('none');
  });

  it('does nothing without a stored choice or for a non-host', () => {
    expect(decideInitialSelection({ ...base, stored: null })).toBe('none');
    expect(decideInitialSelection({ ...base, isHost: false })).toBe('none');
  });

  it('clears a stale choice once the server holds a selection or the lobby is over', () => {
    expect(decideInitialSelection({ ...base, selectionModuleId: 'G-MIX' })).toBe('clear');
    expect(decideInitialSelection({ ...base, phase: 'playing' })).toBe('clear');
  });
});

describe('pending selection storage', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips per room and clears', () => {
    savePendingSelection('room-1', 'G6');
    expect(loadPendingSelection('room-1')).toBe('G6');
    expect(loadPendingSelection('room-2')).toBeNull();
    clearPendingSelection();
    expect(loadPendingSelection('room-1')).toBeNull();
  });

  it('ignores corrupt values', () => {
    store.set('fdg:pending-selection', '{not json');
    expect(loadPendingSelection('room-1')).toBeNull();
  });
});
