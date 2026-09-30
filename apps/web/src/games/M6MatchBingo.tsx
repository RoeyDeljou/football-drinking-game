import { useEffect, useRef, useState } from 'react';
import { RoundShell } from '@/components/RoundShell';
import { Card, Eyebrow } from '@/components/ui';
import { bingoFullHouseCall, bingoLineCall, roundDrinkTotalLine } from '@/lib/drinkCopy';
import { bingoCellLabel, minuteLabel, type LiveEventKind } from '@/lib/liveEventCopy';
import { nicknameOf } from '@/lib/roomHelpers';
import type { GameScreenProps } from './types';

interface Cell {
  readonly id: string;
  readonly event: LiveEventKind;
  readonly side: 'home' | 'away' | null;
  readonly count: number;
  readonly progress: number;
  readonly ticked: boolean;
  readonly tickedAt: { readonly minute: number; readonly extraMinute: number | null } | null;
}

interface Card_ {
  readonly playerId: string;
  readonly cells: readonly Cell[];
  readonly lines: readonly string[];
  readonly fullHouse: boolean;
}

interface PublicPayload {
  readonly kind: 'MATCH_BINGO';
  readonly size: 3 | 4;
  readonly lineSips: number;
  readonly fullHouseSips: number;
  readonly clockKnown: boolean;
  readonly matchClock: { readonly minute: number; readonly extraMinute: number | null } | null;
  readonly cards: readonly Card_[];
}

interface Solution {
  readonly status: 'running' | 'ended' | 'void';
  readonly endedBy: 'FULL_HOUSE' | 'FULL_TIME' | 'MATCH_OVER' | null;
  readonly fullHouseIds: readonly string[];
}

const ENDED_COPY: Record<string, string> = {
  FULL_HOUSE: 'Full house ended the round.',
  FULL_TIME: 'Full time ended the round.',
  MATCH_OVER: 'The match was already over when this round opened.',
  HOST: 'The host called the round.',
};

/** Which cell indexes a completed line id covers, only to highlight it (the engine decides completion). */
const lineCells = (size: number, id: string): readonly number[] => {
  const range = Array.from({ length: size }, (_, index) => index);
  const [kind, at] = id.split('-');
  const n = Number(at);
  if (kind === 'row') return range.map((col) => n * size + col);
  if (kind === 'col') return range.map((row) => row * size + n);
  if (id === 'diag-main') return range.map((index) => index * size + index);
  if (id === 'diag-anti') return range.map((index) => index * size + (size - 1 - index));
  return [];
};

const litCells = (card: Card_, size: number): ReadonlySet<number> => {
  const lit = new Set<number>();
  for (const line of card.lines) for (const index of lineCells(size, line)) lit.add(index);
  return lit;
};

const teamNamesOf = (room: GameScreenProps['room']): { home: string; away: string } => ({
  home: room.currentFixture?.homeTeam.name ?? 'Home',
  away: room.currentFixture?.awayTeam.name ?? 'Away',
});

const Legend = ({ teams }: { readonly teams: { home: string; away: string } }): React.JSX.Element => (
  <p className="t-sm mb-3 text-fg-muted">
    <span className="font-semibold text-fg">Home</span> {teams.home} · <span className="font-semibold text-fg">Away</span> {teams.away}
  </p>
);

const BigCard = ({ card, size }: { readonly card: Card_; readonly size: number }): React.JSX.Element => {
  const lit = litCells(card, size);
  return (
    <ol
      className="grid gap-2 lg:gap-3"
      style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}
      aria-label="Your bingo card"
    >
      {card.cells.map((cell, index) => {
        // Cells say Home / Away (a club name would not fit a small square); the card's legend names them.
        const label = bingoCellLabel(cell.event, cell.count, cell.side === null ? null : cell.side === 'home' ? 'Home' : 'Away');
        return (
          <li
            key={`${cell.id}-${index}`}
            className={`flex min-h-24 flex-col justify-between gap-1 rounded-md border-2 p-2 text-center sm:p-3 lg:min-h-32 ${
              cell.ticked
                ? lit.has(index)
                  ? 'border-accent bg-accent text-accent-fg'
                  : 'border-up bg-up/20 text-fg'
                : 'border-border bg-card text-fg'
            }`}
          >
            <span className="text-[min(0.9rem,3.6vw)] font-bold leading-tight sm:text-base lg:text-lg">{label}</span>
            <span className="tnum text-sm font-black">
              {cell.ticked ? (
                <>
                  <span aria-hidden>✓ </span>
                  <span className="sr-only">Ticked </span>
                  {cell.tickedAt !== null ? minuteLabel(cell.tickedAt.minute, cell.tickedAt.extraMinute) : ''}
                </>
              ) : cell.count > 1 ? (
                `${cell.progress}/${cell.count}`
              ) : (
                <span className="opacity-60">waiting</span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
};

const MiniCard = ({ card, size }: { readonly card: Card_; readonly size: number }): React.JSX.Element => {
  const lit = litCells(card, size);
  return (
    <div
      className="grid gap-1"
      style={{ gridTemplateColumns: `repeat(${size}, 1.25rem)` }}
      role="img"
      aria-label={`${card.cells.filter((cell) => cell.ticked).length} of ${card.cells.length} ticked`}
    >
      {card.cells.map((cell, index) => (
        <span
          key={`${cell.id}-${index}`}
          className={`h-5 w-5 rounded-sm border ${
            cell.ticked ? (lit.has(index) ? 'border-accent bg-accent' : 'border-up bg-up/60') : 'border-border-strong bg-transparent'
          }`}
        />
      ))}
    </div>
  );
};

interface Call {
  readonly key: number;
  readonly text: string;
  readonly big: boolean;
}

export const M6MatchBingo = ({ room, round, now }: GameScreenProps): React.JSX.Element => {
  const payload = round.publicPayload as PublicPayload;
  const teams = teamNamesOf(room);
  const size = payload.size;
  const mine = payload.cards.find((card) => card.playerId === room.viewerId) ?? null;
  const others = payload.cards.filter((card) => card.playerId !== room.viewerId);

  // Line / full-house celebrations: fired when a card's counts go up between two payloads. The first
  // payload seen (join, reconnect, reload) only sets the baseline, so old lines are never replayed.
  const seen = useRef<Map<string, { lines: number; fullHouse: boolean }> | null>(null);
  const callKey = useRef(0);
  const [call, setCall] = useState<Call | null>(null);
  useEffect(() => {
    const previous = seen.current;
    const next = new Map(payload.cards.map((card) => [card.playerId, { lines: card.lines.length, fullHouse: card.fullHouse }]));
    seen.current = next;
    if (previous === null) return;
    for (const card of payload.cards) {
      const before = previous.get(card.playerId);
      if (before === undefined) continue;
      const name = nicknameOf(room, card.playerId);
      if (card.fullHouse && !before.fullHouse) {
        callKey.current += 1;
        setCall({ key: callKey.current, text: bingoFullHouseCall(name, payload.fullHouseSips), big: true });
      } else if (card.lines.length > before.lines) {
        callKey.current += 1;
        setCall({ key: callKey.current, text: bingoLineCall(name, payload.lineSips), big: false });
      }
    }
    // Only card progress drives calls; `room` is read for nicknames at that moment.
  }, [payload.cards]);

  if (round.visibility === 'revealed') {
    const solution = round.solution as Solution;
    const summaryEnd = (round.outcome?.summary as { endedBy?: string } | null | undefined)?.endedBy;
    const endedBy = solution.endedBy ?? summaryEnd ?? 'HOST';
    const winnerIds: readonly string[] = round.outcome?.winnerIds ?? [];
    const totals = new Map<string, number>();
    for (const penalty of round.penalties) {
      totals.set(penalty.recipientId, (totals.get(penalty.recipientId) ?? 0) + penalty.appliedSips);
    }
    const ranked = payload.cards
      .slice()
      .sort((a, b) => Number(b.fullHouse) - Number(a.fullHouse) || b.lines.length - a.lines.length);
    return (
      <RoundShell title="Match Bingo" round={round} room={room} now={now} split showAnswered={false}>
        <div className="flex flex-col gap-4">
          <Card>
            <Eyebrow>{solution.status === 'void' ? 'Round void' : 'Round over'}</Eyebrow>
            <p className="t-d2 mt-1">{ENDED_COPY[endedBy] ?? ENDED_COPY.HOST}</p>
            {solution.fullHouseIds.length > 0 ? (
              <p className="t-h3 mt-1 text-accent">
                Full house: {solution.fullHouseIds.map((id) => nicknameOf(room, id)).join(' and ')}
              </p>
            ) : null}
          </Card>
          {mine !== null ? (
            <Card>
              <Eyebrow className="mb-2">Your card</Eyebrow>
              <Legend teams={teams} />
              <BigCard card={mine} size={size} />
            </Card>
          ) : null}
        </div>
        <div className="flex flex-col gap-4">
          <Card>
            <Eyebrow className="mb-2">Every card</Eyebrow>
            <ul className="flex flex-col gap-2">
              {ranked.map((card) => (
                <li key={card.playerId} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-hover px-3 py-3">
                  <MiniCard card={card} size={size} />
                  <span className="max-w-full flex-1 basis-28 font-semibold">
                    {nicknameOf(room, card.playerId)}
                    {winnerIds.includes(card.playerId) ? <span className="t-xs text-up"> · winner</span> : null}
                    <span className="t-sm block font-normal text-fg-muted">
                      {card.cells.filter((cell) => cell.ticked).length}/{card.cells.length} ticked ·{' '}
                      {card.fullHouse ? 'full house' : `${card.lines.length} ${card.lines.length === 1 ? 'line' : 'lines'}`}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
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

  if (!payload.clockKnown) {
    return (
      <RoundShell title="Match Bingo" round={round} room={room} now={now} showAnswered={false}>
        <Card className="text-center">
          <p role="status" aria-live="polite" className="t-d2">
            Waiting for the match clock…
          </p>
          <p className="t-body mt-2 text-fg-muted">Cards start ticking as soon as we know what minute it is.</p>
        </Card>
      </RoundShell>
    );
  }

  return (
    <RoundShell title="Match Bingo" round={round} room={room} now={now} showAnswered={false}>
      {call !== null ? (
        <div
          key={call.key}
          role="status"
          aria-live="assertive"
          className={`call-pop rounded-lg border-2 border-accent bg-selected px-4 py-3 text-center ${call.big ? 't-d2' : 't-h3'}`}
        >
          {call.text}
        </div>
      ) : null}
      <div className="split-cols gap-4 lg:items-start lg:gap-6 land:items-start [--split-min:20rem]">
        <Card className="lg:p-6">
          <div className="t-body mb-3 flex flex-wrap items-baseline justify-between gap-x-3">
            <Eyebrow>{mine !== null ? 'Your card' : 'No card for you'}</Eyebrow>
            <span className="whitespace-nowrap text-fg-muted">
              Match clock{' '}
              <strong className="tnum text-fg">
                {payload.matchClock !== null ? minuteLabel(payload.matchClock.minute, payload.matchClock.extraMinute) : 'not started'}
              </strong>
            </span>
          </div>
          {mine !== null ? (
            <>
              <Legend teams={teams} />
              <BigCard card={mine} size={size} />
              <p className="t-sm mt-3 text-center text-fg-muted">
                {mine.cells.filter((cell) => cell.ticked).length}/{mine.cells.length} ticked ·{' '}
                {mine.lines.length} {mine.lines.length === 1 ? 'line' : 'lines'}. A line makes everyone else drink.
              </p>
            </>
          ) : (
            <p className="t-body text-fg-muted">You joined after the cards were dealt. Cheer on the table.</p>
          )}
        </Card>
        <Card>
          <Eyebrow className="mb-2">{mine !== null ? 'Everyone else' : 'The table'}</Eyebrow>
          <ul className="flex flex-col gap-2">
            {(mine !== null ? others : payload.cards).map((card) => (
              <li key={card.playerId} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-hover px-3 py-3">
                <MiniCard card={card} size={size} />
                <span className="max-w-full flex-1 basis-28 font-semibold">
                  {nicknameOf(room, card.playerId)}
                  <span className="t-sm block font-normal text-fg-muted">
                    {card.cells.filter((cell) => cell.ticked).length}/{card.cells.length} ·{' '}
                    {card.fullHouse ? 'full house' : `${card.lines.length} ${card.lines.length === 1 ? 'line' : 'lines'}`}
                  </span>
                </span>
              </li>
            ))}
            {(mine !== null ? others : payload.cards).length === 0 ? (
              <li className="t-body text-fg-muted">Just you at the table.</li>
            ) : null}
          </ul>
        </Card>
      </div>
    </RoundShell>
  );
};
