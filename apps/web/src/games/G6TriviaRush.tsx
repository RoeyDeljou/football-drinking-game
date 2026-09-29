import type { G6QuestionKind } from '@fdg/game-core';
import { useState } from 'react';
import { RevealFooter } from '@/components/RevealFooter';
import { RoundShell } from '@/components/RoundShell';
import { Card, OptionButton } from '@/components/ui';
import type { GameScreenProps } from './types';

interface Option {
  readonly id: string;
  readonly label: string;
}

interface PublicPayload {
  readonly kind: 'TRIVIA';
  readonly question: { readonly kind: G6QuestionKind; readonly subjectName: string | null };
  readonly options: readonly Option[];
}

interface Solution {
  readonly optionId: string;
  readonly label: string;
  readonly subjectPlayerId: string | null;
}

const questionText = (kind: G6QuestionKind, subjectName: string | null): string => {
  switch (kind) {
    case 'MOST_GOALS':
      return 'Who has scored the most goals this season?';
    case 'MOST_ASSISTS':
      return 'Who has the most assists this season?';
    case 'MOST_APPEARANCES':
      return 'Who has made the most appearances this season?';
    case 'NATIONALITY_OF':
      return `What nationality is ${subjectName ?? 'this player'}?`;
    case 'TEAM_OF':
      return `Which team does ${subjectName ?? 'this player'} play for?`;
    default:
      return 'Pick the right answer.';
  }
};

export const G6TriviaRush = ({ room, round, onSubmit }: GameScreenProps): React.JSX.Element => {
  const payload = round.publicPayload as PublicPayload;
  const [picked, setPicked] = useState<string | null>(null);
  const alreadySubmitted = round.yourSubmission !== null;

  if (round.visibility === 'revealed') {
    const solution = round.solution as Solution;
    return (
      <RoundShell title="Trivia Rush" round={round} room={room} now={Date.now()} split>
        <Card>
          <p className="t-d2 mb-3 lg:text-3xl">{questionText(payload.question.kind, payload.question.subjectName)}</p>
          <div className="flex flex-col gap-2 lg:text-lg">
            {payload.options.map((option) => {
              const isCorrect = option.id === solution.optionId;
              const picks = round.submissions.filter((submission) => (submission.payload as { optionId: string }).optionId === option.id);
              return (
                <div
                  key={option.id}
                  className={`rounded-md border-2 px-4 py-3 font-semibold ${
                    isCorrect ? 'border-up bg-up/15 text-fg' : 'border-transparent bg-hover text-fg-muted'
                  }`}
                >
                  {option.label}
                  {isCorrect ? ' ✓' : ''}
                  {picks.length > 0 ? <span className="tnum ml-2 text-xs opacity-70">({picks.length})</span> : null}
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
    <RoundShell title="Trivia Rush" round={round} room={room} now={Date.now()}>
      <Card className="lg:p-8">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-start lg:gap-8 land:grid-cols-2 land:items-start">
        <p className="t-d2 lg:text-4xl">{questionText(payload.question.kind, payload.question.subjectName)}</p>
        <div>
        <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
          {payload.options.map((option) => (
            <OptionButton
              key={option.id}
              selected={picked === option.id || (round.yourSubmission as { optionId: string } | null)?.optionId === option.id}
              disabled={alreadySubmitted}
              onClick={() => {
                setPicked(option.id);
                onSubmit({ optionId: option.id });
              }}
              className="min-h-16 text-base lg:min-h-20 lg:text-lg"
            >
              {option.label}
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
