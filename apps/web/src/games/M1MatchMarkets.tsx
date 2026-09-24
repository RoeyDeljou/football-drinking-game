import { useState } from 'react';
import { RevealFooter } from '@/components/RevealFooter';
import { RoundShell } from '@/components/RoundShell';
import { BigButton, Card } from '@/components/ui';
import type { GameScreenProps } from './types';

interface MarketOption {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly homeGoals: number | null;
  readonly awayGoals: number | null;
}

interface Market {
  readonly id: string;
  readonly kind: string;
  readonly line: number | null;
  readonly options: readonly MarketOption[];
}

interface Settlement {
  readonly marketId: string;
  readonly optionId: string;
  readonly outcome: 'WON' | 'LOST';
}

interface PublicPayload {
  readonly kind: 'MATCH_MARKETS';
  readonly markets: readonly Market[];
  readonly settlements: readonly Settlement[];
  readonly slipLocked: boolean;
  readonly counters: { readonly homeGoals: number; readonly awayGoals: number };
}

interface Solution {
  readonly settled: boolean;
  readonly settlements: readonly Settlement[];
}

const marketTitle = (kind: string, line: number | null): string => {
  const withLine = (label: string): string => (line !== null ? `${label} (${line})` : label);
  switch (kind) {
    case 'MATCH_RESULT':
      return 'Full-time result';
    case 'HT_RESULT':
      return 'Half-time result';
    case 'BTTS':
      return 'Both teams to score';
    case 'OVER_UNDER_GOALS':
      return withLine('Total goals');
    case 'OVER_UNDER_CORNERS':
      return withLine('Total corners');
    case 'OVER_UNDER_CARDS':
      return withLine('Total cards');
    case 'PENALTY_AWARDED':
      return 'Penalty awarded';
    case 'FIRST_SCORER':
      return 'First goalscorer';
    case 'ANYTIME_SCORER':
      return 'Anytime goalscorer';
    case 'WINNING_MARGIN':
      return 'Winning margin';
    case 'CORRECT_SCORE':
      return 'Correct score';
    default:
      return kind;
  }
};

/** `SCORELINE`/`OTHER`/etc humanize themselves; anything genuinely unrecognized still never shows a
 * raw enum token — e.g. `SOME_NEW_KIND` -> "Some new kind". */
const humanizeKind = (kind: string): string => {
  const words = kind.toLowerCase().split('_');
  const first = words[0];
  if (first === undefined) return kind;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(' ');
};

/**
 * The engine deliberately leaves `option.label` empty whenever the real value lives in a structured
 * field instead (a scoreline's `homeGoals`/`awayGoals`, a margin/draw/yes-no/over-under option that
 * is fully described by its `kind`) — see `m1-match-markets.ts`'s `option()` calls. This is the one
 * place that turns those structured fields + `kind` (disambiguated by the parent market, since
 * `OTHER`/`DRAW` mean different things in different markets) into a real display label.
 */
const optionLabel = (market: Market, option: MarketOption): string => {
  if (option.label.length > 0) return option.label;
  switch (option.kind) {
    case 'YES':
      return 'Yes';
    case 'NO':
      return 'No';
    case 'OVER':
      return 'Over';
    case 'UNDER':
      return 'Under';
    case 'DRAW':
      return 'Draw';
    case 'NO_GOAL':
      return 'No goalscorer';
    case 'MARGIN_1':
      return 'Win by 1';
    case 'MARGIN_2':
      return 'Win by 2';
    case 'MARGIN_3_PLUS':
      return 'Win by 3+';
    case 'SCORELINE':
      return option.homeGoals !== null && option.awayGoals !== null ? `${option.homeGoals}-${option.awayGoals}` : 'Scoreline';
    case 'OTHER':
      return market.kind === 'CORRECT_SCORE' ? 'Any other score' : 'Another player';
    default:
      return humanizeKind(option.kind);
  }
};

export const M1MatchMarkets = ({ room, round, onSubmit }: GameScreenProps): React.JSX.Element => {
  const payload = round.publicPayload as PublicPayload;
  const previousPicks = (round.yourSubmission as { picks: readonly { marketId: string; optionId: string }[] } | null)?.picks ?? [];
  const [picks, setPicks] = useState<Record<string, string>>(
    Object.fromEntries(previousPicks.map((pick) => [pick.marketId, pick.optionId])),
  );

  const pickedCount = payload.markets.filter((market) => picks[market.id] !== undefined).length;
  const allPicked = pickedCount === payload.markets.length;
  const canEdit = !payload.slipLocked;

  const submitSlip = (): void => {
    onSubmit({ picks: payload.markets.map((market) => ({ marketId: market.id, optionId: picks[market.id] })) });
  };

  if (round.visibility === 'revealed') {
    const solution = round.solution as Solution;
    return (
      <RoundShell title="Match Markets" round={round} room={room} now={Date.now()}>
        <Card>
          <p className="text-sm text-white/60">
            {solution.settled ? 'Full time.' : 'Revealed before full time — only what settled counts.'}
          </p>
          <p className="mt-1 text-3xl font-black">
            {payload.counters.homeGoals} – {payload.counters.awayGoals}
          </p>
        </Card>
        <Card>
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-white/50">Your slip</h2>
          <ul className="flex flex-col gap-2">
            {payload.markets.map((market) => {
              const pickedOptionId = picks[market.id];
              const settlement = solution.settlements.find(
                (entry) => entry.marketId === market.id && entry.optionId === pickedOptionId,
              );
              const option = market.options.find((candidate) => candidate.id === pickedOptionId);
              return (
                <li key={market.id} className="flex items-center justify-between rounded-xl bg-white/5 px-4 py-2 text-sm">
                  <span>
                    {marketTitle(market.kind, market.line)}: {option === undefined ? '—' : optionLabel(market, option)}
                  </span>
                  <span
                    className={`font-bold ${
                      settlement === undefined ? 'text-white/40' : settlement.outcome === 'WON' ? 'text-pitch-400' : 'text-red-400'
                    }`}
                  >
                    {settlement === undefined ? 'pending' : settlement.outcome}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
        <RevealFooter round={round} room={room} />
      </RoundShell>
    );
  }

  return (
    <RoundShell title="Match Markets" round={round} room={room} now={Date.now()}>
      {!canEdit ? <Card><p className="text-sm text-amber-300">Kick-off happened — the slip is locked.</p></Card> : null}
      <div className="flex flex-col gap-3">
        {payload.markets.map((market) => (
          <Card key={market.id}>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-bold">{marketTitle(market.kind, market.line)}</p>
              {picks[market.id] === undefined ? (
                <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-300">
                  Pick one
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {market.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  disabled={!canEdit}
                  onClick={() => setPicks((prev) => ({ ...prev, [market.id]: option.id }))}
                  className={`tap-target rounded-xl border-2 px-3 text-sm font-bold disabled:opacity-50 ${
                    picks[market.id] === option.id ? 'border-pitch-500 bg-pitch-500/30' : 'border-white/15 bg-white/5'
                  }`}
                >
                  {optionLabel(market, option)}
                </button>
              ))}
            </div>
          </Card>
        ))}
      </div>
      <p className="text-center text-sm text-white/50" aria-live="polite">
        {pickedCount}/{payload.markets.length} markets picked
      </p>
      <BigButton disabled={!allPicked || !canEdit} onClick={submitSlip}>
        {round.yourSubmission !== null ? 'Update slip' : 'Submit slip'}
      </BigButton>
    </RoundShell>
  );
};
