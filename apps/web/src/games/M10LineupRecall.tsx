import { useState } from 'react';
import { RevealFooter } from '@/components/RevealFooter';
import { RoundShell } from '@/components/RoundShell';
import { BigButton, Card, Eyebrow } from '@/components/ui';
import { nicknameOf } from '@/lib/roomHelpers';
import type { GameScreenProps } from './types';

type Line = 'GK' | 'DF' | 'MF' | 'FW' | 'UNKNOWN';

/** Attack at the top, keeper at the bottom: the XI reads like the pitch. */
const LINES: readonly Line[] = ['FW', 'MF', 'DF', 'GK', 'UNKNOWN'];
const LINE_LABEL: Record<Line, string> = {
  GK: 'Goalkeeper',
  DF: 'Defenders',
  MF: 'Midfielders',
  FW: 'Forwards',
  UNKNOWN: 'Position unknown',
};

interface TeamRef {
  readonly name: string;
}

interface PublicPayload {
  readonly kind: 'LINEUP_RECALL';
  readonly side: 'home' | 'away';
  readonly team: TeamRef;
  readonly opponent: TeamRef;
  readonly formation: string | null;
  readonly slots: number;
  readonly shape: Record<Line, number>;
  readonly maxGuesses: number;
}

interface Starter {
  readonly playerId: string;
  readonly name: string;
  readonly position: Line;
}

interface Solution {
  readonly starters: readonly Starter[];
}

type GuessStatus = 'matched' | 'duplicate' | 'decoy' | 'unknown';

interface SummaryStarter {
  readonly playerId: string;
  readonly foundBy: readonly string[];
}

interface SummaryPlayer {
  readonly playerId: string;
  readonly found: number;
  readonly guesses: readonly { readonly guess: string; readonly status: GuessStatus }[];
}

interface Summary {
  readonly slots: number;
  readonly bestFound: number;
  readonly starters: readonly SummaryStarter[];
  readonly players: readonly SummaryPlayer[];
}

/** The engine's reveal summary is `unknown` on the wire; read only the fields this screen shows. */
const asSummary = (value: unknown): Summary | null => {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<Summary>;
  if (!Array.isArray(candidate.starters) || !Array.isArray(candidate.players)) return null;
  return candidate as Summary;
};

const STATUS_LABEL: Record<GuessStatus, string> = {
  matched: 'found',
  duplicate: 'already had',
  decoy: 'not in the XI',
  unknown: 'no match',
};

const STATUS_STYLE: Record<GuessStatus, string> = {
  matched: 'border-up bg-up/15 text-fg',
  duplicate: 'border-warn/60 bg-warn/10 text-fg',
  decoy: 'border-down/60 bg-down/10 text-fg',
  unknown: 'border-border bg-hover text-fg-muted',
};

/** The formation as a glanceable pitch: one row of rings per position line, no names. */
const ShapeDiagram = ({ shape }: { readonly shape: Record<Line, number> }): React.JSX.Element => (
  <ul className="flex flex-col gap-2" aria-label="Starters per position">
    {LINES.filter((line) => shape[line] > 0).map((line) => (
      <li key={line} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md bg-hover px-3 py-2">
        <span className="t-sm font-semibold text-fg-muted">
          {LINE_LABEL[line]} · {shape[line]}
        </span>
        <span className="flex flex-wrap justify-end gap-1.5" aria-hidden>
          {Array.from({ length: shape[line] }, (_, index) => (
            <span key={index} className="h-5 w-5 rounded-full border-2 border-accent/70" />
          ))}
        </span>
      </li>
    ))}
  </ul>
);

const TeamHeading = ({ payload }: { readonly payload: PublicPayload }): React.JSX.Element => (
  <div>
    <Eyebrow>{payload.side === 'home' ? 'Home XI' : 'Away XI'}</Eyebrow>
    <p className="t-d1 mt-1">{payload.team.name || 'This team'}</p>
    <p className="t-body text-fg-muted">
      vs {payload.opponent.name || 'the opposition'}
      {payload.formation !== null ? ` · ${payload.formation}` : ''}
    </p>
  </div>
);

export const M10LineupRecall = ({ room, round, now, onSubmit }: GameScreenProps): React.JSX.Element => {
  const payload = round.publicPayload as PublicPayload;
  const submitted = (round.yourSubmission as { guesses: readonly string[] } | null)?.guesses ?? null;
  const [draft, setDraft] = useState('');
  const [names, setNames] = useState<readonly string[]>([]);

  if (round.visibility === 'revealed') {
    const solution = round.solution as Solution;
    const summary = asSummary(round.outcome?.summary);
    return (
      <RoundShell title="Lineup Recall" round={round} room={room} now={now} split>
        <Card className="lg:p-6">
          <Eyebrow className="mb-1">
            {payload.team.name || 'The XI'}
            {payload.formation !== null ? ` · ${payload.formation}` : ''}
          </Eyebrow>
          <p className="t-body mb-3 text-fg-muted">
            {summary === null ? 'The starting XI.' : `Best table score: ${summary.bestFound} of ${summary.slots}.`}
          </p>
          <div className="flex flex-col gap-3">
            {LINES.map((line) => {
              const inLine = solution.starters.filter((starter) => starter.position === line);
              if (inLine.length === 0) return null;
              return (
                <div key={line}>
                  <p className="t-eyebrow mb-1.5">{LINE_LABEL[line]}</p>
                  <ul className="split-cols gap-2 [--split-min:11rem]">
                    {inLine.map((starter) => {
                      const foundBy = summary?.starters.find((entry) => entry.playerId === starter.playerId)?.foundBy ?? [];
                      const found = foundBy.length > 0;
                      return (
                        <li
                          key={starter.playerId}
                          className={`rounded-md border-2 px-3 py-2 ${found ? 'border-up bg-up/15' : 'border-down/50 bg-down/10'}`}
                        >
                          <p className="font-bold">
                            <span aria-hidden>{found ? '✓ ' : '✗ '}</span>
                            <span className="sr-only">{found ? 'Found: ' : 'Missed: '}</span>
                            {starter.name}
                          </p>
                          <p className="t-xs text-fg-muted">
                            {found ? `Found by ${foundBy.map((id) => nicknameOf(room, id)).join(', ')}` : 'Nobody got this one'}
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </Card>
        <div className="flex flex-col gap-4">
          <Card>
            <Eyebrow className="mb-2">Everyone&apos;s guesses</Eyebrow>
            {summary === null || summary.players.length === 0 ? (
              <p className="t-body text-fg-muted">Nobody submitted a lineup.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {summary.players.map((player) => (
                  <li key={player.playerId} className="rounded-md bg-hover px-3 py-3">
                    <p className="flex flex-wrap items-baseline justify-between gap-x-2 font-bold">
                      <span className="max-w-full">{nicknameOf(room, player.playerId)}</span>
                      <span className="tnum whitespace-nowrap text-accent">
                        {player.found}/{summary.slots}
                      </span>
                    </p>
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {player.guesses.map((guess, index) => (
                        <li
                          key={`${guess.guess}-${index}`}
                          className={`max-w-full rounded-full border px-3 py-1 text-sm ${STATUS_STYLE[guess.status]}`}
                        >
                          <span className="font-semibold">{guess.guess}</span>{' '}
                          <span className="t-xs text-fg-muted">· {STATUS_LABEL[guess.status]}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <RevealFooter round={round} room={room} />
        </div>
      </RoundShell>
    );
  }

  const locked = submitted !== null;
  const shown = locked ? submitted : names;
  const full = shown.length >= payload.maxGuesses;

  const addDraft = (): void => {
    const clean = draft.trim().replace(/\s+/g, ' ');
    if (clean.length === 0 || full || locked) return;
    if (!names.some((name) => name.toLowerCase() === clean.toLowerCase())) setNames([...names, clean]);
    setDraft('');
  };

  return (
    <RoundShell title="Lineup Recall" round={round} room={room} now={now}>
      <Card className="lg:p-6">
        <div className="split-cols gap-4 lg:items-start lg:gap-8 land:items-start">
          <div className="flex flex-col gap-4">
            <TeamHeading payload={payload} />
            <ShapeDiagram shape={payload.shape} />
          </div>
          <div className="flex flex-col gap-3">
            <Eyebrow>
              Name the {payload.slots} starters · {shown.length}/{payload.maxGuesses}
            </Eyebrow>
            {!locked ? (
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  addDraft();
                }}
              >
                <label className="flex-1 basis-40">
                  <span className="sr-only">Player name</span>
                  <input
                    className="field-input"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    maxLength={60}
                    disabled={full}
                    placeholder={full ? 'Squad full' : 'Type a name, press enter'}
                    // Free text only: no browser suggestions that could hint at (or leak) names.
                    name="lineup-guess"
                    type="text"
                    inputMode="text"
                    enterKeyHint="enter"
                    autoCapitalize="off"
                    autoCorrect="off"
                    autoComplete="off"
                    spellCheck={false}
                    data-lpignore="true"
                    data-1p-ignore="true"
                  />
                </label>
                <button
                  type="submit"
                  disabled={full || draft.trim().length === 0}
                  className="tap-target pressable rounded-md border-2 border-accent px-5 font-bold text-accent disabled:opacity-40"
                >
                  Add
                </button>
              </form>
            ) : null}

            {shown.length > 0 ? (
              <ul className="flex flex-wrap gap-2" aria-label="Your names">
                {shown.map((name, index) => (
                  <li
                    key={`${name}-${index}`}
                    className="flex max-w-full items-center rounded-full border-2 border-border-strong bg-card pl-4 text-base font-semibold"
                  >
                    <span className="max-w-full py-2">{name}</span>
                    {!locked ? (
                      <button
                        type="button"
                        aria-label={`Remove ${name}`}
                        onClick={() => setNames(names.filter((_, position) => position !== index))}
                        className="pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-lg text-fg-muted"
                      >
                        <span aria-hidden>✕</span>
                      </button>
                    ) : (
                      <span className="pr-4" />
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="t-sm text-fg-muted">Names you add show up here. One name per starter.</p>
            )}

            <BigButton disabled={locked || names.length === 0} onClick={() => onSubmit({ guesses: names })}>
              {locked ? 'Locked in' : `Lock in ${names.length} ${names.length === 1 ? 'name' : 'names'}`}
            </BigButton>
            {locked ? (
              <p className="t-sm text-center text-fg-muted">Locked in. Waiting for everyone else to finish.</p>
            ) : null}
          </div>
        </div>
      </Card>
    </RoundShell>
  );
};
