import type { G6QuestionKind } from '@fdg/game-core';
import { useState } from 'react';
import { RevealFooter } from '@/components/RevealFooter';
import { RoundShell } from '@/components/RoundShell';
import { Card } from '@/components/ui';
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
      <RoundShell title="Trivia Rush" round={round} room={room} now={Date.now()}>
        <Card>
          <p className="mb-3 text-lg font-semibold">{questionText(payload.question.kind, payload.question.subjectName)}</p>
          <div className="flex flex-col gap-2">
            {payload.options.map((option) => {
              const isCorrect = option.id === solution.optionId;
              const picks = round.submissions.filter((submission) => (submission.payload as { optionId: string }).optionId === option.id);
              return (
                <div
                  key={option.id}
                  className={`rounded-xl px-4 py-3 font-semibold ${
                    isCorrect ? 'bg-pitch-600 text-white' : 'bg-white/5 text-white/70'
                  }`}
                >
                  {option.label}
                  {isCorrect ? ' ✓' : ''}
                  {picks.length > 0 ? <span className="ml-2 text-xs opacity-70">({picks.length})</span> : null}
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
      <Card>
        <p className="mb-4 text-lg font-semibold">{questionText(payload.question.kind, payload.question.subjectName)}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {payload.options.map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={alreadySubmitted}
              onClick={() => {
                setPicked(option.id);
                onSubmit({ optionId: option.id });
              }}
              className={`tap-target rounded-2xl border-2 px-4 font-bold transition-colors disabled:opacity-60 ${
                picked === option.id || (round.yourSubmission as { optionId: string } | null)?.optionId === option.id
                  ? 'border-pitch-500 bg-pitch-500/30'
                  : 'border-white/15 bg-white/5'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        {alreadySubmitted ? <p className="mt-3 text-center text-sm text-white/50">Answer locked in.</p> : null}
      </Card>
    </RoundShell>
  );
};
