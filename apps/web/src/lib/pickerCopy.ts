/** All wording for the game picker's waiting states lives here (same convention as errorCopy.ts). */

import type { PendingPhase } from './selectionPending';

export const PICKER_COPY = {
  cardPending: 'Getting game data ready…',
  buttonPreparing: 'Preparing…',
  slow: 'Waking the server up and loading real football data, this can take up to a minute the first time…',
  stalled: 'Taking longer than usual.',
  retry: 'Try again',
  notConnectedConnecting: 'Connecting to the room… hold on a moment before picking.',
  notConnectedReconnecting: 'Connection dropped — reconnecting. You can pick a game once you’re back.',
  notConnectedOther: 'Not connected to the room yet.',
} as const;

export const pendingMessage = (phase: PendingPhase): string | null => {
  switch (phase) {
    case 'slow':
      return PICKER_COPY.slow;
    case 'stalled':
      return PICKER_COPY.stalled;
    default:
      return null;
  }
};

export const notConnectedMessage = (status: string): string | null => {
  switch (status) {
    case 'connected':
      return null;
    case 'connecting':
      return PICKER_COPY.notConnectedConnecting;
    case 'reconnecting':
      return PICKER_COPY.notConnectedReconnecting;
    default:
      return PICKER_COPY.notConnectedOther;
  }
};
