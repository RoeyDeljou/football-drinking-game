import { RevealFooter } from '@/components/RevealFooter';
import { RoundShell } from '@/components/RoundShell';
import { Card } from '@/components/ui';
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
      <RoundShell title="Career Path" round={round} room={room} now={Date.now()}>
        <Card>
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-white/50">Full career</h2>
          <ol className="mb-4 flex flex-col gap-1 text-sm text-white/80">
            {payload.clubs.map((club, index) => (
              <li key={`${club.name}-${index}`}>{clubText(club)}</li>
            ))}
          </ol>
          <p className="text-3xl font-black text-pitch-500">{solution.name}</p>
        </Card>
        <RevealFooter round={round} room={room} />
      </RoundShell>
    );
  }

  return (
    <RoundShell title="Career Path" round={round} room={room} now={Date.now()}>
      <Card>
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-white/50">
          Clubs revealed ({payload.clubs.length}) · oldest first
        </h2>
        <ol className="mb-4 flex flex-col gap-1 text-base font-semibold">
          {payload.clubs.map((club, index) => (
            <li key={`${club.name}-${index}`}>{clubText(club)}</li>
          ))}
        </ol>
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
        {alreadySubmitted ? (
          <p className="mt-3 text-center text-sm text-white/50">
            Answer locked in. More clubs keep unlocking for everyone else.
          </p>
        ) : null}
      </Card>
    </RoundShell>
  );
};
