import type { M2FactKind } from '@fdg/game-core';
import { RevealFooter } from '@/components/RevealFooter';
import { RoundShell } from '@/components/RoundShell';
import { Card } from '@/components/ui';
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
      <RoundShell title="Who's That Player?" round={round} room={room} now={Date.now()}>
        <Card>
          <p className="mb-3 text-lg font-semibold">{factText(payload.fact.kind, payload.fact.value)}</p>
          <div className="flex flex-col gap-2">
            {payload.options.map((option) => {
              const isCorrect = option.playerId === solution.playerId;
              const picks = round.submissions.filter(
                (submission) => (submission.payload as { playerId: string }).playerId === option.playerId,
              );
              return (
                <div
                  key={option.playerId}
                  className={`flex items-center justify-between rounded-xl px-4 py-3 font-semibold ${
                    isCorrect ? 'bg-pitch-600 text-white' : 'bg-white/5 text-white/70'
                  }`}
                >
                  <span>
                    {option.name}
                    {isCorrect ? ' ✓' : ''}
                  </span>
                  {picks.length > 0 ? (
                    <span className="text-xs opacity-70">
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
      <Card>
        <p className="mb-4 text-lg font-semibold">{factText(payload.fact.kind, payload.fact.value)}</p>
        <p className="mb-3 text-xs uppercase tracking-wide text-white/40">
          One of these {payload.options.length} is the answer
        </p>
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
              {option.shirtNumber !== null ? <span className="ml-1 text-white/40">#{option.shirtNumber}</span> : null}
            </button>
          ))}
        </div>
        {alreadySubmitted ? <p className="mt-3 text-center text-sm text-white/50">Answer locked in.</p> : null}
      </Card>
    </RoundShell>
  );
};
