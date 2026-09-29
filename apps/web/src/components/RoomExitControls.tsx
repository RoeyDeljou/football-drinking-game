'use client';

/**
 * The one way out of an active room besides the browser's own (unreliable) back button, for both
 * roles:
 *  - Host: "Delete room" — the UI trigger for the engine's host-only `ABORT_ROOM` action. Visible
 *    from right after room creation (the lobby) through every non-terminal phase. Irreversible and
 *    kicks every other player out, so it always sits behind a confirm step.
 *  - Guest: "Leave room" pre-game (no consequence for anyone else, so a plain tap is enough) or a
 *    smaller, confirm-gated "Leave game" once a session is under way (leaving mid-round affects
 *    everyone else, so it's deliberately less prominent and never a bare one-tap action).
 *
 * Both roles reuse the same `leaveRoom`/`ABORT_ROOM` mechanisms the app already has — this is only
 * the UI trigger; no rules are decided here.
 */

import { useState } from 'react';
import type { RoomPhase } from '@fdg/game-core';
import { ConfirmDialog } from './ui';

const TERMINAL_PHASES: ReadonlySet<RoomPhase> = new Set(['finished', 'aborted']);

export const RoomExitControls = ({
  phase,
  isHost,
  deletingRoom,
  onLeaveRoom,
  onDeleteRoom,
}: {
  readonly phase: RoomPhase;
  readonly isHost: boolean;
  /** True once the host has confirmed deletion and the room is waiting to observe the resulting
   * `aborted` phase — disables the trigger so a slow round trip can't be tapped twice. */
  readonly deletingRoom: boolean;
  readonly onLeaveRoom: () => void;
  readonly onDeleteRoom: () => void;
}): React.JSX.Element | null => {
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  if (TERMINAL_PHASES.has(phase)) return null;

  if (isHost) {
    return (
      <>
        <button
          type="button"
          onClick={() => setConfirmingDelete(true)}
          disabled={deletingRoom}
          className="pressable mt-2 min-h-11 self-center rounded-md px-3 text-xs font-semibold text-down/80 underline underline-offset-4 disabled:opacity-50"
        >
          {deletingRoom ? 'Ending room…' : 'Delete room'}
        </button>
        {confirmingDelete ? (
          <ConfirmDialog
            title="Delete this room?"
            message="This ends the game for everyone right now and can't be undone — every player still connected gets kicked out."
            confirmLabel="Yes, delete it"
            onConfirm={() => {
              setConfirmingDelete(false);
              onDeleteRoom();
            }}
            onCancel={() => setConfirmingDelete(false)}
          />
        ) : null}
      </>
    );
  }

  if (phase === 'lobby') {
    return (
      <button
        type="button"
        onClick={onLeaveRoom}
        className="pressable mt-2 min-h-11 self-center rounded-md px-3 text-xs font-semibold text-fg-muted underline underline-offset-4"
      >
        Leave room
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirmingLeave(true)}
        className="pressable mt-2 min-h-11 self-center rounded-md px-3 text-xs font-semibold text-fg-subtle"
      >
        Leave game
      </button>
      {confirmingLeave ? (
        <ConfirmDialog
          title="Leave this game?"
          message="You’ll drop out of the round in progress. Everyone else keeps playing without you."
          confirmLabel="Yes, leave"
          onConfirm={() => {
            setConfirmingLeave(false);
            onLeaveRoom();
          }}
          onCancel={() => setConfirmingLeave(false)}
        />
      ) : null}
    </>
  );
};
