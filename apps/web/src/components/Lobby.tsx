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
  setupScope = null,
  onAutoSelectSettled,
}: {
  readonly room: ProjectedRoom;
  readonly category: 'matchday' | 'general' | null;
  readonly isHost: boolean;
  readonly onSelectGame: (moduleId: string) => boolean;
  readonly onStartLoading: () => void;
  /** The game the host chose on /host, dispatched once when connected (host only). */
  readonly autoSelectModuleId?: string | null;
  /** The host's chosen scope for the setup summary, e.g. 'Premier League' or 'Arsenal vs Chelsea'. */
  readonly setupScope?: string | null;
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
    // Phones: one column (PIN, players, picker). Landscape phones / tablets / laptops / TV: the PIN + QR
    // (the thing everyone at the table needs to see) get their own large column, players + setup + Start
    // sit beside it.
    // Single column until 1024px (so the PIN can be big on a tablet); two columns only while each keeps >=18rem, so large OS text stacks them instead of cramping.
    <div className="mx-auto flex w-full flex-col gap-4 lg:flex-row lg:flex-wrap lg:items-start lg:gap-8 land:flex-row land:flex-wrap land:items-start land:gap-4">
      <Card className="text-center lg:min-w-[18rem] lg:flex-[5_1_18rem] land:min-w-[18rem] land:flex-[5_1_18rem] lg:p-8">
        <Eyebrow className="mb-2 lg:mb-4">Room PIN</Eyebrow>
        <PinBadge pin={room.pin} size="hero" />
        {joinUrl.length > 0 ? (
          <div className="mt-4 flex flex-col items-center gap-3 lg:mt-6 lg:gap-5">
            <div className="w-[min(100%,9rem)] rounded-md bg-fg p-3 sm:w-[min(100%,10rem)] md:w-[min(100%,14rem)] lg:w-[min(100%,20rem)] lg:p-4">
              <QRCodeSVG value={joinUrl} size={256} style={{ display: 'block', width: '100%', height: 'auto' }} />
            </div>
            <p className="t-sm hidden text-fg-muted lg:block">Scan to join, or go to the link and enter the PIN.</p>
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

      <div className="flex min-w-0 flex-col gap-4 lg:min-w-[18rem] lg:flex-[6_1_18rem] land:min-w-[18rem] land:flex-[6_1_18rem]">
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
            setupScope={setupScope}
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
    </div>
  );
};
