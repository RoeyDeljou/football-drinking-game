import { useState } from 'react';
import { RevealFooter } from '@/components/RevealFooter';
import { RoundShell } from '@/components/RoundShell';
import { BigButton, Card, Eyebrow } from '@/components/ui';
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
      <RoundShell title="Shirt Number" round={round} room={room} now={Date.now()} split>
        <div className="flex flex-col gap-4">
        <Card>
          <p className="t-d2">{payload.target.name}</p>
          <p className="t-sm text-fg-muted">
            {payload.target.position} · {payload.target.isStarter ? 'Starting XI' : 'Bench'}
          </p>
          <p className="t-score tnum mt-3 text-accent">#{solution.shirtNumber}</p>
        </Card>
        <Card>
          <Eyebrow className="mb-2">Guesses</Eyebrow>
          <ul className="flex flex-col gap-2">
            {round.submissions
              .slice()
              .sort(
                (a, b) =>
                  Math.abs((a.payload as { guess: number }).guess - solution.shirtNumber) -
                  Math.abs((b.payload as { guess: number }).guess - solution.shirtNumber),
              )
              .map((submission) => (
                <li key={submission.playerId} className="flex min-h-12 flex-wrap justify-between gap-x-2 gap-y-1 rounded-md bg-hover px-4 py-3 text-base">
                  <span className="max-w-full flex-1 basis-32">{nicknameOf(room, submission.playerId)}</span>
                  <span className="ml-auto shrink-0 whitespace-nowrap font-bold">#{(submission.payload as { guess: number }).guess}</span>
                </li>
              ))}
          </ul>
        </Card>
        </div>
        <RevealFooter round={round} room={room} />
      </RoundShell>
    );
  }

  return (
    <RoundShell title="Shirt Number" round={round} room={room} now={Date.now()}>
      <Card className="lg:p-8">
        <div className="split-cols gap-4 lg:items-center lg:gap-8 land:items-center">
        <div>
        <p className="t-d2 lg:text-4xl">{payload.target.name}</p>
        <p className="t-sm mb-4 text-fg-muted lg:mb-0">
          {payload.target.position} · {payload.target.isStarter ? 'Starting XI' : 'Bench'}
        </p>
        <p className="t-score tnum mb-2 text-center text-[4.5rem] lg:text-[7rem]">{guess}</p>
        </div>
        <div>
        <input
          type="range"
          min={1}
          max={99}
          value={guess}
          disabled={alreadySubmitted}
          onChange={(event) => setGuess(Number(event.target.value))}
          className="tap-target w-full accent-accent"
          aria-label="Shirt number guess"
        />
        <BigButton
          className="mt-4"
          disabled={alreadySubmitted}
          onClick={() => onSubmit({ guess })}
        >
          {alreadySubmitted ? 'Locked in' : `Lock in #${guess}`}
        </BigButton>
        </div>
        </div>
      </Card>
    </RoundShell>
  );
};
