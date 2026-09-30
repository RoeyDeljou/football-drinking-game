import type { M2FactKind } from '@fdg/game-core';
import { RevealFooter } from '@/components/RevealFooter';
import { RoundShell } from '@/components/RoundShell';
import { Card, OptionButton } from '@/components/ui';
import type { GameScreenProps } from './types';

interface PitchOption {
  readonly playerId: string;
  readonly name: string;
  readonly shirtNumber: number | null;
  readonly position: string;
}

interface PublicPayload {
  readonly kind: 'WHO_IS_IT';
  readonly fact: { readonly kind: M2FactKind; readonly value: string | number };
  readonly options: readonly PitchOption[];
}

interface Solution {
  readonly playerId: string;
  readonly name: string;
}

const factText = (kind: M2FactKind, value: string | number): string => {
  switch (kind) {
    case 'NATIONALITY':
      return `Nationality: ${value}`;
    case 'AGE':
      return `Age: ${value}`;
    case 'HEIGHT_CM':
      return `Height: ${value} cm`;
    case 'SEASON_GOALS':
      return `Season goals: ${value}`;
    case 'SEASON_ASSISTS':
      return `Season assists: ${value}`;
    case 'SEASON_APPEARANCES':
      return `Season appearances: ${value}`;
    default:
      return String(value);
  }
};

export const M2WhoIsThatPlayer = ({ room, round, onSubmit }: GameScreenProps): React.JSX.Element => {
  const payload = round.publicPayload as PublicPayload;
  const alreadySubmitted = round.yourSubmission !== null;
  const yourPick = (round.yourSubmission as { playerId: string } | null)?.playerId ?? null;

  if (round.visibility === 'revealed') {
    const solution = round.solution as Solution;
    return (
      <RoundShell title="Who's That Player?" round={round} room={room} now={Date.now()} split>
        <Card>
          <p className="t-d2 mb-3">{factText(payload.fact.kind, payload.fact.value)}</p>
          <div className="flex flex-col gap-2 lg:text-lg">
            {payload.options.map((option) => {
              const isCorrect = option.playerId === solution.playerId;
              const picks = round.submissions.filter(
                (submission) => (submission.payload as { playerId: string }).playerId === option.playerId,
              );
              return (
                <div
                  key={option.playerId}
                  className={`flex flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-md border-2 px-4 py-3 font-semibold ${
                    isCorrect ? 'border-up bg-up/15 text-fg' : 'border-transparent bg-hover text-fg-muted'
                  }`}
                >
                  <span className="min-w-0 flex-1 basis-32">
                    {option.name}
                    {isCorrect ? ' ✓' : ''}
                  </span>
                  {picks.length > 0 ? (
                    <span className="tnum shrink-0 text-xs opacity-70">
                      {picks.length} {picks.length === 1 ? 'pick' : 'picks'}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Card>
        <RevealFooter round={round} room={room} />
      </RoundShell>
    );
  }

  return (
    <RoundShell title="Who's That Player?" round={round} room={room} now={Date.now()}>
      <Card className="lg:p-8">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-start lg:gap-8 land:grid-cols-2 land:items-start">
        <div>
        <p className="t-d2 mb-4 lg:text-4xl">{factText(payload.fact.kind, payload.fact.value)}</p>
        <p className="t-eyebrow">
          One of these {payload.options.length} is the answer
        </p>
        </div>
        <div>
        <div className="grid grid-cols-1 gap-3 min-[340px]:grid-cols-2">
          {payload.options.map((option) => (
            <OptionButton
              key={option.playerId}
              selected={yourPick === option.playerId}
              disabled={alreadySubmitted}
              onClick={() => onSubmit({ playerId: option.playerId })}
              className="min-h-16 px-3 text-sm sm:text-base lg:min-h-20 lg:text-lg"
            >
              {option.name}
              {option.shirtNumber !== null ? <span className="ml-1 whitespace-nowrap text-fg-subtle">#{option.shirtNumber}</span> : null}
            </OptionButton>
          ))}
        </div>
        {alreadySubmitted ? <p className="t-sm mt-3 text-center text-fg-muted">Answer locked in.</p> : null}
        </div>
        </div>
      </Card>
    </RoundShell>
  );
};
