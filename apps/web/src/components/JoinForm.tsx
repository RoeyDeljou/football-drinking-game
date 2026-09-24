'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { fetchRoomByPin } from '@/lib/api';
import { shouldAutoJoinRedirect } from '@/lib/joinGuard';
import { useRoom } from '@/lib/room-context';
import { loadAuth } from '@/lib/storage';
import { Banner, BigButton, Card } from './ui';

export const JoinForm = ({ initialPin = '' }: { readonly initialPin?: string }): React.JSX.Element => {
  const router = useRouter();
  const { joinByPin, self, status } = useRoom();
  const [pin, setPin] = useState(initialPin.toUpperCase());
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // The PIN this form actually intends to join — distinct from whatever room `self` already holds
  // from an earlier session, so a stale resumed room never gets mistaken for the room being joined
  // now. A deep link (`initialPin`) counts as an intent up front; typing + submitting sets it too.
  const [joinTargetPin, setJoinTargetPin] = useState<string | null>(
    initialPin.trim().length === 6 ? initialPin.trim().toUpperCase() : null,
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const auth = loadAuth();
    if (auth !== null) setNickname(auth.displayName);
  }, []);

  useEffect(() => {
    if (shouldAutoJoinRedirect({ targetPin: joinTargetPin, selfPin: self?.pin ?? null, status })) {
      router.push(`/room/${self?.roomId}`);
    }
  }, [self, status, joinTargetPin, router]);

  const onSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    const cleanPin = pin.trim().toUpperCase();
    if (cleanPin.length !== 6) {
      setError('PIN must be 6 characters.');
      return;
    }
    if (nickname.trim().length === 0) {
      setError('Enter a nickname.');
      return;
    }
    setChecking(true);
    const summary = await fetchRoomByPin(cleanPin);
    setChecking(false);
    if (!summary.ok) {
      setError('No room with that PIN. Double-check with the host.');
      return;
    }
    const auth = loadAuth();
    setJoinTargetPin(cleanPin);
    joinByPin(cleanPin, nickname.trim(), auth?.accessToken);
  };

  return (
    <Card>
      <form className="flex flex-col gap-4" onSubmit={(event) => void onSubmit(event)}>
        <label className="flex flex-col gap-1 text-sm font-semibold text-white/70">
          Room PIN
          <input
            value={pin}
            onChange={(event) => setPin(event.target.value.toUpperCase().slice(0, 6))}
            maxLength={6}
            autoCapitalize="characters"
            inputMode="text"
            placeholder="ABC123"
            className="tap-target rounded-xl border border-white/15 bg-white/5 px-4 text-center text-3xl font-black tracking-[0.4em] text-white"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-white/70">
          Nickname
          <input
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            maxLength={24}
            placeholder="Your name at the table"
            className="tap-target rounded-xl border border-white/15 bg-white/5 px-4 text-lg text-white"
          />
        </label>
        {error !== null ? <Banner tone="error">{error}</Banner> : null}
        <BigButton type="submit" disabled={checking || status === 'connecting'}>
          {checking || status === 'connecting' ? 'Joining…' : 'Join room'}
        </BigButton>
      </form>
    </Card>
  );
};
