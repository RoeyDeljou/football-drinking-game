'use client';

import type { ConnectionStatus } from '@/lib/room-context';
import { Banner } from './ui';

/** Pinned to the top edge (below the notch) so a dropped connection is visible wherever the page is
 * scrolled; the opaque backing keeps the translucent banner readable over content. */
const Pinned = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => (
  <div className="sticky top-[max(0.5rem,env(safe-area-inset-top))] z-30 mx-auto w-full max-w-3xl rounded-md bg-bg shadow-sheet">
    {children}
  </div>
);

export const ConnectionStatusBanner = ({ status }: { readonly status: ConnectionStatus }): React.JSX.Element | null => {
  if (status === 'connected' || status === 'idle') return null;
  if (status === 'connecting') {
    return (
      <Pinned>
        <Banner tone="info">Connecting…</Banner>
      </Pinned>
    );
  }
  if (status === 'reconnecting') {
    return (
      <Pinned>
        <Banner tone="warn">Connection dropped — reconnecting… your seat is held.</Banner>
      </Pinned>
    );
  }
  if (status === 'fatal') {
    return (
      <Pinned>
        <Banner tone="error">Lost this room for good. Try joining again.</Banner>
      </Pinned>
    );
  }
  return (
    <Pinned>
      <Banner tone="warn">Disconnected.</Banner>
    </Pinned>
  );
};
