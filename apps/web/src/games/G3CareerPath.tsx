import { RevealFooter } from '@/components/RevealFooter';
import { RoundShell } from '@/components/RoundShell';
import { Card, Eyebrow, OptionButton } from '@/components/ui';
import type { GameScreenProps } from './types';

interface ClubStep {
  readonly name: string;
  readonly from: string | null;
  readonly to: string | null;
}

interface Option {
  readonly playerId: string;
  readonly name: string;
}

interface PublicPayload {
  readonly kind: 'CAREER_PATH';
  readonly clubs: readonly ClubStep[];
  readonly options: readonly Option[];
  readonly clueIntervalMs: number;
}

interface Solution {
  readonly playerId: string;
  readonly name: string;
  readonly clueCount: number;
}

const clubText = (club: ClubStep): string => `${club.name} (${club.from ?? '?'}–${club.to ?? 'now'})`;

export const G3CareerPath = ({ room, round, onSubmit }: GameScreenProps): React.JSX.Element => {
  const payload = round.publicPayload as PublicPayload;
  const alreadySubmitted = round.yourSubmission !== null;
  const yourPick = (round.yourSubmission as { playerId: string } | null)?.playerId ?? null;

  if (round.visibility === 'revealed') {
    const solution = round.solution as Solution;
    return (
      <RoundShell title="Career Path" round={round} room={room} now={Date.now()} split>
        <Card>
          <Eyebrow className="mb-2">Full career</Eyebrow>
          <ol className="t-body mb-4 flex flex-col gap-1 text-fg-muted">
            {payload.clubs.map((club, index) => (
              <li key={`${club.name}-${index}`}>{clubText(club)}</li>
            ))}
          </ol>
          <p className="t-score text-accent">{solution.name}</p>
        </Card>
        <RevealFooter round={round} room={room} />
      </RoundShell>
    );
  }

  return (
    <RoundShell title="Career Path" round={round} room={room} now={Date.now()}>
      <Card className="lg:p-8">
        <div className="split-cols gap-4 lg:items-start lg:gap-8 land:items-start">
        <div>
        <Eyebrow className="mb-2">Clubs revealed ({payload.clubs.length}) · oldest first</Eyebrow>
        <ol className="t-h3 flex flex-col gap-1 lg:text-2xl">
          {payload.clubs.map((club, index) => (
            <li key={`${club.name}-${index}`}>{clubText(club)}</li>
          ))}
        </ol>
        </div>
        <div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8.5rem),1fr))] gap-3">
          {payload.options.map((option) => (
            <OptionButton
              key={option.playerId}
              selected={yourPick === option.playerId}
              disabled={alreadySubmitted}
              onClick={() => onSubmit({ playerId: option.playerId })}
              className="min-h-16 px-3 text-sm sm:text-base lg:min-h-20 lg:text-lg"
            >
              {option.name}
            </OptionButton>
          ))}
        </div>
        {alreadySubmitted ? (
          <p className="t-sm mt-3 text-center text-fg-muted">
            Answer locked in. More clubs keep unlocking for everyone else.
          </p>
        ) : null}
        </div>
        </div>
      </Card>
    </RoundShell>
  );
};
