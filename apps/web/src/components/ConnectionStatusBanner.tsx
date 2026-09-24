'use client';

import type { ConnectionStatus } from '@/lib/room-context';
import { Banner } from './ui';

export const ConnectionStatusBanner = ({ status }: { readonly status: ConnectionStatus }): React.JSX.Element | null => {
  if (status === 'connected' || status === 'idle') return null;
  if (status === 'connecting') return <Banner tone="info">Connecting…</Banner>;
  if (status === 'reconnecting') {
    return <Banner tone="warn">Connection dropped — reconnecting… your seat is held.</Banner>;
  }
  if (status === 'fatal') return <Banner tone="error">Lost this room for good. Try joining again.</Banner>;
  return <Banner tone="warn">Disconnected.</Banner>;
};
