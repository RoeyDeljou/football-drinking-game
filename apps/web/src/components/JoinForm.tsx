'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { fetchRoomByPin } from '@/lib/api';
import { markUpcomingNavigationAsReplace } from '@/lib/backNavigation';
import { shouldAutoJoinRedirect } from '@/lib/joinGuard';
import { useRoom } from '@/lib/room-context';
import { Banner, BigButton, Card, Field } from './ui';

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
    if (shouldAutoJoinRedirect({ targetPin: joinTargetPin, selfPin: self?.pin ?? null, status })) {
      // This is a redirect the app is performing once the join completes, not a navigation the user
      // chose to make — it must never be recorded as in-app history (see NavigationTracker /
      // backNavigation.ts), or a browser Back from /room/<id> would bounce back to this join screen
      // and could trap forward history. Matches how the room page's own redirect effect does this.
      markUpcomingNavigationAsReplace();
      router.replace(`/room/${self?.roomId}`);
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
    setJoinTargetPin(cleanPin);
    joinByPin(cleanPin, nickname.trim());
  };

  return (
    <Card>
      <form className="flex flex-col gap-4" onSubmit={(event) => void onSubmit(event)}>
        <Field
          label="Room PIN"
          value={pin}
          onChange={(event) => setPin(event.target.value.toUpperCase().slice(0, 6))}
          maxLength={6}
          autoCapitalize="characters"
          autoComplete="off"
          inputMode="text"
          placeholder="ABC123"
          className="text-center text-3xl font-black tracking-[0.3em] placeholder:tracking-[0.3em]"
        />
        <Field
          label="Nickname"
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          maxLength={24}
          autoComplete="nickname"
          placeholder="Your name at the table"
        />
        {error !== null ? (
          <div role="alert">
            <Banner tone="error">{error}</Banner>
          </div>
        ) : null}
        <BigButton type="submit" disabled={checking || status === 'connecting'}>
          {checking || status === 'connecting' ? 'Joining…' : 'Join room'}
        </BigButton>
      </form>
    </Card>
  );
};
