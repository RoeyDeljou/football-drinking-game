import { RoundShell } from '@/components/RoundShell';
import { Card, Eyebrow } from '@/components/ui';
import { eventFiredLine, eventRuleLine, roundDrinkTotalLine } from '@/lib/drinkCopy';
import { eventLabel, minuteLabel, type LiveEventKind } from '@/lib/liveEventCopy';
import { nicknameOf } from '@/lib/roomHelpers';
import type { GameScreenProps } from './types';

interface Fire {
  readonly eventId: string;
  readonly kind: LiveEventKind;
  readonly side: 'home' | 'away' | null;
  readonly minute: number;
  readonly extraMinute: number | null;
  readonly playerName: string | null;
  readonly ownerIds: readonly string[];
}

interface PublicPayload {
  readonly kind: 'EVENT_ROULETTE';
  readonly drinker: 'owner' | 'others';
  readonly sipsPerFire: number;
  readonly windowMinutes: number;
  readonly startMinute: number | null;
  readonly endMinute: number | null;
  readonly clockKnown: boolean;
  readonly matchClock: { readonly minute: number; readonly extraMinute: number | null } | null;
  readonly deal: readonly { readonly playerId: string; readonly event: LiveEventKind }[];
  readonly fires: readonly Fire[];
}

interface Solution {
  readonly status: 'running' | 'ended' | 'void';
  readonly endedBy: 'WINDOW_END' | 'FULL_TIME' | 'MATCH_OVER' | null;
}

const ENDED_COPY: Record<string, string> = {
  WINDOW_END: 'The spin ran its full window.',
  FULL_TIME: 'Full time ended the spin.',
  MATCH_OVER: 'The match was already over when this round opened.',
  HOST: 'The host called the spin.',
};

const FireFeed = ({
  room,
  round,
  payload,
}: {
  readonly room: GameScreenProps['room'];
  readonly round: GameScreenProps['round'];
  readonly payload: PublicPayload;
}): React.JSX.Element => {
  const teams = { home: room.currentFixture?.homeTeam.name ?? 'Home', away: room.currentFixture?.awayTeam.name ?? 'Away' };
  const fires = payload.fires.slice().reverse();
  return (
    <Card>
      <Eyebrow className="mb-2">Fires ({fires.length})</Eyebrow>
      {fires.length === 0 ? (
        <p role="status" className="t-body text-fg-muted">
          {round.visibility === 'revealed'
            ? 'No fires this spin. Nobody drank for it.'
            : 'Nothing yet. Watch the match, someone’s event is coming.'}
        </p>
      ) : (
        <ol className="flex flex-col gap-2" aria-live="polite">
          {fires.map((fire) => (
            <li key={fire.eventId} className="rounded-md border-2 border-accent/50 bg-selected px-3 py-3">
              <p className="t-h3 max-w-full">
                {eventFiredLine(
                  eventLabel(fire.kind),
                  fire.ownerIds.map((id) => nicknameOf(room, id)),
                  payload.drinker,
                  payload.sipsPerFire,
                )}
              </p>
              <p className="t-sm text-fg-muted">
                <span className="tnum whitespace-nowrap font-bold text-fg">{minuteLabel(fire.minute, fire.extraMinute)}</span>
                {fire.side !== null ? ` · ${teams[fire.side]}` : ''}
                {fire.playerName !== null ? ` · ${fire.playerName}` : ''}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
};

const DealList = ({
  room,
  payload,
  showFires,
  winnerIds,
}: {
  readonly room: GameScreenProps['room'];
  readonly payload: PublicPayload;
  readonly showFires: boolean;
  readonly winnerIds: readonly string[];
}): React.JSX.Element => {
  const firesFor = (playerId: string): number => payload.fires.filter((fire) => fire.ownerIds.includes(playerId)).length;
  return (
    <Card>
      <Eyebrow className="mb-2">The deal</Eyebrow>
      <ul className="split-cols gap-2 [--split-min:13rem]">
        {payload.deal.map((entry) => {
          const mine = entry.playerId === room.viewerId;
          const fired = firesFor(entry.playerId);
          return (
            <li
              key={entry.playerId}
              className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border-2 px-3 py-3 ${
                mine ? 'border-accent bg-selected' : 'border-transparent bg-hover'
              }`}
            >
              <span className="max-w-full flex-1 basis-28 font-semibold">
                {nicknameOf(room, entry.playerId)}
                {mine ? ' (you)' : ''}
                {winnerIds.includes(entry.playerId) ? <span className="t-xs text-up"> · lucky</span> : null}
              </span>
              <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
                <span className="whitespace-nowrap rounded-full border-2 border-accent px-3 py-0.5 font-bold text-accent">
                  {eventLabel(entry.event)}
                </span>
                {showFires ? (
                  <span className="tnum whitespace-nowrap font-black" aria-label={`${fired} fires`}>
                    {fired}x
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
};

export const M5EventRoulette = ({ room, round, now }: GameScreenProps): React.JSX.Element => {
  const payload = round.publicPayload as PublicPayload;
  const mine = payload.deal.find((entry) => entry.playerId === room.viewerId) ?? null;

  if (round.visibility === 'revealed') {
    const solution = round.solution as Solution;
    const winnerIds = round.outcome?.winnerIds ?? [];
    const totals = new Map<string, number>();
    for (const penalty of round.penalties) {
      totals.set(penalty.recipientId, (totals.get(penalty.recipientId) ?? 0) + penalty.appliedSips);
    }
    const summaryEnd = (round.outcome?.summary as { endedBy?: string } | null | undefined)?.endedBy;
    const endedBy = solution.status === 'void' ? solution.endedBy : (solution.endedBy ?? summaryEnd ?? null);
    return (
      <RoundShell title="Event Roulette" round={round} room={room} now={now} split showAnswered={false}>
        <div className="flex flex-col gap-4">
          <Card>
            <Eyebrow>{solution.status === 'void' ? 'Round void' : 'Spin over'}</Eyebrow>
            <p className="t-d2 mt-1">{ENDED_COPY[endedBy ?? 'HOST'] ?? ENDED_COPY.HOST}</p>
            <p className="t-body mt-1 text-fg-muted">
              {payload.fires.length} {payload.fires.length === 1 ? 'fire' : 'fires'}
              {payload.startMinute !== null && payload.endMinute !== null
                ? ` between ${payload.startMinute}' and ${payload.endMinute}'`
                : ''}
              .
            </p>
          </Card>
          <DealList room={room} payload={payload} showFires winnerIds={payload.drinker === 'owner' ? winnerIds : []} />
        </div>
        <div className="flex flex-col gap-4">
          <FireFeed room={room} round={round} payload={payload} />
          <Card>
            <Eyebrow className="mb-2">Who drank</Eyebrow>
            {totals.size === 0 ? (
              <p className="t-body text-center text-fg-muted">Nobody drinks this round. Lucky table.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {[...totals.entries()].map(([playerId, sips]) => (
                  <li key={playerId} className="rounded-md border-2 border-accent/50 bg-selected px-4 py-3 font-semibold">
                    {roundDrinkTotalLine(nicknameOf(room, playerId), sips)}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </RoundShell>
    );
  }

  const clockText = payload.matchClock !== null ? minuteLabel(payload.matchClock.minute, payload.matchClock.extraMinute) : null;

  if (!payload.clockKnown) {
    return (
      <RoundShell title="Event Roulette" round={round} room={room} now={now} showAnswered={false}>
        <Card className="text-center">
          <p role="status" aria-live="polite" className="t-d2">
            Waiting for the match clock…
          </p>
          <p className="t-body mt-2 text-fg-muted">The spin starts as soon as we know what minute it is.</p>
        </Card>
        <DealList room={room} payload={payload} showFires={false} winnerIds={[]} />
      </RoundShell>
    );
  }

  const span = payload.startMinute !== null && payload.endMinute !== null ? payload.endMinute - payload.startMinute : 0;
  const played = payload.matchClock !== null && payload.startMinute !== null ? payload.matchClock.minute - payload.startMinute : 0;
  const ratio = span <= 0 ? 0 : Math.min(100, Math.max(0, (played / span) * 100));

  return (
    <RoundShell title="Event Roulette" round={round} room={room} now={now} showAnswered={false}>
      <Card className="lg:p-6">
        <div className="split-cols gap-4 lg:items-center lg:gap-8 land:items-center">
          <div className="text-center">
            <Eyebrow>{mine !== null ? 'Your event' : 'You have no event'}</Eyebrow>
            {mine !== null ? (
              <p className="t-score mt-1 text-accent">{eventLabel(mine.event)}</p>
            ) : (
              <p className="t-body mt-1 text-fg-muted">
                {payload.drinker === 'owner'
                  ? 'You joined after the deal, so you sit this spin out.'
                  : 'You joined after the deal, so you have no event. You still drink with the table when someone else’s fires.'}
              </p>
            )}
            <p className="t-body mt-2 font-semibold">
              {payload.drinker === 'owner' ? 'Your event, your drink.' : 'Your event, everyone else drinks.'}
            </p>
            {mine !== null ? <p className="t-sm text-fg-muted">{eventRuleLine(payload.drinker, payload.sipsPerFire)}</p> : null}
          </div>
          <div>
            <p className="t-body flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="whitespace-nowrap">
                Match clock <strong className="tnum text-fg">{clockText ?? 'not started'}</strong>
              </span>
              <span className="whitespace-nowrap text-fg-muted">
                Spin {payload.startMinute}&apos; to {payload.endMinute}&apos;
              </span>
            </p>
            <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-bg-sunken" aria-hidden>
              <div className="h-full bg-accent" style={{ width: `${ratio}%` }} />
            </div>
          </div>
        </div>
      </Card>
      <div className="split-cols gap-4 lg:items-start lg:gap-6 land:items-start">
        <DealList room={room} payload={payload} showFires winnerIds={[]} />
        <FireFeed room={room} round={round} payload={payload} />
      </div>
    </RoundShell>
  );
};
