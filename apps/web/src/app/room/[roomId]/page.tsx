'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ConnectionStatusBanner } from '@/components/ConnectionStatusBanner';
import { FinalResultsScreen } from '@/components/FinalResultsScreen';
import { GameHost } from '@/components/GameHost';
import { IntermissionScreen } from '@/components/IntermissionScreen';
import { Lobby } from '@/components/Lobby';
import { LoadingScreen } from '@/components/LoadingScreen';
import { Banner, BigButton, Spinner } from '@/components/ui';
import { fetchRoomById } from '@/lib/api';
import { errorMessage } from '@/lib/errorCopy';
import { intermissionContinueAction } from '@/lib/intermissionActions';
import { useRoom } from '@/lib/room-context';
import { loadRoom } from '@/lib/storage';

const MATCHDAY_STEP_KEYS = ['fixture', 'lineups', 'squads', 'stats'];
const GENERAL_STEP_KEYS = ['dataset'];

export default function RoomPage(): React.JSX.Element {
  const params = useParams<{ roomId: string }>();
  const roomId = params.roomId;
  const router = useRouter();
  const { room, self, status, send, lastError, clearError, leaveRoom } = useRoom();
  const [category, setCategory] = useState<'matchday' | 'general' | null>(null);
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    const stored = loadRoom();
    if (stored !== null && stored.roomId === roomId) return;
    setRedirecting(true);
    void (async (): Promise<void> => {
      const summary = await fetchRoomById(roomId);
      if (summary.ok) {
        router.replace(`/join/${summary.value.pin}`);
      } else {
        router.replace('/join');
      }
    })();
  }, [roomId, router]);

  useEffect(() => {
    void (async (): Promise<void> => {
      const summary = await fetchRoomById(roomId);
      if (summary.ok) setCategory(summary.value.fixtureId !== null ? 'matchday' : 'general');
    })();
  }, [roomId]);

  const actorId = self?.playerId;

  const selectGame = (moduleId: string): void => {
    if (actorId === undefined) return;
    send({ type: 'SELECT_GAME', actorId, moduleId, config: null });
  };

  const startLoading = (): void => {
    if (actorId === undefined) return;
    const stepKeys = category === 'matchday' ? MATCHDAY_STEP_KEYS : GENERAL_STEP_KEYS;
    send({ type: 'START_LOADING', actorId, stepKeys });
  };

  const startSession = (): void => {
    if (actorId === undefined) return;
    send({ type: 'START_SESSION', actorId });
  };

  const submitAnswer = (payload: unknown): void => {
    const currentRound = room?.round;
    if (actorId === undefined || currentRound === null || currentRound === undefined) return;
    send({ type: 'SUBMIT_ANSWER', playerId: actorId, roundId: currentRound.id, payload });
  };

  const revealNow = (): void => {
    if (actorId === undefined) return;
    send({ type: 'REVEAL_ROUND', actorId });
  };

  const advance = (): void => {
    if (actorId === undefined) return;
    send({ type: 'ADVANCE', actorId });
  };

  // The host's "continue" tap on the intermission screen: START_SESSION when the session just
  // finished (play again / a newly picked game), ADVANCE mid-session for the next round. Never
  // START_LOADING from intermission — the engine only accepts that from 'lobby'.
  const continueFromIntermission = (): void => {
    if (actorId === undefined) return;
    const action = intermissionContinueAction(room?.session?.finished ?? true);
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

  if (redirecting) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md items-center justify-center px-6">
        <Spinner label="Looking for that room…" />
      </main>
    );
  }

  if (status === 'fatal') {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <Banner tone="error">This room is no longer reachable.</Banner>
        <BigButton onClick={() => router.push('/')}>Back to start</BigButton>
      </main>
    );
  }

  if (room === null || self === null) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md items-center justify-center px-6">
        <Spinner label="Connecting to your room…" />
      </main>
    );
  }

  const isHost = room.you?.isHost ?? false;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 px-4 py-6 safe-bottom">
      <ConnectionStatusBanner status={status} />
      {lastError !== null ? (
        <div role="alert">
          <Banner tone="error">
            {errorMessage(lastError)}
            <button type="button" onClick={clearError} className="ml-3 underline">
              dismiss
            </button>
          </Banner>
        </div>
      ) : null}

      {room.phase === 'lobby' ? (
        <Lobby room={room} category={category} isHost={isHost} onSelectGame={selectGame} onStartLoading={startLoading} />
      ) : null}

      {room.phase === 'loading' && room.loading !== null ? (
        <LoadingScreen loading={room.loading} isHost={isHost} onRetry={startLoading} />
      ) : null}

      {room.phase === 'loading' && room.loading !== null && room.loading.steps.every((step) => step.status === 'done') ? (
        <div className="fixed inset-x-0 bottom-4 mx-auto max-w-md px-4">
          {isHost ? <BigButton onClick={startSession}>Start playing</BigButton> : null}
        </div>
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
    </main>
  );
}
