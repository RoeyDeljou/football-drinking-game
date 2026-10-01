import { RoundShell } from '@/components/RoundShell';
import { Card, Eyebrow } from '@/components/ui';
import { drinkActionLabel, roundDrinkTotalLine, yourManLine, type YourManAction } from '@/lib/drinkCopy';
import { minuteLabel } from '@/lib/liveEventCopy';
import { nicknameOf } from '@/lib/roomHelpers';
import type { GameScreenProps } from './types';

interface RosterEntry {
  readonly footballerId: string;
  readonly name: string;
  readonly teamId: string;
  readonly position: string;
}

interface DraftEntry {
  readonly playerId: string;
  readonly current: string | null;
  readonly chain: readonly { readonly footballerId: string; readonly via: 'draft' | 'substitution' }[];
  readonly sentOff: boolean;
}

interface LogEntry {
  readonly eventId: string;
  readonly action: YourManAction;
  readonly footballerId: string;
  readonly ownerIds: readonly string[];
  readonly target: 'self' | 'others';
  readonly minute: number;
  readonly extraMinute: number | null;
}

interface PublicPayload {
  readonly kind: 'YOUR_MAN';
  readonly homeTeamId: string;
  readonly awayTeamId: string;
  readonly clockKnown: boolean;
  readonly matchClock: { readonly minute: number; readonly extraMinute: number | null } | null;
  readonly sips: Partial<Record<YourManAction, number>>;
  readonly roster: readonly RosterEntry[];
  readonly draft: readonly DraftEntry[];
  readonly log: readonly LogEntry[];
}

interface Solution {
  readonly status: 'running' | 'ended' | 'void';
  readonly endedBy: 'FULL_TIME' | 'MATCH_OVER' | null;
}

interface SummaryPlayer {
  readonly playerId: string;
  readonly chain: readonly string[];
  readonly sentOff: boolean;
  readonly good: number;
  readonly bad: number;
  readonly net: number;
}

const POSITION: Record<string, string> = { GK: 'Goalkeeper', DF: 'Defender', MF: 'Midfielder', FW: 'Forward', UNKNOWN: 'Player' };

const ENDED_COPY: Record<string, string> = {
  FULL_TIME: 'Full time. The men have done their worst.',
  MATCH_OVER: 'The match was already over when this round opened.',
  HOST: 'The host called the round.',
};

/** What each action costs, as the sip table: bad things drink the owner, good things everyone else. */
const SELF_ROWS: readonly (readonly [YourManAction, string])[] = [
  ['FOUL', 'Fouls'],
  ['MISS', 'Misses (shot off target, missed penalty)'],
  ['YELLOW', 'Yellow card'],
  ['RED', 'Red card'],
  ['OWN_GOAL', 'Own goal'],
];
const OTHER_ROWS: readonly (readonly [YourManAction, string])[] = [
  ['GOAL', 'Scores'],
  ['ASSIST', 'Assists'],
];

const namesOf = (payload: PublicPayload) => {
  const nameOf = (footballerId: string | null): string =>
    footballerId === null ? 'Nobody' : (payload.roster.find((entry) => entry.footballerId === footballerId)?.name ?? 'A player');
  const entryOf = (footballerId: string | null): RosterEntry | undefined =>
    footballerId === null ? undefined : payload.roster.find((entry) => entry.footballerId === footballerId);
  return { nameOf, entryOf };
};

const SipTable = ({ payload }: { readonly payload: PublicPayload }): React.JSX.Element => (
  <Card>
    <Eyebrow className="mb-2">What makes people drink</Eyebrow>
    <div className="split-cols gap-3 [--split-min:14rem]">
      <div>
        <p className="t-sm mb-1.5 font-semibold text-fg-muted">Your man does this, you drink</p>
        <ul className="flex flex-col gap-1.5">
          {SELF_ROWS.filter(([action]) => (payload.sips[action] ?? 0) > 0).map(([action, label]) => (
            <li key={action} className="flex flex-wrap items-baseline justify-between gap-x-2 rounded-md bg-hover px-3 py-2">
              <span className="max-w-full flex-1 basis-24">{label}</span>
              <span className="tnum ml-auto whitespace-nowrap font-bold text-accent">{drinkActionLabel(payload.sips[action] ?? 0)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="t-sm mb-1.5 font-semibold text-fg-muted">Your man does this, everyone else drinks</p>
        <ul className="flex flex-col gap-1.5">
          {OTHER_ROWS.filter(([action]) => (payload.sips[action] ?? 0) > 0).map(([action, label]) => (
            <li key={action} className="flex flex-wrap items-baseline justify-between gap-x-2 rounded-md bg-hover px-3 py-2">
              <span className="max-w-full flex-1 basis-24">{label}</span>
              <span className="tnum ml-auto whitespace-nowrap font-bold text-accent">{drinkActionLabel(payload.sips[action] ?? 0)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  </Card>
);

const ActionLog = ({
  room,
  payload,
  emptyText,
}: {
  readonly room: GameScreenProps['room'];
  readonly payload: PublicPayload;
  readonly emptyText: string;
}): React.JSX.Element => {
  const { nameOf } = namesOf(payload);
  const entries = payload.log.slice().reverse();
  return (
    <Card>
      <Eyebrow className="mb-2">Action log ({entries.length})</Eyebrow>
      {entries.length === 0 ? (
        <p role="status" className="t-body text-fg-muted">
          {emptyText}
        </p>
      ) : (
        <ol className="flex flex-col gap-2" aria-live="polite">
          {entries.map((entry, index) => (
            <li
              key={`${entry.eventId}-${entry.action}-${index}`}
              className={`rounded-md border-2 px-3 py-3 ${
                entry.target === 'others' ? 'border-up/60 bg-up/10' : 'border-accent/50 bg-selected'
              }`}
            >
              <p className="t-h3 max-w-full">
                {yourManLine(
                  entry.action,
                  nameOf(entry.footballerId),
                  entry.ownerIds.map((id) => nicknameOf(room, id)),
                  entry.target,
                  payload.sips[entry.action] ?? 0,
                )}
              </p>
              <p className="t-sm tnum text-fg-muted">{minuteLabel(entry.minute, entry.extraMinute)}</p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
};

const Chain = ({
  payload,
  entry,
}: {
  readonly payload: PublicPayload;
  readonly entry: DraftEntry;
}): React.JSX.Element => {
  const { nameOf } = namesOf(payload);
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1" aria-label="Your men, in order">
      {entry.chain.map((link, index) => (
        <li key={`${link.footballerId}-${index}`} className="flex items-center gap-2">
          {index > 0 ? (
            <span aria-hidden className="text-fg-muted">
              →
            </span>
          ) : null}
          <span
            className={`rounded-full border px-3 py-0.5 text-sm font-semibold ${
              index === entry.chain.length - 1 && !entry.sentOff ? 'border-accent text-accent' : 'border-border text-fg-muted'
            }`}
          >
            {nameOf(link.footballerId)}
            {link.via === 'substitution' ? <span className="t-xs"> (sub)</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
};

export const M4YourMan = ({ room, round, now }: GameScreenProps): React.JSX.Element => {
  const payload = round.publicPayload as PublicPayload;
  const { nameOf, entryOf } = namesOf(payload);
  const mine = payload.draft.find((entry) => entry.playerId === room.viewerId) ?? null;
  const teamName = (teamId: string | undefined): string =>
    teamId === payload.homeTeamId
      ? (room.currentFixture?.homeTeam.name ?? 'Home')
      : teamId === payload.awayTeamId
        ? (room.currentFixture?.awayTeam.name ?? 'Away')
        : '';

  const manCard = (entry: DraftEntry): React.JSX.Element => {
    const man = entryOf(entry.current);
    return (
      <Card className="lg:p-6">
        <Eyebrow>Your man</Eyebrow>
        {entry.sentOff ? (
          <>
            <p className="t-score mt-1 text-down">Sent off</p>
            <p className="t-body mt-1 text-fg-muted">
              {nameOf(entry.chain[entry.chain.length - 1]?.footballerId ?? null)} is off, and you have nobody for the rest of
              the match. You still drink when other people&apos;s men score.
            </p>
          </>
        ) : (
          <>
            <p className="t-score mt-1 text-accent">{nameOf(entry.current)}</p>
            <p className="t-body mt-1 text-fg-muted">
              {[teamName(man?.teamId), man === undefined ? '' : (POSITION[man.position] ?? 'Player')].filter((part) => part.length > 0).join(' · ')}
            </p>
          </>
        )}
        {entry.chain.length > 1 ? (
          <div className="mt-3">
            <p className="t-eyebrow mb-1.5">Your men so far</p>
            <Chain payload={payload} entry={entry} />
          </div>
        ) : null}
      </Card>
    );
  };

  const table = (
    <Card>
      <Eyebrow className="mb-2">Everyone&apos;s man</Eyebrow>
      <ul className="split-cols gap-2 [--split-min:13rem]">
        {payload.draft.map((entry) => {
          const isMe = entry.playerId === room.viewerId;
          return (
            <li
              key={entry.playerId}
              className={`rounded-md border-2 px-3 py-3 ${isMe ? 'border-accent bg-selected' : 'border-transparent bg-hover'}`}
            >
              <p className="max-w-full font-semibold">
                {nicknameOf(room, entry.playerId)}
                {isMe ? ' (you)' : ''}
              </p>
              <p className={`t-sm max-w-full ${entry.sentOff ? 'text-down' : 'text-fg-muted'}`}>
                {entry.sentOff ? 'Sent off' : nameOf(entry.current)}
                {entry.chain.length > 1 ? ` · ${entry.chain.length} men` : ''}
              </p>
            </li>
          );
        })}
      </ul>
    </Card>
  );

  if (round.visibility === 'revealed') {
    const solution = round.solution as Solution;
    const summary = (round.outcome?.summary as { endedBy?: string; players?: readonly SummaryPlayer[] } | null | undefined) ?? null;
    const players = summary?.players ?? [];
    const winnerIds: readonly string[] = round.outcome?.winnerIds ?? [];
    const endedBy = solution.status === 'void' ? solution.endedBy : (solution.endedBy ?? summary?.endedBy ?? null);
    const totals = new Map<string, number>();
    for (const penalty of round.penalties) totals.set(penalty.recipientId, (totals.get(penalty.recipientId) ?? 0) + penalty.appliedSips);
    return (
      <RoundShell title="Your Man" round={round} room={room} now={now} split showAnswered={false}>
        <div className="flex flex-col gap-4">
          <Card>
            <Eyebrow>{solution.status === 'void' ? 'Round void' : 'Round over'}</Eyebrow>
            <p className="t-d2 mt-1">{ENDED_COPY[endedBy ?? 'HOST'] ?? ENDED_COPY.HOST}</p>
          </Card>
          <Card>
            <Eyebrow className="mb-2">How each man did</Eyebrow>
            <ul className="flex flex-col gap-3">
              {(players.length > 0 ? players : payload.draft.map((entry) => ({ playerId: entry.playerId, chain: entry.chain.map((link) => link.footballerId), sentOff: entry.sentOff, good: 0, bad: 0, net: 0 }))).map((player) => (
                <li key={player.playerId} className="rounded-md bg-hover px-3 py-3">
                  <p className="flex flex-wrap items-baseline justify-between gap-x-2 font-bold">
                    <span className="max-w-full">
                      {nicknameOf(room, player.playerId)}
                      {winnerIds.includes(player.playerId) ? <span className="t-xs text-up"> · best man</span> : null}
                    </span>
                    <span className="tnum whitespace-nowrap text-accent">
                      {player.net > 0 ? '+' : ''}
                      {player.net}
                    </span>
                  </p>
                  <p className="t-sm mt-1 max-w-full text-fg-muted">
                    {player.chain.map((id) => nameOf(id)).join(' → ')}
                    {player.sentOff ? ' (sent off)' : ''}
                  </p>
                  <p className="t-sm tnum text-fg-muted">
                    {player.good} good · {player.bad} bad
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          <ActionLog room={room} payload={payload} emptyText="Nobody's man did anything notable." />
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
  return (
    <RoundShell title="Your Man" round={round} room={room} now={now} showAnswered={false}>
      <div className="split-cols gap-4 lg:items-start lg:gap-6 land:items-start [--split-min:20rem]">
        <div className="flex flex-col gap-4">
          {mine !== null ? (
            manCard(mine)
          ) : (
            <Card>
              <Eyebrow>No man for you</Eyebrow>
              <p className="t-body mt-1 text-fg-muted">
                You joined after the draft. You still drink whenever someone else&apos;s man scores.
              </p>
            </Card>
          )}
          <p className="t-body text-center text-fg-muted">
            Match clock <strong className="tnum text-fg">{payload.clockKnown && clockText !== null ? clockText : 'waiting…'}</strong>
          </p>
          <SipTable payload={payload} />
        </div>
        <div className="flex flex-col gap-4">
          <ActionLog room={room} payload={payload} emptyText="Quiet so far. Watch your man." />
          {table}
        </div>
      </div>
    </RoundShell>
  );
};
