'use client';

/**
 * Blocks the host and join flows behind a one-time 18+ / responsible-drinking confirmation. Wrap the
 * page content that leads to `createRoom`/`joinByPin` in this — see `app/host/page.tsx`,
 * `app/join/page.tsx`, and `app/join/[pin]/page.tsx` (the last of these is how a QR code or shared
 * link lands a guest directly in the join flow without ever visiting the landing page, so gating
 * only there would leave a hole). Reused, not duplicated, copy: `RESPONSIBLE_DRINKING_NOTICE` from
 * `lib/drinkCopy.ts`. Persistence and the block/allow decision live in `lib/ageGate.ts`.
 */

import { useEffect, useState } from 'react';
import { RESPONSIBLE_DRINKING_NOTICE } from '@/lib/drinkCopy';
import { ageGateBlocksAction, confirmAgeGate, isAgeGateConfirmed } from '@/lib/ageGate';
import { Banner, BigButton, Card } from './ui';

export const AgeGateGuard = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
  // `null` = not checked yet (avoids a flash of the gate on every navigation for an already-confirmed
  // browser, since `localStorage` can only be read after mount).
  const [confirmed, setConfirmed] = useState<boolean | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    setConfirmed(isAgeGateConfirmed());
  }, []);

  if (confirmed === null) return <div className="min-h-dvh" aria-hidden />;
  if (!ageGateBlocksAction(confirmed)) return <>{children}</>;

  const onContinue = (): void => {
    confirmAgeGate();
    setConfirmed(true);
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-10">
      <Card>
        <h1 className="text-2xl font-black">Before you play</h1>
        <label className="mt-4 flex items-start gap-3 text-sm text-white/80">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
            className="mt-1 h-6 w-6 shrink-0"
          />
          I confirm I am 18 years of age or older.
        </label>
        <div className="mt-4">
          <Banner>{RESPONSIBLE_DRINKING_NOTICE}</Banner>
        </div>
        <div className="mt-5">
          <BigButton disabled={!checked} onClick={onContinue}>
            Continue
          </BigButton>
        </div>
      </Card>
    </main>
  );
};
