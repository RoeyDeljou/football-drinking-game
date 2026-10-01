import { useState } from 'react';
import { RevealFooter } from '@/components/RevealFooter';
import { RoundShell } from '@/components/RoundShell';
import { Card, CountdownBar, Eyebrow, OptionButton } from '@/components/ui';
import { minuteLabel } from '@/lib/liveEventCopy';
import { nicknameOf } from '@/lib/roomHelpers';
import type { GameScreenProps } from './types';

type Answer = 'YES' | 'NO' | 'HOME' | 'AWAY' | 'NONE';
type QuestionType = 'GOAL_IN_WINDOW' | 'NEXT_GOAL_SIDE' | 'NEXT_CARD_SIDE' | 'CORNERS_OVER' | 'TEAM_SHOT_ON_TARGET';

interface Question {
  readonly type: QuestionType;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly options: readonly Answer[];
  readonly line: number | null;
  readonly side: 'home' | 'away' | null;
}

interface PublicPayload {
  readonly kind: 'FLASH_ROUND';
  readonly question: Question | null;
  readonly questionAt: number | null;
  readonly answersCloseAt: number | null;
  readonly windowCount: number;
  readonly clockKnown: boolean;
  readonly matchClock: { readonly minute: number; readonly extraMinute: number | null } | null;
}

interface Solution {
  readonly outcome: 'pending' | 'settled' | 'void';
  readonly answer: Answer | null;
  readonly settledBy: 'EVENT' | 'WINDOW_END' | 'FULL_TIME' | null;
  readonly voidReason: 'MATCH_OVER' | 'NO_WINDOW' | null;
}

interface Summary {
  readonly voidReason?: string | null;
  readonly answers: readonly { readonly playerId: string; readonly answer: Answer }[];
}

const asSummary = (value: unknown): Summary | null => {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<Summary>;
  return Array.isArray(candidate.answers) ? (candidate as Summary) : null;
};

const VOID_COPY: Record<string, string> = {
  MATCH_OVER: 'The match was already over when this round opened.',
  NO_WINDOW: 'Not enough match time left for a fair question.',
  ABANDONED: 'The host revealed before the question settled.',
};

const SETTLED_COPY: Record<string, string> = {
  EVENT: 'It happened inside the window.',
  WINDOW_END: 'The window ended without it.',
  FULL_TIME: 'Full time came first.',
};

const teamsOf = (room: GameScreenProps['room']): { home: string; away: string } => ({
  home: room.currentFixture?.homeTeam.name ?? 'Home',
  away: room.currentFixture?.awayTeam.name ?? 'Away',
});

/** The question in plain English, window included ("Goal between 57' and 70'?"). */
const questionText = (question: Question, teams: { home: string; away: string }): string => {
  const window = `between ${question.startMinute}' and ${question.endMinute}'`;
  switch (question.type) {
    case 'GOAL_IN_WINDOW':
      return `Goal ${window}?`;
    case 'NEXT_GOAL_SIDE':
      return `Who scores the next goal ${window}?`;
    case 'NEXT_CARD_SIDE':
      return `Whose is the next card ${window}?`;
    case 'CORNERS_OVER':
      return `More than ${question.line ?? 0} ${question.line === 1 ? 'corner' : 'corners'} ${window}?`;
    case 'TEAM_SHOT_ON_TARGET':
      return `Will ${question.side === 'away' ? teams.away : teams.home} have a shot on target ${window}?`;
    default: {
      const exhaustive: never = question.type;
      return exhaustive;
    }
  }
};

const settlesOn = (question: Question): string => {
  switch (question.type) {
    case 'GOAL_IN_WINDOW':
      return 'the first goal';
    case 'NEXT_GOAL_SIDE':
      return 'the next goal';
    case 'NEXT_CARD_SIDE':
      return 'the next card';
    case 'CORNERS_OVER':
      return `corner number ${(question.line ?? 0) + 1}`;
    case 'TEAM_SHOT_ON_TARGET':
      return 'their first shot on target';
    default: {
      const exhaustive: never = question.type;
      return exhaustive;
    }
  }
};

const answerLabel = (answer: Answer, teams: { home: string; away: string }): string =>
  answer === 'YES' ? 'Yes' : answer === 'NO' ? 'No' : answer === 'HOME' ? teams.home : answer === 'AWAY' ? teams.away : 'Nobody';

export const M9FlashRounds = ({ room, round, now, onSubmit }: GameScreenProps): React.JSX.Element => {
  const payload = round.publicPayload as PublicPayload;
  const teams = teamsOf(room);
  const yourAnswer = (round.yourSubmission as { answer: Answer } | null)?.answer ?? null;
  const [pending, setPending] = useState<Answer | null>(null);
  const question = payload.question;

  if (round.visibility === 'revealed') {
    const solution = round.solution as Solution;
    const summary = asSummary(round.outcome?.summary);
    const scores = new Map((round.outcome?.scores ?? []).map((score) => [score.playerId as string, score.points]));
    const answers = summary?.answers ?? [];
    const winnerIds: readonly string[] = round.outcome?.winnerIds ?? [];
    return (
      <RoundShell title="Flash Round" round={round} room={room} now={now} split>
        <Card className="lg:p-6">
          {question !== null ? <p className="t-d2 mb-3 text-[min(1.375rem,6.5vw)] sm:text-[1.375rem]">{questionText(question, teams)}</p> : null}
          {solution.outcome === 'settled' && solution.answer !== null ? (
            <>
              <Eyebrow>The answer</Eyebrow>
              <p className="t-d1 mt-1 max-w-full text-accent">{answerLabel(solution.answer, teams)}</p>
              <p className="t-body mt-2 text-fg-muted">
                {SETTLED_COPY[solution.settledBy ?? 'WINDOW_END']}
                {question !== null && question.type === 'CORNERS_OVER' ? ` ${payload.windowCount} counted.` : ''}
                {payload.matchClock !== null ? ` Clock ${minuteLabel(payload.matchClock.minute, payload.matchClock.extraMinute)}.` : ''}
              </p>
            </>
          ) : (
            <>
              <Eyebrow>Round void</Eyebrow>
              <p className="t-d2 mt-1">{VOID_COPY[solution.voidReason ?? summary?.voidReason ?? 'ABANDONED'] ?? VOID_COPY.ABANDONED}</p>
              <p className="t-body mt-2 text-fg-muted">No points, no drinks.</p>
            </>
          )}
        </Card>
        <div className="flex flex-col gap-4">
          <Card>
            <Eyebrow className="mb-2">Everyone&apos;s answers</Eyebrow>
            {answers.length === 0 ? (
              <p className="t-body text-fg-muted">Nobody answered.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {answers.map((entry) => {
                  const won = winnerIds.includes(entry.playerId);
                  const points = scores.get(entry.playerId);
                  return (
                    <li
                      key={entry.playerId}
                      className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border-2 px-3 py-3 ${
                        won ? 'border-up bg-up/15' : 'border-transparent bg-hover'
                      }`}
                    >
                      <span className="max-w-full flex-1 basis-28 font-semibold">{nicknameOf(room, entry.playerId)}</span>
                      <span className="ml-auto flex flex-wrap items-baseline justify-end gap-x-3">
                        <span className="max-w-full font-bold">{answerLabel(entry.answer, teams)}</span>
                        {solution.outcome === 'settled' ? (
                          <span className="tnum whitespace-nowrap text-sm text-fg-muted">
                            {won ? '✓ ' : ''}
                            {points !== undefined ? `${points} pts` : ''}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <RevealFooter round={round} room={room} />
        </div>
      </RoundShell>
    );
  }

  const clockText = payload.matchClock !== null ? minuteLabel(payload.matchClock.minute, payload.matchClock.extraMinute) : null;

  if (question === null || payload.questionAt === null || payload.answersCloseAt === null) {
    return (
      <RoundShell title="Flash Round" round={round} room={room} now={now} countdown={false} showAnswered={false}>
        <Card className="text-center">
          <p role="status" aria-live="polite" className="t-d2">
            {payload.clockKnown ? 'Your question is on its way…' : 'Waiting for the match clock…'}
          </p>
          <p className="t-body mt-2 text-fg-muted">A quick question about the next stretch of the match is coming.</p>
        </Card>
      </RoundShell>
    );
  }

  const open = now < payload.answersCloseAt;
  const shown = pending ?? yourAnswer;
  const locked = shown !== null || !open;

  return (
    <RoundShell title="Flash Round" round={round} room={room} now={now} countdown={false}>
      <Card className="lg:p-6">
        <p className="t-d2 max-w-full text-[min(1.375rem,6.5vw)] sm:text-[1.375rem] lg:text-4xl">{questionText(question, teams)}</p>
        {open ? (
          <div className="mt-3">
            <CountdownBar deadlineAt={payload.answersCloseAt} now={now} totalMs={payload.answersCloseAt - payload.questionAt} />
          </div>
        ) : null}
        <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3" role="group" aria-label="Your answer">
          {question.options.map((option) => (
            <OptionButton
              key={option}
              selected={shown === option}
              aria-pressed={shown === option}
              disabled={locked}
              onClick={() => {
                setPending(option);
                onSubmit({ answer: option });
              }}
              className="min-h-20 text-center text-[min(1.125rem,5.5vw)] sm:text-lg lg:min-h-24 lg:text-xl"
            >
              {shown === option ? <span aria-hidden>✓ </span> : null}
              {answerLabel(option, teams)}
            </OptionButton>
          ))}
        </div>
        {locked ? (
          <div role="status" aria-live="polite" className="mt-4 text-center">
            <p className="t-h3">
              {shown !== null ? `Locked in: ${answerLabel(shown, teams)}` : 'Answers are closed. You sit this one out.'}
            </p>
            <p className="t-body mt-1 text-fg-muted">
              Waiting. It settles at {question.endMinute}&apos; or on {settlesOn(question)}.
              {question.type === 'CORNERS_OVER' ? ` Corners counted so far: ${payload.windowCount}.` : ''}
            </p>
            <p className="t-sm mt-1 text-fg-muted">
              Match clock <strong className="tnum text-fg">{clockText ?? 'not started'}</strong>
            </p>
          </div>
        ) : null}
      </Card>
    </RoundShell>
  );
};
