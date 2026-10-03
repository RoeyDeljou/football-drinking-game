'use client';

import { useState } from 'react';
import { BINGO_VOCABULARY, type GameConfigSpec } from '@/lib/gameConfigSpecs';
import { valueOf, withEdit, type SettingsState } from '@/lib/gameSettings';
import { bingoCellLabel, eventLabel, type LiveEventKind } from '@/lib/liveEventCopy';
import type { TeamNames } from './GameSettingsEditor';
import { Chip, Segmented, Stepper } from './SettingsControls';

type Side = 'home' | 'away' | null;

interface PoolCell {
  readonly event: string;
  readonly side: Side;
  readonly count: number;
  readonly label?: string;
}

const cellId = (cell: { event: string; side: Side; count: number }): string => `${cell.event}:${cell.side ?? 'any'}:${cell.count}`;

const generatedLabel = (cell: PoolCell, teams: TeamNames): string =>
  bingoCellLabel(cell.event as LiveEventKind, cell.count, cell.side === 'home' ? teams.home : cell.side === 'away' ? teams.away : null);

const shownLabel = (cell: PoolCell, teams: TeamNames): string => cell.label ?? generatedLabel(cell, teams);

/** The Match Bingo editor: which cells can be dealt (with your own wording), house-rule cells, and a sample card. */
export const BingoEditor = ({
  spec,
  state,
  onChange,
  teams,
}: {
  readonly spec: GameConfigSpec;
  readonly state: SettingsState;
  readonly onChange: (state: SettingsState) => void;
  readonly teams: TeamNames;
}): React.JSX.Element => {
  const vocab = BINGO_VOCABULARY;
  const size = (valueOf(spec, state, 'size') === 4 ? 4 : 3) as 3 | 4;
  const cells = size * size;
  const pool = Array.isArray(state.edits.cellPool) ? (state.edits.cellPool as readonly PoolCell[]) : null;
  const house = Array.isArray(state.edits.houseCells) ? (state.edits.houseCells as readonly string[]) : [];
  const perCard = house.length === 0 ? 0 : typeof state.edits.housePerCard === 'number' ? state.edits.housePerCard : Math.min(house.length, size - 1);
  const needed = cells - perCard;
  const poolCount = pool === null ? vocab.defaultCells.length : pool.length;
  const enough = poolCount >= needed;

  const [event, setEvent] = useState<string>(vocab.kinds[0] ?? 'CORNER');
  const [side, setSide] = useState<Side>(null);
  const [count, setCount] = useState(1);
  const [houseDraft, setHouseDraft] = useState('');

  const setPool = (next: readonly PoolCell[] | null): void => onChange(withEdit(state, 'cellPool', next === null ? undefined : next));
  const setHouse = (next: readonly string[]): void => {
    const edited = withEdit(state, 'houseCells', next.length === 0 ? undefined : next);
    // Drop a per-card count that no longer fits the house cells given.
    onChange(next.length === 0 || (typeof state.edits.housePerCard === 'number' && state.edits.housePerCard > next.length) ? withEdit(edited, 'housePerCard', undefined) : edited);
  };

  const candidate: PoolCell = { event, side, count };
  const duplicate = (pool ?? []).some((entry) => cellId(entry) === cellId(candidate));
  const startFromDefault = (): void =>
    setPool(vocab.defaultCells.map((entry) => ({ event: entry.event, side: entry.side, count: entry.count })));

  const addHouse = (): void => {
    const text = houseDraft.trim();
    if (text.length === 0 || house.length >= vocab.maxHouseCells) return;
    if (house.some((entry) => entry.toLowerCase() === text.toLowerCase())) return;
    setHouse([...house, text]);
    setHouseDraft('');
  };

  // A sample card: the house cells first, then pool cells in order. Display only, the engine deals the real ones.
  const sample: { text: string; house: boolean }[] = [
    ...house.slice(0, perCard).map((text) => ({ text, house: true })),
    ...((pool ?? vocab.defaultCells.map((entry) => ({ event: entry.event, side: entry.side, count: entry.count }))) as readonly PoolCell[])
      .slice(0, Math.max(0, needed))
      .map((entry) => ({ text: shownLabel(entry, teams), house: false })),
  ].slice(0, cells);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="t-h3">Bingo cells</p>
        <p className={`t-sm font-semibold ${enough ? 'text-fg-muted' : 'text-down'}`} role="status">
          {pool === null ? 'Default pool: ' : 'Your pool: '}
          {poolCount} {poolCount === 1 ? 'cell' : 'cells'}. A {size} x {size} card needs at least {needed}
          {perCard > 0 ? ` (plus ${perCard} house ${perCard === 1 ? 'cell' : 'cells'})` : ''}.
          {enough ? '' : ' Add more to continue.'}
        </p>
        {pool === null ? (
          <button type="button" onClick={startFromDefault} className="tap-target pressable rounded-md border-2 border-border-strong px-4 font-bold">
            Edit the default pool
          </button>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={startFromDefault} className="pressable min-h-11 rounded-md border-2 border-border-strong px-4 text-sm font-bold">
              Start from default pool
            </button>
            <button type="button" onClick={() => setPool(null)} className="pressable min-h-11 rounded-md border-2 border-border px-4 text-sm font-bold text-fg-muted">
              Back to the default pool
            </button>
          </div>
        )}
      </div>

      {pool !== null ? (
        <>
          <ul className="flex flex-col gap-2" aria-label="Pool cells">
            {pool.map((entry, index) => (
              <li key={cellId(entry)} className="flex flex-wrap items-center gap-2 rounded-md bg-card px-3 py-2">
                <label className="flex max-w-full flex-1 basis-48 flex-col gap-1">
                  <span className="t-xs text-fg-subtle">{generatedLabel(entry, teams)}</span>
                  <input
                    className="field-input"
                    value={entry.label ?? ''}
                    maxLength={vocab.labelMaxLength}
                    placeholder={generatedLabel(entry, teams)}
                    autoComplete="off"
                    aria-label={`Text for ${generatedLabel(entry, teams)}`}
                    onChange={(changeEvent) => {
                      const text = changeEvent.target.value;
                      setPool(pool.map((cell, position) => (position === index ? { event: cell.event, side: cell.side, count: cell.count, ...(text.trim().length === 0 ? {} : { label: text }) } : cell)));
                    }}
                  />
                </label>
                <button
                  type="button"
                  aria-label={`Remove ${generatedLabel(entry, teams)}`}
                  onClick={() => setPool(pool.filter((_, position) => position !== index))}
                  className="pressable h-12 w-12 shrink-0 rounded-md border-2 border-border-strong text-lg text-fg-muted"
                >
                  <span aria-hidden>✕</span>
                </button>
              </li>
            ))}
          </ul>

          <fieldset className="flex flex-col gap-3 rounded-md border-2 border-border p-3" disabled={pool.length >= vocab.maxPoolCells}>
            <legend className="t-sm px-1 font-semibold text-fg-muted">Add a cell</legend>
            <label className="flex flex-col gap-1">
              <span className="t-xs text-fg-subtle">Event</span>
              <select
                className="field-input"
                value={event}
                onChange={(changeEvent) => {
                  setEvent(changeEvent.target.value);
                  setCount(vocab.countPresets[changeEvent.target.value]?.[0] ?? 1);
                }}
              >
                {vocab.kinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {eventLabel(kind as LiveEventKind)}
                  </option>
                ))}
              </select>
            </label>
            <Segmented
              label="Which team"
              options={['either', 'home', 'away'] as const}
              value={side === null ? 'either' : side}
              labelOf={(option) => (option === 'either' ? 'Either team' : option === 'home' ? teams.home : teams.away)}
              onChange={(option) => setSide(option === 'either' ? null : option)}
            />
            <div className="flex flex-wrap gap-2" role="group" aria-label="How many">
              {(vocab.countPresets[event] ?? [1]).map((preset) => (
                <Chip key={preset} label={`${preset}x`} pressed={count === preset} onClick={() => setCount(preset)} />
              ))}
            </div>
            <Stepper label="count" value={count} min={1} max={vocab.maxCount} onChange={setCount} suffix={count === 1 ? 'time' : 'times'} />
            <p className="t-sm text-fg-muted">
              Reads as: <strong className="text-fg">{generatedLabel(candidate, teams)}</strong>
            </p>
            <button
              type="button"
              disabled={duplicate}
              onClick={() => setPool([...pool, candidate])}
              className="tap-target pressable rounded-md bg-accent px-4 font-bold text-accent-fg disabled:bg-bg-sunken disabled:text-fg-subtle"
            >
              {duplicate ? 'Already in the pool' : 'Add to pool'}
            </button>
          </fieldset>
        </>
      ) : null}

      <div className="flex flex-col gap-2">
        <p className="t-h3">House cells</p>
        <p className="t-sm text-fg-muted">
          Your own rules the feed can&apos;t see, like &quot;Commentator says world class&quot;. You, the host, tick them during the game.
        </p>
        <ul className="flex flex-col gap-2" aria-label="House cells">
          {house.map((text, index) => (
            <li key={text} className="flex items-center gap-2 rounded-md border-2 border-dashed border-accent/60 bg-card pl-3">
              <span className="max-w-full flex-1 py-2 font-semibold">{text}</span>
              <button
                type="button"
                aria-label={`Remove ${text}`}
                onClick={() => setHouse(house.filter((_, position) => position !== index))}
                className="pressable h-12 w-12 shrink-0 text-lg text-fg-muted"
              >
                <span aria-hidden>✕</span>
              </button>
            </li>
          ))}
        </ul>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(submitEvent) => {
            submitEvent.preventDefault();
            addHouse();
          }}
        >
          <label className="flex-1 basis-48">
            <span className="sr-only">New house cell</span>
            <input
              className="field-input"
              value={houseDraft}
              maxLength={vocab.labelMaxLength}
              placeholder="Type a rule, press enter"
              autoComplete="off"
              disabled={house.length >= vocab.maxHouseCells}
              onChange={(changeEvent) => setHouseDraft(changeEvent.target.value)}
            />
          </label>
          <button
            type="submit"
            disabled={houseDraft.trim().length === 0 || house.length >= vocab.maxHouseCells}
            className="tap-target pressable rounded-md border-2 border-accent px-5 font-bold text-accent disabled:opacity-40"
          >
            Add
          </button>
        </form>
        {house.length > 0 ? (
          <>
            <p className="t-sm font-semibold text-fg-muted">House cells on each card</p>
            <Stepper
              label="house cells per card"
              value={perCard}
              min={0}
              max={Math.min(house.length, cells)}
              suffix={perCard === 1 ? 'cell' : 'cells'}
              onChange={(next) => onChange(withEdit(state, 'housePerCard', next))}
            />
          </>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <p className="t-h3">Sample card</p>
        <ol className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }} aria-label="Sample card">
          {sample.map((cell, index) => (
            <li
              key={`${cell.text}-${index}`}
              className={`flex min-h-16 flex-col items-center justify-center gap-0.5 rounded-md border-2 p-1.5 text-center text-xs font-bold leading-tight ${
                cell.house ? 'border-dashed border-accent/70 bg-accent/10' : 'border-border bg-card'
              }`}
            >
              {cell.house ? <span className="t-eyebrow text-accent">House</span> : null}
              <span className="max-w-full">{cell.text}</span>
            </li>
          ))}
        </ol>
        <p className="t-xs text-fg-subtle">Each player gets a different card dealt from the pool.</p>
      </div>
    </div>
  );
};
