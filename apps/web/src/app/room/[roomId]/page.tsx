'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ConnectionStatusBanner } from '@/components/ConnectionStatusBanner';
import { FinalResultsScreen } from '@/components/FinalResultsScreen';
import { GameHost } from '@/components/GameHost';
import { IntermissionScreen } from '@/components/IntermissionScreen';
import { Lobby } from '@/components/Lobby';
import { LoadingScreen } from '@/components/LoadingScreen';
import { RoomExitControls } from '@/components/RoomExitControls';
import { Banner, BigButton, Spinner } from '@/components/ui';
import { fetchRoomById } from '@/lib/api';
import { markUpcomingNavigationAsReplace } from '@/lib/backNavigation';
import { errorMessage } from '@/lib/errorCopy';
import { shouldShowGamedayExhaustedBanner } from '@/lib/gamedayEnd';
import { intermissionContinueAction } from '@/lib/intermissionActions';
import { useRoom } from '@/lib/room-context';
import { clearPendingSelection, loadPendingSelection, loadRoom, loadRoomSetup } from '@/lib/storage';

const MATCHDAY_STEP_KEYS = ['fixture', 'lineups', 'squads', 'stats'];
const GENERAL_STEP_KEYS = ['dataset'];

/** How long to wait before re-asking for the room summary after a failed request. */
const ROOM_SUMMARY_RETRY_MS = 3_000;

export default function RoomPage(): React.JSX.Element {
  const params = useParams<{ roomId: string }>();
  const roomId = params.roomId;
  const router = useRouter();
  const { room, self, status, send, lastError, clearError, leaveRoom } = useRoom();
  const [category, setCategory] = useState<'matchday' | 'general' | null>(null);
  const [isGameday, setIsGameday] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [deletingRoom, setDeletingRoom] = useState(false);
  // The game the host picked on /host, waiting to be dispatched as SELECT_GAME once connected.
  const [initialModuleId, setInitialModuleId] = useState<string | null>(null);

  // The host's own setup from /host: the category before the server round trip below confirms it
  // (so the lobby picker never flashes the wrong category's games), and the lobby summary's scope.
  const [setupScope, setSetupScope] = useState<string | null>(null);

  useEffect(() => {
    setInitialModuleId(loadPendingSelection(roomId));
    const setup = loadRoomSetup(roomId);
    if (setup !== null) {
      setCategory((current) => current ?? setup.category);
      setSetupScope(setup.scopeLabel);
    }
  }, [roomId]);

  const settleInitialSelection = (): void => {
    clearPendingSelection();
    setInitialModuleId(null);
  };

  useEffect(() => {
    const stored = loadRoom();
    if (stored !== null && stored.roomId === roomId) return;
    setRedirecting(true);
    void (async (): Promise<void> => {
      const summary = await fetchRoomById(roomId);
      // This is a redirect, not a user-chosen navigation: it must never be recorded as in-app
      // history (see NavigationTracker / backNavigation.ts), or Back after it would pop the tab's
      // real history and leave the app entirely.
      markUpcomingNavigationAsReplace();
      if (summary.ok) {
        router.replace(`/join/${summary.value.pin}`);
      } else {
        router.replace('/join');
      }
    })();
  }, [roomId, router]);

  useEffect(() => {
    // Retried until it lands: the lobby picker waits on this category rather than guessing, so a
    // single failed request must not leave it on "Loading games…" for good.
    let cancelled = false;
    let retryTimer: number | undefined;
    const load = async (): Promise<void> => {
      const summary = await fetchRoomById(roomId);
      if (cancelled) return;
      if (summary.ok) {
        setCategory(summary.value.fixtureId !== null || summary.value.gamedayCompetitionId !== null ? 'matchday' : 'general');
        setIsGameday(summary.value.gamedayCompetitionId !== null);
        return;
      }
      retryTimer = window.setTimeout(() => void load(), ROOM_SUMMARY_RETRY_MS);
    };
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
    };
  }, [roomId]);

  const actorId = self?.playerId;

  // Which action the *last* `room:error` (if any) is a rejection of — the gameday-exhausted banner
  // (see `lib/gamedayEnd.ts`) only ever applies to a rejected `ADVANCE`; the exact same error code
  // can also mean "this specific game needs data this room doesn't have" from `SELECT_GAME`, which
  // must keep the ordinary generic error banner instead.
  const lastActionTypeRef = useRef<string | null>(null);

  const selectGame = (moduleId: string): boolean => {
    if (actorId === undefined || status !== 'connected') return false;
    lastActionTypeRef.current = 'SELECT_GAME';
    send({ type: 'SELECT_GAME', actorId, moduleId, config: null });
    return true;
  };

  const startLoading = (): void => {
    if (actorId === undefined) return;
    const stepKeys = category === 'matchday' ? MATCHDAY_STEP_KEYS : GENERAL_STEP_KEYS;
    lastActionTypeRef.current = 'START_LOADING';
    send({ type: 'START_LOADING', actorId, stepKeys });
  };

  const startSession = (): void => {
    if (actorId === undefined) return;
    lastActionTypeRef.current = 'START_SESSION';
    send({ type: 'START_SESSION', actorId });
  };

  const submitAnswer = (payload: unknown): void => {
    const currentRound = room?.round;
    if (actorId === undefined || currentRound === null || currentRound === undefined) return;
    lastActionTypeRef.current = 'SUBMIT_ANSWER';
    send({ type: 'SUBMIT_ANSWER', playerId: actorId, roundId: currentRound.id, payload });
  };

  const revealNow = (): void => {
    if (actorId === undefined) return;
    lastActionTypeRef.current = 'REVEAL_ROUND';
    send({ type: 'REVEAL_ROUND', actorId });
  };

  const advance = (): void => {
    if (actorId === undefined) return;
    lastActionTypeRef.current = 'ADVANCE';
    send({ type: 'ADVANCE', actorId });
  };

  // The host's "continue" tap on the intermission screen: START_SESSION when the session just
  // finished (play again / a newly picked game), ADVANCE mid-session for the next round. Never
  // START_LOADING from intermission — the engine only accepts that from 'lobby'.
  const continueFromIntermission = (): void => {
    if (actorId === undefined) return;
    const action = intermissionContinueAction(room?.session?.finished ?? true);
    lastActionTypeRef.current = action.type;
    if (action.type === 'START_SESSION') {
      send({ type: 'START_SESSION', actorId });
    } else {
      send({ type: 'ADVANCE', actorId });
    }
  };

  const finishRoom = (): void => {
    if (actorId === undefined) return;
    send({ type: 'FINISH_ROOM', actorId });
  };

  const leaveAndGoHome = (): void => {
    leaveRoom();
    router.push('/');
  };

  const hostNewRoom = (): void => {
    leaveRoom();
    router.push('/host');
  };

  // The UI trigger for the engine's host-only ABORT_ROOM action (packages/game-core/src/reducer.ts
  // `abortRoom`) — ends the room for every player right now. `HOST_ABORTED` is the abort reason
  // that already exists specifically for this case (see `AbortReason` in state.ts and the copy in
  // FinalResultsScreen). Once the room:state broadcast confirms the phase actually flipped to
  // 'aborted' (below), the host is taken straight back to "/" rather than sitting on the "Room
  // closed" screen they just triggered themselves.
  const deleteRoom = (): void => {
    if (actorId === undefined) return;
    setDeletingRoom(true);
    send({ type: 'ABORT_ROOM', actorId, reason: 'HOST_ABORTED' });
  };

  useEffect(() => {
    if (deletingRoom && room?.phase === 'aborted') {
      leaveRoom();
      router.push('/');
    }
  }, [deletingRoom, room?.phase, leaveRoom, router]);

  if (redirecting) {
    return (
      <main className="page page-narrow page-center items-center">
        <Spinner label="Looking for that room…" />
      </main>
    );
  }

  if (status === 'fatal') {
    return (
      <main className="page page-narrow page-center items-center gap-4 text-center">
        <Banner tone="error">This room is no longer reachable.</Banner>
        <BigButton onClick={() => router.push('/')}>Back to start</BigButton>
      </main>
    );
  }

  if (room === null || self === null) {
    return (
      <main className="page page-narrow page-center items-center">
        <Spinner label="Connecting to your room…" />
      </main>
    );
  }

  const isHost = room.you?.isHost ?? false;

  const loadingDone =
    room.phase === 'loading' && room.loading !== null && room.loading.steps.every((step) => step.status === 'done');

  return (
    <main className="page page-wide">
      {/* Banners stay a readable measure on a wide screen; the connection banner also stays pinned so a
          dropped socket is visible wherever the page is scrolled. */}
      <ConnectionStatusBanner status={status} />
      {lastError !== null &&
      shouldShowGamedayExhaustedBanner(isGameday, lastError.code, lastActionTypeRef.current === 'ADVANCE') ? (
        <div role="alert" className="mx-auto w-full max-w-3xl">
          <Banner tone="warn">
            No more live matches in this competition — there’s nothing left to rotate through.
            {isHost ? (
              <button type="button" onClick={finishRoom} className="tap-target ml-3 px-2 underline">
                End room
              </button>
            ) : (
              <span className="ml-3 text-fg-muted">Waiting for the host to end the room…</span>
            )}
          </Banner>
        </div>
      ) : lastError !== null ? (
        <div role="alert" className="mx-auto w-full max-w-3xl">
          <Banner tone="error">
            <span className="flex items-center justify-between gap-3">
              <span className="max-w-full">{errorMessage(lastError, category)}</span>
              <button type="button" onClick={clearError} className="tap-target shrink-0 px-2 underline">
                dismiss
              </button>
            </span>
          </Banner>
        </div>
      ) : null}

      {room.phase === 'lobby' ? (
        <Lobby
          room={room}
          category={category}
          isHost={isHost}
          onSelectGame={selectGame}
          onStartLoading={startLoading}
          autoSelectModuleId={isHost ? initialModuleId : null}
          setupScope={isHost ? setupScope : null}
          onAutoSelectSettled={settleInitialSelection}
        />
      ) : null}

      {room.phase === 'loading' && room.loading !== null ? (
        <LoadingScreen loading={room.loading} isHost={isHost} onRetry={startLoading} />
      ) : null}

      {(room.phase === 'playing' || room.phase === 'roundReveal') ? (
        <GameHost room={room} isHost={isHost} onSubmit={submitAnswer} onAdvance={advance} onRevealNow={revealNow} />
      ) : null}

      {room.phase === 'intermission' ? (
        <IntermissionScreen
          room={room}
          category={category}
          isHost={isHost}
          onNextRound={continueFromIntermission}
          onSelectGame={selectGame}
          onPlayAgain={continueFromIntermission}
          onFinishRoom={finishRoom}
        />
      ) : null}

      {(room.phase === 'finished' || room.phase === 'aborted') ? (
        <FinalResultsScreen room={room} onLeave={leaveAndGoHome} onHostNew={hostNewRoom} />
      ) : null}

      {/* Last on the page: a way out should be findable, not the first thing anyone taps. */}
      <RoomExitControls
        phase={room.phase}
        isHost={isHost}
        deletingRoom={deletingRoom}
        onLeaveRoom={leaveAndGoHome}
        onDeleteRoom={deleteRoom}
      />

      {/* Last in the flow and sticky to the bottom edge: it can never cover content or the exit link (the
          page simply scrolls past it), and it clears the home indicator. Guests see nothing here. */}
      {loadingDone && isHost ? (
        <div className="sticky bottom-0 z-20 -mx-4 mt-auto bg-gradient-to-t from-bg from-70% to-transparent px-4 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-6 sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10">
          <div className="mx-auto w-full max-w-md">
            <BigButton onClick={startSession}>Start playing</BigButton>
          </div>
        </div>
      ) : null}
    </main>
  );
}
