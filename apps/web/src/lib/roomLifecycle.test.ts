import { describe, expect, it } from 'vitest';
import { FATAL_CONNECT_ERROR_CODES, isTerminalRoomPhase, TERMINAL_ROOM_PHASES } from './roomLifecycle';

describe('FATAL_CONNECT_ERROR_CODES', () => {
  it('treats ROOM_TERMINAL as fatal, so reconnecting to an ended room stops retrying and shows the escape hatch', () => {
    expect(FATAL_CONNECT_ERROR_CODES.has('ROOM_TERMINAL')).toBe(true);
  });

  it('still treats the other known-unrecoverable codes as fatal', () => {
    for (const code of ['ROOM_NOT_FOUND', 'INVALID_ROOM_TOKEN', 'INVALID_AUTH', 'UNAUTHENTICATED', 'PLAYER_KICKED']) {
      expect(FATAL_CONNECT_ERROR_CODES.has(code)).toBe(true);
    }
  });

  it('does not treat a merely transient disconnect as fatal', () => {
    expect(FATAL_CONNECT_ERROR_CODES.has('transport close')).toBe(false);
  });
});

describe('isTerminalRoomPhase / TERMINAL_ROOM_PHASES', () => {
  it('marks finished and aborted rooms as terminal, so their stored session gets cleared', () => {
    expect(isTerminalRoomPhase('finished')).toBe(true);
    expect(isTerminalRoomPhase('aborted')).toBe(true);
    expect(TERMINAL_ROOM_PHASES.has('finished')).toBe(true);
    expect(TERMINAL_ROOM_PHASES.has('aborted')).toBe(true);
  });

  it('does not mark a still-live room as terminal', () => {
    for (const phase of ['lobby', 'loading', 'playing', 'roundReveal', 'intermission']) {
      expect(isTerminalRoomPhase(phase)).toBe(false);
    }
  });
});
