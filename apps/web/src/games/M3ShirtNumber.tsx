import { useState } from 'react';
import { RevealFooter } from '@/components/RevealFooter';
import { RoundShell } from '@/components/RoundShell';
import { BigButton, Card } from '@/components/ui';
import { nicknameOf } from '@/lib/roomHelpers';
import type { GameScreenProps } from './types';

interface PublicPayload {
  readonly kind: 'SHIRT_NUMBER';
  readonly target: { readonly name: string; readonly position: string; readonly isStarter: boolean };
}

interface Solution {
  readonly playerId: string;
  readonly shirtNumber: number;
}

export const M3ShirtNumber = ({ room, round, onSubmit }: GameScreenProps): React.JSX.Element => {
  const payload = round.publicPayload as PublicPayload;
  const [guess, setGuess] = useState(10);
  const alreadySubmitted = round.yourSubmission !== null;

  if (round.visibility === 'revealed') {
    const solution = round.solution as Solution;
    return (
      <RoundShell title="Shirt Number" round={round} room={room} now={Date.now()}>
        <Card>
          <p className="text-lg font-semibold">{payload.target.name}</p>
          <p className="text-sm text-white/50">
            {payload.target.position} · {payload.target.isStarter ? 'Starting XI' : 'Bench'}
          </p>
          <p className="mt-3 text-5xl font-black text-pitch-500">#{solution.shirtNumber}</p>
        </Card>
        <Card>
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-white/50">Guesses</h2>
          <ul className="flex flex-col gap-2">
            {round.submissions
              .slice()
              .sort(
                (a, b) =>
                  Math.abs((a.payload as { guess: number }).guess - solution.shirtNumber) -
                  Math.abs((b.payload as { guess: number }).guess - solution.shirtNumber),
              )
              .map((submission) => (
                <li key={submission.playerId} className="flex justify-between rounded-xl bg-white/5 px-4 py-2 text-sm">
                  <span>{nicknameOf(room, submission.playerId)}</span>
                  <span className="font-bold">#{(submission.payload as { guess: number }).guess}</span>
                </li>
              ))}
          </ul>
        </Card>
        <RevealFooter round={round} room={room} />
      </RoundShell>
    );
  }

  return (
    <RoundShell title="Shirt Number" round={round} room={room} now={Date.now()}>
      <Card>
        <p className="text-lg font-semibold">{payload.target.name}</p>
        <p className="mb-4 text-sm text-white/50">
          {payload.target.position} · {payload.target.isStarter ? 'Starting XI' : 'Bench'}
        </p>
        <p className="mb-2 text-center text-6xl font-black tabular-nums">{guess}</p>
        <input
          type="range"
          min={1}
          max={99}
          value={guess}
          disabled={alreadySubmitted}
          onChange={(event) => setGuess(Number(event.target.value))}
          className="tap-target w-full accent-pitch-500"
          aria-label="Shirt number guess"
        />
        <BigButton
          className="mt-4"
          disabled={alreadySubmitted}
          onClick={() => onSubmit({ guess })}
        >
          {alreadySubmitted ? 'Locked in' : `Lock in #${guess}`}
        </BigButton>
      </Card>
    </RoundShell>
  );
};
