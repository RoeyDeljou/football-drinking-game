import { RevealFooter } from '@/components/RevealFooter';
import { RoundShell } from '@/components/RoundShell';
import { Card, Eyebrow, OptionButton } from '@/components/ui';
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
          <Eyebrow className="mb-2">All clues</Eyebrow>
          <ul className="t-body mb-4 flex flex-col gap-1 text-fg-muted">
            {payload.clues.map((clue) => (
              <li key={clue.kind}>{clueText(clue)}</li>
            ))}
          </ul>
          <p className="t-score text-accent">{solution.name}</p>
        </Card>
        <RevealFooter round={round} room={room} />
      </RoundShell>
    );
  }

  return (
    <RoundShell title="Guess the Player" round={round} room={room} now={Date.now()}>
      <Card>
        <Eyebrow className="mb-2">Clues unlocked ({payload.clues.length})</Eyebrow>
        <ul className="t-h3 mb-4 flex flex-col gap-1">
          {payload.clues.map((clue) => (
            <li key={clue.kind}>{clueText(clue)}</li>
          ))}
        </ul>
        <div className="grid grid-cols-2 gap-3">
          {payload.options.map((option) => (
            <OptionButton
              key={option.playerId}
              selected={yourPick === option.playerId}
              disabled={alreadySubmitted}
              onClick={() => onSubmit({ playerId: option.playerId })}
              className="min-h-[64px] px-3 text-sm"
            >
              {option.name}
            </OptionButton>
          ))}
        </div>
        {alreadySubmitted ? <p className="t-sm mt-3 text-center text-fg-muted">Answer locked in. More clues keep unlocking for everyone else.</p> : null}
      </Card>
    </RoundShell>
  );
};
