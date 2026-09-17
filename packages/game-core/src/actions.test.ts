import { describe, expect, it } from 'vitest';
import { HOST_ONLY_ACTIONS, isHostOnlyAction, parseClientAction } from './actions.js';
import { asRoomId } from './ids.js';
import { createRoom, DEFAULT_ROOM_SETTINGS, mergeRoomSettings } from './state.js';
import { HOST, T0 } from './harness.test-utils.js';

describe('client action validation', () => {
  it('accepts a well-formed join', () => {
    const result = parseClientAction({
      type: 'PLAYER_JOIN',
      playerId: 'p2',
      nickname: 'Bea',
      isGuest: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action.type).toBe('PLAYER_JOIN');
  });

  it('keeps the opaque payload of a submission and of a game selection', () => {
    const submit = parseClientAction({
      type: 'SUBMIT_ANSWER',
      playerId: 'p2',
      roundId: 'r1',
      payload: { guess: 9 },
    });
    expect(submit.ok).toBe(true);
    if (submit.ok && submit.action.type === 'SUBMIT_ANSWER') {
      expect(submit.action.payload).toEqual({ guess: 9 });
    }

    const select = parseClientAction({
      type: 'SELECT_GAME',
      actorId: 'host',
      moduleId: 'M3',
      config: { answerWindowMs: 9_000 },
    });
    expect(select.ok).toBe(true);
    if (select.ok && select.action.type === 'SELECT_GAME') {
      expect(select.action.config).toEqual({ answerWindowMs: 9_000 });
    }
  });

  it('rejects unknown action types, extra keys and bad field types', () => {
    expect(parseClientAction({ type: 'DROP_TABLES' }).ok).toBe(false);
    expect(parseClientAction({ type: 'START_SESSION', actorId: 'host', sneaky: true }).ok).toBe(false);
    expect(parseClientAction({ type: 'PLAYER_JOIN', playerId: '', nickname: 'x', isGuest: true }).ok).toBe(
      false,
    );
    expect(
      parseClientAction({ type: 'PLAYER_JOIN', playerId: 'p', nickname: 'x'.repeat(40), isGuest: true }).ok,
    ).toBe(false);
  });

  it('refuses the server-only actions a phone must never be able to send', () => {
    expect(parseClientAction({ type: 'MATCH_EVENTS', events: [] }).ok).toBe(false);
    expect(parseClientAction({ type: 'TICK' }).ok).toBe(false);
    expect(
      parseClientAction({ type: 'LOADING_PROGRESS', stepKey: 'fixtures', status: 'done', detail: null }).ok,
    ).toBe(false);
    expect(parseClientAction({ type: 'LOADING_FAILED', reason: 'nope' }).ok).toBe(false);
  });

  it('reports readable issue paths', () => {
    const result = parseClientAction({
      type: 'UPDATE_SETTINGS',
      actorId: 'host',
      patch: { maxPlayers: 900 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(' ')).toContain('maxPlayers');
  });

  it('knows which actions are host-only', () => {
    expect(isHostOnlyAction('START_SESSION')).toBe(true);
    expect(isHostOnlyAction('SUBMIT_ANSWER')).toBe(false);
    expect(HOST_ONLY_ACTIONS).toContain('KICK_PLAYER');
  });
});

describe('room construction', () => {
  it('starts in the lobby with the host as its only player', () => {
    const room = createRoom({
      roomId: asRoomId('room-1'),
      pin: 'ABC123',
      hostPlayerId: HOST,
      hostNickname: 'Host',
      hostIsGuest: false,
      now: T0,
      rngState: 1,
    });
    expect(room.phase).toBe('lobby');
    expect(room.players).toHaveLength(1);
    expect(room.players[0]?.isGuest).toBe(false);
    expect(room.settings).toEqual(DEFAULT_ROOM_SETTINGS);
    expect(room.version).toBe(1);
    expect(room.activeSessionIndex).toBeNull();
  });

  it('applies a settings patch at creation without dropping the defaults', () => {
    const room = createRoom({
      roomId: asRoomId('room-2'),
      pin: 'ZZZ999',
      hostPlayerId: HOST,
      hostNickname: 'Host',
      hostIsGuest: true,
      now: T0,
      rngState: 1,
      settings: { roundsPerSession: 3 },
    });
    expect(room.settings.roundsPerSession).toBe(3);
    expect(room.settings.answerWindowMs).toBe(DEFAULT_ROOM_SETTINGS.answerWindowMs);
  });

  it('merges only the fields present in a patch', () => {
    const merged = mergeRoomSettings(DEFAULT_ROOM_SETTINGS, { maxPlayers: 6 });
    expect(merged.maxPlayers).toBe(6);
    expect(merged.scoring).toBe(DEFAULT_ROOM_SETTINGS.scoring);
    expect(mergeRoomSettings(DEFAULT_ROOM_SETTINGS, {})).toEqual(DEFAULT_ROOM_SETTINGS);
  });
});
