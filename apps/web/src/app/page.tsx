'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BigButton, Card } from '@/components/ui';
import { loadRoom, type StoredRoom } from '@/lib/storage';

export default function LandingPage(): React.JSX.Element {
  const router = useRouter();
  const [resumable, setResumable] = useState<StoredRoom | null>(null);

  useEffect(() => {
    const stored = loadRoom();
    setResumable(stored);
    if (stored !== null) router.prefetch(`/room/${stored.roomId}`);
  }, [router]);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-10">
      <div className="text-center">
        <p className="t-eyebrow text-accent">Football Drinking Game</p>
        <h1 className="t-score mt-3">Kick off in seconds.</h1>
        <p className="t-body mt-3 text-fg-muted">Host a room, share a PIN, drink responsibly.</p>
      </div>

      {resumable !== null ? (
        <Card>
          <p className="chalknote mb-3">You have a room in progress.</p>
          <Link href={`/room/${resumable.roomId}`} className="block">
            <BigButton variant="secondary">Rejoin room · PIN {resumable.pin}</BigButton>
          </Link>
        </Card>
      ) : null}

      <div className="flex flex-col gap-3">
        <Link href="/host">
          <BigButton variant="primary">Host a room</BigButton>
        </Link>
        <Link href="/join">
          <BigButton variant="secondary">Join with PIN</BigButton>
        </Link>
      </div>

      <p className="t-xs text-center text-fg-subtle">18+ only. Drink responsibly.</p>
    </main>
  );
}
