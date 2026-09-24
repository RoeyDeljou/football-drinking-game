'use client';

import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState } from 'react';
import type { ProjectedRoom } from '@fdg/game-core';
import { gameName } from '@/games/registry';
import { Banner, Card, PinBadge } from './ui';
import { GamePicker } from './GamePicker';
import { PlayerList } from './PlayerList';

export const Lobby = ({
  room,
  category,
  isHost,
  onSelectGame,
  onStartLoading,
}: {
  readonly room: ProjectedRoom;
  readonly category: 'matchday' | 'general' | null;
  readonly isHost: boolean;
  readonly onSelectGame: (moduleId: string) => void;
  readonly onStartLoading: () => void;
}): React.JSX.Element => {
  const [joinUrl, setJoinUrl] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') setJoinUrl(`${window.location.origin}/join/${room.pin}`);
  }, [room.pin]);

  const copyLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const canStart = room.players.filter((p) => !p.hasLeft).length >= room.settings.minPlayersToStart;

  return (
    <div className="flex flex-col gap-6">
      <Card className="text-center">
        <p className="mb-2 text-sm font-bold uppercase tracking-wide text-white/50">Room PIN</p>
        <PinBadge pin={room.pin} />
        {joinUrl.length > 0 ? (
          <div className="mt-4 flex flex-col items-center gap-3">
            <div className="rounded-2xl bg-white p-3">
              <QRCodeSVG value={joinUrl} size={140} />
            </div>
            <button
              type="button"
              onClick={() => void copyLink()}
              className="tap-target rounded-xl bg-white/10 px-4 text-sm font-bold text-white"
            >
              {copied ? 'Link copied!' : 'Copy invite link'}
            </button>
          </div>
        ) : null}
      </Card>

      <PlayerList players={room.players} viewerId={room.viewerId} />

      {!canStart ? (
        <Banner tone="warn">Need at least {room.settings.minPlayersToStart} player(s) to start.</Banner>
      ) : null}

      {isHost ? (
        <GamePicker
          room={room}
          category={category}
          onSelectGame={onSelectGame}
          onStart={onStartLoading}
          startLabel={room.selection === null ? 'Start' : `Start ${gameName(room.selection.moduleId)}`}
          startDisabled={!canStart}
        />
      ) : (
        <Banner>
          {room.selection === null
            ? 'Waiting for the host to pick a game…'
            : `Host picked ${gameName(room.selection.moduleId)}. Get ready.`}
        </Banner>
      )}
    </div>
  );
};
