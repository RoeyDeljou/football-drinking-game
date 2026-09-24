import { RevealFooter } from '@/components/RevealFooter';
import { RoundShell } from '@/components/RoundShell';
import { Card } from '@/components/ui';
import type { GameScreenProps } from './types';

type Clue =
  | { readonly kind: 'NATIONALITY'; readonly value: string }
  | { readonly kind: 'POSITION'; readonly value: string }
  | { readonly kind: 'AGE'; readonly value: number }
  | { readonly kind: 'CAREER'; readonly clubs: readonly string[] }
  | { readonly kind: 'SHIRT_NUMBER'; readonly value: number };

interface Option {
  readonly playerId: string;
  readonly name: string;
}

interface PublicPayload {
  readonly kind: 'GUESS_PLAYER';
  readonly clues: readonly Clue[];
  readonly options: readonly Option[];
}

interface Solution {
  readonly playerId: string;
  readonly name: string;
}

const clueText = (clue: Clue): string => {
  switch (clue.kind) {
    case 'NATIONALITY':
      return `Nationality: ${clue.value}`;
    case 'POSITION':
      return `Position: ${clue.value}`;
    case 'AGE':
      return `Age: ${clue.value}`;
    case 'CAREER':
      return `Clubs: ${clue.clubs.join(' → ')}`;
    case 'SHIRT_NUMBER':
      return `Shirt number: ${clue.value}`;
    default: {
      // Unreachable today (the switch is exhaustive over the current `Clue` union), but the
      // payload is only cast, not runtime-validated here — if a future clue kind ever slips
      // through, humanize it rather than silently rendering an empty line (matches M1's
      // `humanizeKind` pattern for the same "never show raw/blank data" reason).
      const kind = (clue as { readonly kind: string }).kind;
      const words = kind.toLowerCase().split('_');
      const first = words[0];
      return first === undefined ? kind : [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(' ');
    }
  }
};

export const G1GuessThePlayer = ({ room, round, onSubmit }: GameScreenProps): React.JSX.Element => {
  const payload = round.publicPayload as PublicPayload;
  const alreadySubmitted = round.yourSubmission !== null;
  const yourPick = (round.yourSubmission as { playerId: string } | null)?.playerId ?? null;

  if (round.visibility === 'revealed') {
    const solution = round.solution as Solution;
    return (
      <RoundShell title="Guess the Player" round={round} room={room} now={Date.now()}>
        <Card>
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-white/50">All clues</h2>
          <ul className="mb-4 flex flex-col gap-1 text-sm text-white/80">
            {payload.clues.map((clue) => (
              <li key={clue.kind}>{clueText(clue)}</li>
            ))}
          </ul>
          <p className="text-3xl font-black text-pitch-500">{solution.name}</p>
        </Card>
        <RevealFooter round={round} room={room} />
      </RoundShell>
    );
  }

  return (
    <RoundShell title="Guess the Player" round={round} room={room} now={Date.now()}>
      <Card>
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-white/50">
          Clues unlocked ({payload.clues.length})
        </h2>
        <ul className="mb-4 flex flex-col gap-1 text-base font-semibold">
          {payload.clues.map((clue) => (
            <li key={clue.kind}>{clueText(clue)}</li>
          ))}
        </ul>
        <div className="grid grid-cols-2 gap-3">
          {payload.options.map((option) => (
            <button
              key={option.playerId}
              type="button"
              disabled={alreadySubmitted}
              onClick={() => onSubmit({ playerId: option.playerId })}
              className={`tap-target rounded-2xl border-2 px-3 text-left text-sm font-bold disabled:opacity-60 ${
                yourPick === option.playerId ? 'border-pitch-500 bg-pitch-500/30' : 'border-white/15 bg-white/5'
              }`}
            >
              {option.name}
            </button>
          ))}
        </div>
        {alreadySubmitted ? <p className="mt-3 text-center text-sm text-white/50">Answer locked in. More clues keep unlocking for everyone else.</p> : null}
      </Card>
    </RoundShell>
  );
};
