'use client';

import type { ProjectedRoom } from '@fdg/game-core';
import { useEffect, useState } from 'react';
import { GAME_CATALOG } from '@/games/registry';
import { notConnectedMessage, PICKER_COPY, pendingMessage } from '@/lib/pickerCopy';
import { useRoom } from '@/lib/room-context';
import {
  beginPending,
  pendingPhase,
  resolvePending,
  retryPending,
  type PendingState,
} from '@/lib/selectionPending';
import { useNow } from '@/lib/useNow';
import { Banner, BigButton, Card } from './ui';

export const GamePicker = ({
  room,
  category,
  onSelectGame,
  onStart,
  startLabel,
  startDisabled = false,
}: {
  readonly room: ProjectedRoom;
  readonly category: 'matchday' | 'general' | null;
  /** Sends `SELECT_GAME`. Returns `false` if it could not be sent (no seat / not connected). */
  readonly onSelectGame: (moduleId: string) => boolean;
  readonly onStart: () => void;
  readonly startLabel: string;
  readonly startDisabled?: boolean;
}): React.JSX.Element => {
  const { status, lastError } = useRoom();
  const now = useNow(500);
  const [pending, setPending] = useState<PendingState>(null);
  const [sendFailed, setSendFailed] = useState(false);

  const connected = status === 'connected';

  // Server truth stays authoritative: pending only ever clears because the server confirmed
  // (`room.selection` + a newer version), a room:error arrived, or the socket dropped.
  useEffect(() => {
    setPending((current) =>
      resolvePending(current, {
        selectionModuleId: room.selection?.moduleId ?? null,
        roomVersion: room.version,
        connected,
        errorToken: lastError,
      }),
    );
  }, [room.selection?.moduleId, room.version, connected, lastError]);

  const select = (moduleId: string): void => {
    if (!connected) return;
    const sent = onSelectGame(moduleId);
    setSendFailed(!sent);
    if (!sent) return;
    setPending(beginPending({ moduleId, now: Date.now(), roomVersion: room.version, errorToken: lastError }));
  };

  const retry = (): void => {
    if (pending === null) return;
    const sent = onSelectGame(pending.moduleId);
    setSendFailed(!sent);
    if (sent) setPending(retryPending(pending, { now: Date.now(), roomVersion: room.version, errorToken: lastError }));
  };

  const phase = pendingPhase(pending, now);
  const waitMessage = pendingMessage(phase);
  const games = category === null ? GAME_CATALOG : GAME_CATALOG.filter((game) => game.category === category);
  const connectionHint = notConnectedMessage(status) ?? (sendFailed ? notConnectedMessage('idle') : null);

  return (
    <Card>
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-white/50">Pick a game</h2>
      {connectionHint !== null ? (
        <div className="mb-3">
          <Banner tone="warn">{connectionHint}</Banner>
        </div>
      ) : null}
      <div className="flex flex-col gap-3">
        {games.map((game) => {
          const isPending = pending?.moduleId === game.id;
          const isSelected = pending === null && room.selection?.moduleId === game.id;
          return (
            <button
              key={game.id}
              type="button"
              disabled={!connected}
              aria-busy={isPending}
              onClick={() => select(game.id)}
              className={`tap-target rounded-2xl border-2 px-4 py-3 text-left transition-colors disabled:opacity-50 ${
                isPending
                  ? 'border-amber-400 bg-amber-400/10'
                  : isSelected
                    ? 'border-pitch-500 bg-pitch-500/20'
                    : 'border-white/15 bg-white/5'
              }`}
            >
              <p className="flex items-center gap-2 font-bold">
                {isPending ? (
                  <span
                    className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-amber-400 motion-reduce:animate-none"
                    aria-hidden
                  />
                ) : null}
                {game.name}
              </p>
              <p className="text-xs text-white/50">{isPending ? PICKER_COPY.cardPending : game.blurb}</p>
            </button>
          );
        })}
      </div>

      {waitMessage !== null ? (
        <div className="mt-3" role="status" aria-live="polite">
          <Banner tone={phase === 'stalled' ? 'warn' : 'info'}>{waitMessage}</Banner>
          {phase === 'stalled' ? (
            <BigButton className="mt-2" variant="secondary" onClick={retry}>
              {PICKER_COPY.retry}
            </BigButton>
          ) : null}
        </div>
      ) : null}

      <BigButton className="mt-4" disabled={pending !== null || room.selection === null || startDisabled} onClick={onStart}>
        {pending !== null
          ? PICKER_COPY.buttonPreparing
          : room.selection === null
            ? 'Select a game first'
            : startLabel}
      </BigButton>
    </Card>
  );
};
