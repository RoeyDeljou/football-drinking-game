'use client';

import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState } from 'react';
import type { ProjectedRoom } from '@fdg/game-core';
import { choiceLabel } from '@/lib/gameMode';
import { Banner, Card, Eyebrow, PinBadge } from './ui';
import { GamePicker } from './GamePicker';
import { PlayerList } from './PlayerList';

export const Lobby = ({
  room,
  category,
  isHost,
  onSelectGame,
  onStartLoading,
  autoSelectModuleId = null,
  onAutoSelectSettled,
}: {
  readonly room: ProjectedRoom;
  readonly category: 'matchday' | 'general' | null;
  readonly isHost: boolean;
  readonly onSelectGame: (moduleId: string) => boolean;
  readonly onStartLoading: () => void;
  /** The game the host chose on /host, dispatched once when connected (host only). */
  readonly autoSelectModuleId?: string | null;
  readonly onAutoSelectSettled?: () => void;
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
    <div className="flex flex-col gap-4">
      <Card className="text-center">
        <Eyebrow className="mb-2">Room PIN</Eyebrow>
        <PinBadge pin={room.pin} />
        {joinUrl.length > 0 ? (
          <div className="mt-4 flex flex-col items-center gap-3">
            <div className="rounded-md bg-fg p-3">
              <QRCodeSVG value={joinUrl} size={140} />
            </div>
            <button
              type="button"
              onClick={() => void copyLink()}
              className="tap-target pressable rounded-md border-2 border-border-strong px-5 text-sm font-bold"
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
          startLabel={room.selection === null ? 'Start' : `Start ${choiceLabel(room.selection.moduleId)}`}
          startDisabled={!canStart}
          autoSelectModuleId={autoSelectModuleId}
          onAutoSelectSettled={onAutoSelectSettled}
          collapsible
        />
      ) : (
        <Banner>
          {room.selection === null
            ? 'Waiting for the host to pick a game…'
            : `Host picked ${choiceLabel(room.selection.moduleId)}. Get ready.`}
        </Banner>
      )}
    </div>
  );
};
