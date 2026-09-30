import { useState } from 'react';
import { RoundShell } from '@/components/RoundShell';
import { Card, Eyebrow, OptionButton } from '@/components/ui';
import { duelLostLine, roundDrinkTotalLine } from '@/lib/drinkCopy';
import { minuteLabel } from '@/lib/liveEventCopy';
import { nicknameOf } from '@/lib/roomHelpers';
import { statLabel, statNoun, type DuelStat } from '@/lib/statCopy';
import type { GameScreenProps } from './types';

type Position = 'GK' | 'DF' | 'MF' | 'FW' | 'UNKNOWN';

interface Option {
  readonly footballerId: string;
  readonly name: string;
  readonly teamId: string;
  readonly position: Position;
}

interface PublicPayload {
  readonly kind: 'STAT_DUEL';
  readonly homeTeamId: string;
  readonly awayTeamId: string;
  readonly duelSips: number;
  readonly options: readonly Option[];
  readonly seeds: readonly string[];
  readonly levelStats: readonly DuelStat[];
  readonly clockKnown: boolean;
  readonly matchClock: { readonly minute: number; readonly extraMinute: number | null } | null;
  readonly whistle: boolean;
}

interface Duel {
  readonly level: number;
  readonly stat: DuelStat;
  readonly playerA: string;
  readonly playerB: string;
  readonly valueA: number;
  readonly valueB: number;
  readonly decidedBy: DuelStat | null;
  readonly winnerId: string;
  readonly loserId: string | null;
}

interface StatLine {
  readonly footballerId: string;
  readonly SHOTS: number;
  readonly SHOTS_ON_TARGET: number;
  readonly GOAL_INVOLVEMENTS: number;
  readonly FEWEST_FOULS: number;
}

interface Summary {
  readonly status: 'settled' | 'void';
  readonly endedBy: string | null;
  readonly picks: readonly { readonly playerId: string; readonly footballerId: string; readonly defaulted: boolean }[];
  readonly duels: readonly Duel[];
  readonly championId: string | null;
  readonly lines: readonly StatLine[];
}

const asSummary = (value: unknown): Summary | null => {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<Summary>;
  return Array.isArray(candidate.duels) && Array.isArray(candidate.picks) ? (candidate as Summary) : null;
};

const POSITIONS: readonly (readonly [Position | 'ALL', string])[] = [
  ['ALL', 'All'],
  ['GK', 'GK'],
  ['DF', 'DF'],
  ['MF', 'MF'],
  ['FW', 'FW'],
];

const POSITION_NAME: Record<Position, string> = { GK: 'Goalkeeper', DF: 'Defender', MF: 'Midfielder', FW: 'Forward', UNKNOWN: 'Player' };

const ENDED_COPY: Record<string, string> = {
  FULL_TIME: 'Full time settled the bracket.',
  HOST: 'The host called it early, on the stats so far.',
  MATCH_OVER: 'The match was already over when this round opened.',
  NO_PLAY: 'The whistle came before there was anything to measure.',
};

/** Accent- and case-insensitive text for the search box. */
const plain = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

type Slot = { readonly kind: 'player'; readonly id: string } | { readonly kind: 'winner'; readonly level: number; readonly duel: number };

/** The bracket's shape, mirroring how the engine pairs (1v2, 3v4, odd one out gets a bye). Display only. */
const bracketOf = (seeds: readonly string[], stats: readonly DuelStat[]) => {
  let slots: Slot[] = seeds.map((id) => ({ kind: 'player', id }));
  const levels: { level: number; stat: DuelStat; duels: { a: Slot; b: Slot }[]; bye: Slot | null }[] = [];
  for (let level = 0; slots.length > 1 && level < 8; level += 1) {
    const duels: { a: Slot; b: Slot }[] = [];
    const next: Slot[] = [];
    let bye: Slot | null = null;
    for (let index = 0; index < slots.length; index += 2) {
      const a = slots[index];
      const b = slots[index + 1];
      if (a === undefined) continue;
      if (b === undefined) {
        bye = a;
        continue;
      }
      duels.push({ a, b });
      next.push({ kind: 'winner', level: level + 1, duel: duels.length });
    }
    if (bye !== null) next.push(bye);
    levels.push({ level: level + 1, stat: stats[level % stats.length] ?? 'SHOTS', duels, bye });
    slots = next;
  }
  return levels;
};

const Bracket = ({ room, payload }: { readonly room: GameScreenProps['room']; readonly payload: PublicPayload }): React.JSX.Element => {
  const levels = bracketOf(payload.seeds, payload.levelStats);
  const slotName = (slot: Slot): string =>
    slot.kind === 'player'
      ? `${nicknameOf(room, slot.id)}${slot.id === room.viewerId ? ' (you)' : ''}`
      : `Winner of round ${slot.level}, duel ${slot.duel}`;
  return (
    <Card>
      <Eyebrow className="mb-2">The bracket</Eyebrow>
      <ol className="flex flex-col gap-3">
        {levels.map((level) => (
          <li key={level.level}>
            <p className="t-h3 mb-1.5">
              Round {level.level} <span className="text-accent">· {statLabel(level.stat)}</span>
            </p>
            <ul className="flex flex-col gap-1.5">
              {level.duels.map((duel, index) => (
                <li key={index} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-hover px-3 py-2">
                  <span className="max-w-full flex-1 basis-24 font-semibold">{slotName(duel.a)}</span>
                  <span className="t-xs text-fg-muted">vs</span>
                  <span className="max-w-full flex-1 basis-24 font-semibold">{slotName(duel.b)}</span>
                </li>
              ))}
              {level.bye !== null ? (
                <li className="t-sm rounded-md px-3 py-1 text-fg-muted">{slotName(level.bye)} has a bye</li>
              ) : null}
            </ul>
          </li>
        ))}
      </ol>
    </Card>
  );
};

export const M8StatDuel = ({ room, round, now, onSubmit }: GameScreenProps): React.JSX.Element => {
  const payload = round.publicPayload as PublicPayload;
  const nameOf = (footballerId: string): string =>
    payload.options.find((option) => option.footballerId === footballerId)?.name ?? 'A player';
  const teamOf = (teamId: string): string =>
    teamId === payload.homeTeamId
      ? (room.currentFixture?.homeTeam.name ?? 'Home')
      : (room.currentFixture?.awayTeam.name ?? 'Away');

  const [query, setQuery] = useState('');
  const [team, setTeam] = useState<'all' | 'home' | 'away'>('all');
  const [position, setPosition] = useState<Position | 'ALL'>('ALL');
  const [pending, setPending] = useState<string | null>(null);

  const inBracket = room.viewerId !== null && payload.seeds.includes(room.viewerId);
  const yourPick = (round.yourSubmission as { footballerId: string } | null)?.footballerId ?? null;
  const defaultPick = (round.privatePayload as { defaultPick: string } | null)?.defaultPick ?? null;

  if (round.visibility === 'revealed') {
    const summary = asSummary(round.outcome?.summary);
    const totals = new Map<string, number>();
    for (const penalty of round.penalties) totals.set(penalty.recipientId, (totals.get(penalty.recipientId) ?? 0) + penalty.appliedSips);
    if (summary === null || summary.status === 'void') {
      return (
        <RoundShell title="Stat Duel" round={round} room={room} now={now} showAnswered={false}>
          <Card>
            <Eyebrow>Round void</Eyebrow>
            <p className="t-d2 mt-1">{ENDED_COPY[summary?.endedBy ?? 'NO_PLAY'] ?? ENDED_COPY.NO_PLAY}</p>
            <p className="t-body mt-2 text-fg-muted">No duels, no points, no drinks.</p>
          </Card>
        </RoundShell>
      );
    }
    const pickOf = (playerId: string) => summary.picks.find((entry) => entry.playerId === playerId);
    const sipsFor = (duel: Duel): number =>
      round.penalties.find((entry) => entry.recipientId === duel.loserId && (entry.meta as { level?: number } | null)?.level === duel.level)
        ?.appliedSips ?? payload.duelSips;
    return (
      <RoundShell title="Stat Duel" round={round} room={room} now={now} split showAnswered={false}>
        <div className="flex flex-col gap-4">
          {summary.championId !== null ? (
            <Card className="text-center">
              <Eyebrow>Champion</Eyebrow>
              <p className="t-score mt-1 max-w-full text-accent">{nicknameOf(room, summary.championId)}</p>
              <p className="t-body mt-1 text-fg-muted">
                {pickOf(summary.championId) !== undefined ? `with ${nameOf(pickOf(summary.championId)?.footballerId ?? '')}` : ''}
                {' · '}
                {ENDED_COPY[summary.endedBy ?? 'FULL_TIME'] ?? ''}
              </p>
            </Card>
          ) : null}
          {summary.duels.map((duel, index) => {
            const sideOf = (playerId: string, value: number): React.JSX.Element => {
              const pick = pickOf(playerId);
              const won = duel.winnerId === playerId;
              return (
                <div
                  className={`min-w-0 max-w-full flex-1 basis-[9rem] rounded-md border-2 px-3 py-2 ${
                    duel.loserId === null ? 'border-border bg-hover' : won ? 'border-up bg-up/15' : 'border-down/50 bg-down/10'
                  }`}
                >
                  <p className="max-w-full font-bold">{nicknameOf(room, playerId)}</p>
                  <p className="t-sm max-w-full text-fg-muted">
                    {pick === undefined ? '' : nameOf(pick.footballerId)}
                    {pick?.defaulted === true ? ' (dealt)' : ''}
                  </p>
                  <p className="t-d2 tnum">{value}</p>
                </div>
              );
            };
            const loser = duel.loserId;
            const winner = duel.winnerId;
            return (
              <Card key={index}>
                <Eyebrow className="mb-2">
                  Round {duel.level} · {statLabel(duel.stat)}
                </Eyebrow>
                <div className="flex flex-wrap items-stretch gap-2">
                  {sideOf(duel.playerA, duel.valueA)}
                  {sideOf(duel.playerB, duel.valueB)}
                </div>
                <p className="t-sm mt-2 text-fg-muted">
                  {duel.decidedBy === null
                    ? 'Dead level on every stat. The higher seed goes through and nobody drinks.'
                    : duel.decidedBy !== duel.stat
                      ? `Level on ${statNoun(duel.stat)}, settled on ${statNoun(duel.decidedBy)} (tie-break).`
                      : `Decided on ${statNoun(duel.stat)}.`}
                </p>
                {loser !== null ? (
                  <p className="t-body mt-1 font-semibold">
                    {duelLostLine(nicknameOf(room, loser), nicknameOf(room, winner), statLabel(duel.stat), sipsFor(duel))}
                  </p>
                ) : null}
              </Card>
            );
          })}
        </div>
        <div className="flex flex-col gap-4">
          <Card>
            <Eyebrow className="mb-2">Stat lines from full time</Eyebrow>
            <ul className="flex flex-col gap-2">
              {summary.lines.map((line) => (
                <li key={line.footballerId} className="rounded-md bg-hover px-3 py-3">
                  <p className="max-w-full font-bold">{nameOf(line.footballerId)}</p>
                  <p className="t-sm tnum text-fg-muted">
                    {line.SHOTS} shots · {line.SHOTS_ON_TARGET} on target · {line.GOAL_INVOLVEMENTS} goals + assists · {line.FEWEST_FOULS} fouls
                  </p>
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

  const windowOpen = round.deadlineAt !== null && now < round.deadlineAt;
  const clockText = payload.matchClock !== null ? minuteLabel(payload.matchClock.minute, payload.matchClock.extraMinute) : null;
  const shownPick = pending ?? yourPick;

  if (!windowOpen) {
    return (
      <RoundShell title="Stat Duel" round={round} room={room} now={now} countdown={false} showAnswered={false}>
        <Card className="text-center">
          <p className="t-body text-fg-muted">
            Match clock <strong className="tnum text-fg">{payload.clockKnown && clockText !== null ? clockText : 'waiting…'}</strong>
          </p>
          <p role="status" aria-live="polite" className="t-d2 mt-3">
            {payload.whistle ? 'Full time! Settling the duels…' : 'Picks are locked. Waiting for full time…'}
          </p>
          {inBracket ? (
            <p className="t-body mt-2 text-fg-muted">
              Your man: <strong className="text-fg">{nameOf(yourPick ?? defaultPick ?? '')}</strong>
              {yourPick === null ? ' (dealt to you)' : ''}. Picks stay secret until the reveal.
            </p>
          ) : (
            <p className="t-body mt-2 text-fg-muted">You joined after the bracket was drawn, so you watch this one.</p>
          )}
        </Card>
        <Bracket room={room} payload={payload} />
      </RoundShell>
    );
  }

  const q = plain(query.trim());
  const visible = payload.options.filter(
    (option) =>
      (team === 'all' || (team === 'home' ? option.teamId === payload.homeTeamId : option.teamId === payload.awayTeamId)) &&
      (position === 'ALL' || option.position === position) &&
      (q.length === 0 || plain(option.name).includes(q)),
  );
  const chip = (active: boolean): string =>
    `tap-target pressable rounded-full border-2 px-4 text-sm font-bold ${active ? 'border-accent bg-selected' : 'border-border bg-card'}`;

  return (
    <RoundShell title="Stat Duel" round={round} room={room} now={now} showAnswered={false}>
      <div className="split-cols gap-4 lg:items-start lg:gap-6 land:items-start [--split-min:20rem]">
        <Card className="lg:p-6">
          <Eyebrow className="mb-1">Pick your man</Eyebrow>
          {inBracket ? (
            <p role="status" className="t-body mb-3 text-fg-muted">
              {shownPick !== null ? (
                <>
                  Your pick: <strong className="text-fg">{nameOf(shownPick)}</strong>. Change it any time before the timer runs out.
                </>
              ) : defaultPick !== null ? (
                <>
                  You&apos;ll get <strong className="text-fg">{nameOf(defaultPick)}</strong> if you don&apos;t choose.
                </>
              ) : (
                'Choose a starter.'
              )}{' '}
              Picks stay secret until the reveal.
            </p>
          ) : (
            <p className="t-body mb-3 text-fg-muted">You joined after the bracket was drawn, so you watch this one.</p>
          )}
          <label className="block">
            <span className="sr-only">Search players</span>
            <input
              className="field-input"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search a player"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              name="player-filter"
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Team">
            {(
              [
                ['all', 'Both teams'],
                ['home', teamOf(payload.homeTeamId)],
                ['away', teamOf(payload.awayTeamId)],
              ] as const
            ).map(([value, label]) => (
              <button key={value} type="button" aria-pressed={team === value} onClick={() => setTeam(value)} className={`${chip(team === value)} max-w-full`}>
                {label}
              </button>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Position">
            {POSITIONS.map(([value, label]) => (
              <button key={value} type="button" aria-pressed={position === value} onClick={() => setPosition(value)} className={chip(position === value)}>
                {label}
              </button>
            ))}
          </div>
          <ul className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-2">
            {visible.map((option) => {
              const selected = shownPick === option.footballerId;
              return (
                <li key={option.footballerId} className="flex">
                  <OptionButton
                    selected={selected}
                    aria-pressed={selected}
                    disabled={!inBracket}
                    onClick={() => {
                      setPending(option.footballerId);
                      onSubmit({ footballerId: option.footballerId });
                    }}
                    className="flex min-h-16 w-full flex-col justify-center"
                  >
                    <span className="max-w-full">
                      {selected ? <span aria-hidden>✓ </span> : null}
                      {option.name}
                    </span>
                    <span className="t-xs max-w-full font-normal text-fg-muted">
                      {teamOf(option.teamId)} · {POSITION_NAME[option.position]}
                    </span>
                  </OptionButton>
                </li>
              );
            })}
          </ul>
          {visible.length === 0 ? <p className="t-body mt-3 text-fg-muted">No starters match that filter.</p> : null}
        </Card>
        <div className="flex flex-col gap-4">
          <Card className="text-center">
            <p className="t-body text-fg-muted">
              Match clock <strong className="tnum text-fg">{payload.clockKnown && clockText !== null ? clockText : 'waiting…'}</strong>
            </p>
            <p className="t-sm mt-1 text-fg-muted">Duels count from when picks lock to full time.</p>
          </Card>
          <Bracket room={room} payload={payload} />
        </div>
      </div>
    </RoundShell>
  );
};
