'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BigButton, Card } from '@/components/ui';
import { loadAuth, loadRoom, type StoredAuth, type StoredRoom } from '@/lib/storage';

export default function LandingPage(): React.JSX.Element {
  const router = useRouter();
  const [auth, setAuth] = useState<StoredAuth | null>(null);
  const [resumable, setResumable] = useState<StoredRoom | null>(null);

  useEffect(() => {
    setAuth(loadAuth());
    const stored = loadRoom();
    setResumable(stored);
    if (stored !== null) router.prefetch(`/room/${stored.roomId}`);
  }, [router]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-10">
      <div className="text-center">
        <p className="text-sm font-bold uppercase tracking-[0.3em] text-pitch-500">Football Drinking Game</p>
        <h1 className="mt-2 text-4xl font-black leading-tight">Kick off in seconds.</h1>
        <p className="mt-2 text-white/60">Host a room, share a PIN, drink responsibly.</p>
      </div>

      {resumable !== null ? (
        <Card>
          <p className="mb-3 text-sm text-white/70">You have a room in progress.</p>
          <Link href={`/room/${resumable.roomId}`} className="block">
            <BigButton variant="secondary">Rejoin room · PIN {resumable.pin}</BigButton>
          </Link>
        </Card>
      ) : null}

      <div className="flex flex-col gap-4">
        <Link href="/host">
          <BigButton variant="primary">Host a room</BigButton>
        </Link>
        <Link href="/join">
          <BigButton variant="secondary">Join with PIN</BigButton>
        </Link>
        <Link href="/auth">
          <BigButton variant="ghost">{auth === null ? 'Sign in' : `Signed in as ${auth.displayName}`}</BigButton>
        </Link>
        {auth !== null ? (
          <Link href="/friends">
            <BigButton variant="ghost">Friends</BigButton>
          </Link>
        ) : null}
      </div>

      <p className="text-center text-xs text-white/40">18+ only. Drink responsibly.</p>
    </main>
  );
}
