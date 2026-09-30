import { useState } from 'react';
import { RevealFooter } from '@/components/RevealFooter';
import { RoundShell } from '@/components/RoundShell';
import { BigButton, Card, Eyebrow } from '@/components/ui';
import { nicknameOf } from '@/lib/roomHelpers';
import type { GameScreenProps } from './types';

interface Clock {
  readonly minute: number;
  readonly extraMinute: number | null;
}

interface PublicPayload {
  readonly kind: 'MINUTE_SNIPER';
  readonly clockKnown: boolean;
  readonly matchClock: Clock | null;
  readonly minPick: number | null;
  readonly maxPick: number;
  readonly scoreAtOpen: { readonly home: number; readonly away: number } | null;
}

interface Goal {
  readonly type: 'GOAL' | 'PENALTY_SCORED' | 'OWN_GOAL';
  readonly minute: number;
  readonly extraMinute: number | null;
  readonly creditedSide: 'home' | 'away' | null;
  readonly playerName: string | null;
}

interface Solution {
  readonly outcome: 'pending' | 'goal' | 'no-goal' | 'void';
  readonly voidReason: 'MATCH_OVER' | 'NO_MINUTES_LEFT' | null;
  readonly targetMinute: number | null;
  readonly goal: Goal | null;
}

interface SummaryPick {
  readonly playerId: string;
  readonly minute: number;
  readonly distance: number | null;
}

interface Summary {
  readonly voidReason?: string | null;
  readonly bestDistance?: number | null;
  readonly worstDistance?: number | null;
  readonly picks: readonly SummaryPick[];
}

const asSummary = (value: unknown): Summary | null => {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<Summary>;
  return Array.isArray(candidate.picks) ? (candidate as Summary) : null;
};

const clockText = (clock: Clock): string =>
  clock.extraMinute !== null && clock.extraMinute > 0 ? `${clock.minute}+${clock.extraMinute}'` : `${clock.minute}'`;

const GOAL_LABEL: Record<Goal['type'], string> = { GOAL: 'Goal', PENALTY_SCORED: 'Penalty scored', OWN_GOAL: 'Own goal' };

const VOID_COPY: Record<string, string> = {
  MATCH_OVER: 'The match was already over when this round opened.',
  NO_MINUTES_LEFT: 'No minutes were left to pick from.',
  ABANDONED: 'The host revealed before a goal or the final whistle.',
};

/** Home and away as the room already knows them (the "now playing" annotation) — names only, no crests. */
const teamNames = (room: GameScreenProps['room']): { home: string; away: string } => ({
  home: room.currentFixture?.homeTeam.name ?? 'Home',
  away: room.currentFixture?.awayTeam.name ?? 'Away',
});

const MatchStrip = ({
  room,
  payload,
}: {
  readonly room: GameScreenProps['room'];
  readonly payload: PublicPayload;
}): React.JSX.Element => {
  const names = teamNames(room);
  return (
    <div className="rounded-md bg-hover px-4 py-3 text-center">
      <p className="t-h3 max-w-full">
        {names.home} <span className="text-fg-muted">vs</span> {names.away}
      </p>
      <p className="t-body mt-1 flex flex-wrap items-baseline justify-center gap-x-4 text-fg-muted">
        <span className="whitespace-nowrap">
          Match clock{' '}
          <strong className="tnum text-fg">{payload.matchClock !== null ? clockText(payload.matchClock) : 'not started'}</strong>
        </span>
        {payload.scoreAtOpen !== null ? (
          <span className="whitespace-nowrap">
            Score when opened{' '}
            <strong className="tnum text-fg">
              {payload.scoreAtOpen.home}–{payload.scoreAtOpen.away}
            </strong>
          </span>
        ) : null}
      </p>
    </div>
  );
};

export const M7MinuteSniper = ({ room, round, now, onSubmit }: GameScreenProps): React.JSX.Element => {
  const payload = round.publicPayload as PublicPayload;
  const yourPick = (round.yourSubmission as { minute: number } | null)?.minute ?? null;
  const [chosen, setChosen] = useState<number | null>(null);

  if (round.visibility === 'revealed') {
    const solution = round.solution as Solution;
    const summary = asSummary(round.outcome?.summary);
    const names = teamNames(room);
    const picks = (summary?.picks ?? [])
      .slice()
      .sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999) || a.minute - b.minute);
    const settled = solution.outcome === 'goal' || solution.outcome === 'no-goal';
    const best = summary?.bestDistance ?? null;
    const worst = summary?.worstDistance ?? null;
    const voidText =
      solution.outcome === 'void' ? (VOID_COPY[solution.voidReason ?? summary?.voidReason ?? 'ABANDONED'] ?? VOID_COPY.ABANDONED) : null;

    return (
      <RoundShell title="Minute Sniper" round={round} room={room} now={now} split>
        <Card className="lg:p-6">
          {solution.outcome === 'goal' && solution.goal !== null ? (
            <>
              <Eyebrow>{GOAL_LABEL[solution.goal.type]}</Eyebrow>
              <p className="t-score tnum mt-1 text-accent">{clockText(solution.goal)}</p>
              <p className="t-h3 mt-2">
                {solution.goal.playerName ?? 'Scorer not listed'}
                {solution.goal.creditedSide !== null ? (
                  <span className="text-fg-muted"> · for {solution.goal.creditedSide === 'home' ? names.home : names.away}</span>
                ) : null}
              </p>
            </>
          ) : null}
          {solution.outcome === 'no-goal' ? (
            <>
              <Eyebrow>No goal</Eyebrow>
              <p className="t-score tnum mt-1 text-accent">90&apos;</p>
              <p className="t-body mt-2 text-fg-muted">Full time came first, so picks are measured against 90.</p>
            </>
          ) : null}
          {solution.outcome === 'void' ? (
            <>
              <Eyebrow>Round void</Eyebrow>
              <p className="t-d2 mt-1">{voidText}</p>
              <p className="t-body mt-2 text-fg-muted">No points, no drinks.</p>
            </>
          ) : null}
        </Card>
        <div className="flex flex-col gap-4">
          <Card>
            <Eyebrow className="mb-2">Everyone&apos;s picks</Eyebrow>
            {picks.length === 0 ? (
              <p className="t-body text-fg-muted">Nobody picked a minute.</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {picks.map((pick) => {
                  const closest = settled && best !== null && pick.distance === best;
                  const furthest = settled && worst !== null && best !== worst && pick.distance === worst;
                  return (
                    <li
                      key={pick.playerId}
                      className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border-2 px-3 py-3 ${
                        closest ? 'border-up bg-up/15' : furthest ? 'border-down/60 bg-down/10' : 'border-transparent bg-hover'
                      }`}
                    >
                      <span className="max-w-full flex-1 basis-32 font-semibold">
                        {nicknameOf(room, pick.playerId)}
                        {closest ? <span className="t-xs text-up"> · closest</span> : null}
                        {furthest ? <span className="t-xs text-down"> · furthest</span> : null}
                      </span>
                      <span className="tnum ml-auto whitespace-nowrap font-black">
                        {pick.minute}&apos;
                        {pick.distance !== null ? (
                          <span className="t-sm font-normal text-fg-muted">
                            {' '}
                            · {pick.distance === 0 ? 'exact' : `${pick.distance} off`}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
          <RevealFooter round={round} room={room} />
        </div>
      </RoundShell>
    );
  }

  const windowOpen = round.deadlineAt !== null && now < round.deadlineAt;

  if (!payload.clockKnown) {
    return (
      <RoundShell title="Minute Sniper" round={round} room={room} now={now} countdown={false}>
        <Card className="text-center">
          <MatchStrip room={room} payload={payload} />
          <p role="status" aria-live="polite" className="t-d2 mt-4">
            Waiting for the match clock…
          </p>
          <p className="t-body mt-2 text-fg-muted">Picks open the moment we know what minute it is.</p>
        </Card>
      </RoundShell>
    );
  }

  if (!windowOpen || payload.minPick === null) {
    return (
      <RoundShell title="Minute Sniper" round={round} room={room} now={now} countdown={false}>
        <Card className="text-center">
          <MatchStrip room={room} payload={payload} />
          <p className="t-eyebrow mt-4">{yourPick !== null ? 'Your pick' : 'Picks closed'}</p>
          {yourPick !== null ? <p className="t-score tnum text-accent">{yourPick}&apos;</p> : null}
          <p role="status" aria-live="polite" className="t-d2 mt-2">
            {payload.minPick === null ? 'No minutes left to pick.' : 'Waiting for the next goal…'}
          </p>
          <p className="t-body mt-2 text-fg-muted">
            {yourPick === null ? 'You missed the pick window this time. ' : ''}The round settles on the next goal, or
            full time.
          </p>
        </Card>
      </RoundShell>
    );
  }

  const min = payload.minPick;
  const max = payload.maxPick;
  const seed = yourPick ?? Math.min(max, min + 9);
  // The feed can move the clock on while someone is choosing: never show a minute that is now in the past.
  const minute = Math.min(max, Math.max(min, chosen ?? seed));
  const seconds = Math.max(0, Math.ceil(((round.deadlineAt ?? now) - now) / 1000));
  const unchanged = yourPick !== null && yourPick === minute;

  return (
    <RoundShell title="Minute Sniper" round={round} room={room} now={now}>
      <Card className="lg:p-6">
        <div className="split-cols gap-4 lg:items-center lg:gap-8 land:items-center">
          <div className="flex flex-col gap-3">
            <MatchStrip room={room} payload={payload} />
            <p className="t-body text-center text-fg-muted">
              Minute of the next goal, from {min}&apos; to {max}&apos;. Stoppage goals count as 45 or 90. Change your
              pick any time in the next <strong className="tnum text-fg">{seconds}s</strong>.
            </p>
          </div>
          <div>
            <p className="t-score tnum text-center text-[4.5rem] lg:text-[7rem]" aria-live="polite">
              {minute}&apos;
            </p>
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                aria-label="One minute earlier"
                disabled={minute <= min}
                onClick={() => setChosen(minute - 1)}
                className="tap-target pressable min-w-[56px] flex-[0_0_4rem] rounded-md border-2 border-border-strong text-2xl font-bold disabled:opacity-40"
              >
                −
              </button>
              <input
                type="range"
                min={min}
                max={max}
                value={minute}
                onChange={(event) => setChosen(Number(event.target.value))}
                className="range-big min-w-0 flex-1"
                aria-label="Minute of the next goal"
              />
              <button
                type="button"
                aria-label="One minute later"
                disabled={minute >= max}
                onClick={() => setChosen(minute + 1)}
                className="tap-target pressable min-w-[56px] flex-[0_0_4rem] rounded-md border-2 border-border-strong text-2xl font-bold disabled:opacity-40"
              >
                +
              </button>
            </div>
            <BigButton className="mt-4" disabled={unchanged} onClick={() => onSubmit({ minute })}>
              {yourPick === null ? `Lock in ${minute}'` : unchanged ? `Locked in ${minute}'` : `Change to ${minute}'`}
            </BigButton>
          </div>
        </div>
      </Card>
    </RoundShell>
  );
};
