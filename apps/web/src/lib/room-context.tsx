'use client';

/**
 * One socket connection, owned above the router so it survives client-side navigation between
 * `/host`, `/join`, and `/room/[roomId]`. Persists the reconnect token so a dropped connection or a
 * full page refresh resumes the same seat instead of dead-ending the player (CLAUDE.md: "no dead
 * ends"). The UI never computes game rules here — this module only relays `ProjectedRoom` and lets
 * screens send `room:action` payloads verbatim.
 */

import type { ProjectedRoom } from '@fdg/game-core';
import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_BASE_URL } from './config';
import { FATAL_CONNECT_ERROR_CODES, isTerminalRoomPhase } from './roomLifecycle';
import { clearRoom, loadRoom, saveRoom, type StoredRoom } from './storage';

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'fatal';

interface RoomJoinedPayload {
  readonly roomId: string;
  readonly pin: string;
  readonly playerId: string;
  readonly isHost: boolean;
  readonly roomToken: string;
}

interface RoomErrorPayload {
  readonly code: string;
  readonly detail: string | null;
  readonly submissionCode?: string;
}

interface RoomContextValue {
  readonly status: ConnectionStatus;
  readonly room: ProjectedRoom | null;
  readonly self: StoredRoom | null;
  readonly lastError: RoomErrorPayload | null;
  readonly joinByPin: (pin: string, nickname: string, accessToken?: string) => void;
  readonly resume: (stored: StoredRoom) => void;
  readonly adopt: (payload: { roomId: string; pin: string; playerId: string; roomToken: string; isHost: boolean }) => void;
  readonly send: (action: Record<string, unknown>) => void;
  readonly leaveRoom: () => void;
  readonly clearError: () => void;
}

const RoomContext = createContext<RoomContextValue | null>(null);

export const RoomProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const socketRef = useRef<Socket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [room, setRoom] = useState<ProjectedRoom | null>(null);
  const [self, setSelf] = useState<StoredRoom | null>(null);
  const [lastError, setLastError] = useState<RoomErrorPayload | null>(null);
  // An error banner (e.g. a late-answer rejection) belongs to the round/phase it happened in — it
  // must not silently persist across the next meaningful transition and read like a fresh error.
  const lastTransitionKeyRef = useRef<string | null>(null);

  const teardown = useCallback(() => {
    socketRef.current?.removeAllListeners();
    socketRef.current?.disconnect();
    socketRef.current = null;
  }, []);

  const connect = useCallback(
    (auth: Record<string, unknown>, previousSelf: StoredRoom | null) => {
      teardown();
      setStatus('connecting');
      setLastError(null);
      const socket = io(API_BASE_URL, {
        auth,
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 800,
        reconnectionDelayMax: 5_000,
      });
      socketRef.current = socket;

      let sawInitialConnect = false;

      socket.on('connect', () => {
        setStatus('connected');
      });

      socket.on('room:joined', (payload: RoomJoinedPayload) => {
        sawInitialConnect = true;
        const stored: StoredRoom = {
          roomId: payload.roomId,
          pin: payload.pin,
          playerId: payload.playerId,
          roomToken: payload.roomToken,
          isHost: payload.isHost,
        };
        setSelf(stored);
        saveRoom(stored);
        setStatus('connected');
      });

      socket.on('room:state', (payload: ProjectedRoom) => {
        setRoom(payload);
        const transitionKey = `${payload.phase}:${payload.round?.id ?? ''}:${payload.round?.status ?? ''}`;
        if (lastTransitionKeyRef.current !== null && lastTransitionKeyRef.current !== transitionKey) {
          setLastError(null);
        }
        lastTransitionKeyRef.current = transitionKey;
        // Once a room is over for good, stop offering to rejoin it — otherwise the landing page's
        // "Rejoin room" button is a dead end into a room that will only ever reject with
        // ROOM_TERMINAL (see FATAL_CONNECT_ERROR_CODES).
        if (isTerminalRoomPhase(payload.phase)) clearRoom();
      });

      socket.on('room:error', (payload: RoomErrorPayload) => {
        setLastError(payload);
      });

      socket.on('disconnect', () => {
        setStatus((current) => (current === 'fatal' ? current : 'reconnecting'));
      });

      socket.on('connect_error', (err: Error) => {
        if (FATAL_CONNECT_ERROR_CODES.has(err.message) && !sawInitialConnect) {
          setStatus('fatal');
          setLastError({ code: err.message, detail: null });
          if (previousSelf !== null) clearRoom();
          teardown();
          return;
        }
        setStatus('reconnecting');
      });
    },
    [teardown],
  );

  const joinByPin = useCallback(
    (pin: string, nickname: string, accessToken?: string) => {
      const auth =
        accessToken === undefined
          ? { mode: 'guest', pin, nickname }
          : { mode: 'user', pin, accessToken, nickname };
      connect(auth, null);
    },
    [connect],
  );

  const resume = useCallback(
    (stored: StoredRoom) => {
      setSelf(stored);
      connect({ mode: 'reconnect', roomToken: stored.roomToken }, stored);
    },
    [connect],
  );

  const adopt = useCallback(
    (payload: { roomId: string; pin: string; playerId: string; roomToken: string; isHost: boolean }) => {
      const stored: StoredRoom = { ...payload };
      saveRoom(stored);
      resume(stored);
    },
    [resume],
  );

  const send = useCallback((action: Record<string, unknown>) => {
    socketRef.current?.emit('room:action', action);
  }, []);

  const leaveRoom = useCallback(() => {
    socketRef.current?.emit('room:leave');
    teardown();
    clearRoom();
    setSelf(null);
    setRoom(null);
    setStatus('idle');
  }, [teardown]);

  const clearError = useCallback(() => setLastError(null), []);

  // Resume automatically after a full page reload, if a room was in progress.
  useEffect(() => {
    if (socketRef.current !== null) return;
    const stored = loadRoom();
    if (stored !== null) resume(stored);
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const value = useMemo<RoomContextValue>(
    () => ({ status, room, self, lastError, joinByPin, resume, adopt, send, leaveRoom, clearError }),
    [status, room, self, lastError, joinByPin, resume, adopt, send, leaveRoom, clearError],
  );

  return <RoomContext.Provider value={value}>{children}</RoomContext.Provider>;
};

export const useRoom = (): RoomContextValue => {
  const ctx = useContext(RoomContext);
  if (ctx === null) throw new Error('useRoom must be used inside RoomProvider');
  return ctx;
};
