'use client';

/**
 * The one game-choice control, used on the host setup screen, in the room lobby fallback, and on the
 * intermission "play another game" picker: two options only.
 *
 *  - "Shuffle game" (hero, gold-framed, default): the category's Mixed rotation.
 *  - "Select Mini Game" (secondary): only when chosen does the list of individual games appear.
 *
 * Purely presentational and controlled: the caller owns the choice (`lib/gameMode.ts` maps it to a
 * module id) and decides what a change means (just remember it on /host, or send `SELECT_GAME` in a
 * room).
 */

import { miniGamesFor, SELECT_LABEL, SHUFFLE_LABEL, shuffleModuleId, type GameCategory, type ModeChoice } from '@/lib/gameMode';
import { PICKER_COPY } from '@/lib/pickerCopy';
import { GAME_CATALOG } from '@/games/catalog';
import { OptionButton } from './ui';

const Check = (): React.JSX.Element => (
  <span
    aria-hidden
    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-base font-black text-accent-fg"
  >
    ✓
  </span>
);

const Dot = (): React.JSX.Element => (
  <span aria-hidden className="h-7 w-7 shrink-0 rounded-full border-2 border-border-strong" />
);

const Spin = (): React.JSX.Element => (
  <span
    aria-hidden
    className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-border border-t-accent motion-reduce:animate-none"
  />
);

export const GameModePicker = ({
  category,
  value,
  onChange,
  pendingModuleId = null,
  disabled = false,
}: {
  readonly category: GameCategory;
  readonly value: ModeChoice;
  readonly onChange: (choice: ModeChoice) => void;
  /** A module id whose `SELECT_GAME` is awaiting the server (shows a spinner on that option). */
  readonly pendingModuleId?: string | null;
  readonly disabled?: boolean;
}): React.JSX.Element => {
  const shuffleSelected = value.mode === 'shuffle';
  const shuffleBlurb = GAME_CATALOG.find((game) => game.id === shuffleModuleId(category))?.blurb ?? '';
  const shufflePending = pendingModuleId === shuffleModuleId(category);
  const games = miniGamesFor(category);

  return (
    <div className="flex flex-col gap-3" role="radiogroup" aria-label="Game mode">
      <button
        type="button"
        role="radio"
        aria-checked={shuffleSelected}
        aria-busy={shufflePending}
        disabled={disabled}
        onClick={() => onChange({ mode: 'shuffle', miniGameId: null })}
        className={`pressable flex min-h-28 w-full items-center gap-4 p-5 text-left disabled:opacity-60 ${
          shuffleSelected ? 'card-gold' : 'card-dashed'
        }`}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="t-eyebrow text-accent">{shuffleSelected ? 'Default' : 'Recommended'}</span>
          <span className="t-d1 block">{SHUFFLE_LABEL}</span>
          <span className="t-sm text-fg-muted">{shuffleBlurb}</span>
        </span>
        {shufflePending ? <Spin /> : shuffleSelected ? <Check /> : <Dot />}
      </button>

      <button
        type="button"
        role="radio"
        aria-checked={!shuffleSelected}
        disabled={disabled}
        onClick={() => onChange({ mode: 'select', miniGameId: value.miniGameId })}
        className={`pressable flex min-h-14 w-full items-center justify-between gap-3 rounded-md border-2 px-4 py-2 text-left disabled:opacity-60 ${
          shuffleSelected ? 'border-border bg-card' : 'border-accent bg-selected'
        }`}
      >
        <span className="flex min-w-0 flex-col">
          <span className="text-base font-bold">{SELECT_LABEL}</span>
          <span className="t-xs text-fg-muted">Pick one game and stick with it</span>
        </span>
        <span aria-hidden className="text-lg text-fg-muted">
          {shuffleSelected ? '▾' : '▴'}
        </span>
      </button>

      {!shuffleSelected ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 land:!grid-cols-1" role="group" aria-label="Mini games">
          {games.map((game) => {
            const selected = value.miniGameId === game.id;
            const pending = pendingModuleId === game.id;
            return (
              <OptionButton
                key={game.id}
                role="radio"
                aria-checked={selected}
                aria-busy={pending}
                selected={selected}
                disabled={disabled}
                onClick={() => onChange({ mode: 'select', miniGameId: game.id })}
                className="flex items-center gap-3"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-base font-bold">{game.name}</span>
                  <span className="t-xs font-normal text-fg-muted">{pending ? PICKER_COPY.cardPending : game.blurb}</span>
                </span>
                {pending ? <Spin /> : selected ? <Check /> : null}
              </OptionButton>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
