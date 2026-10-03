'use client';

/** Small controls shared by the game settings editors: all thumb-sized (44px+), keyboard reachable. */

export const Stepper = ({
  label,
  value,
  min,
  max,
  step = 1,
  display,
  suffix = '',
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  /** What to show for `value` (e.g. seconds for a millisecond field). */
  readonly display?: number;
  readonly suffix?: string;
  readonly onChange: (value: number) => void;
}): React.JSX.Element => (
  <div className="flex items-center gap-2" role="group" aria-label={label}>
    <button
      type="button"
      aria-label={`Less ${label}`}
      disabled={value <= min}
      onClick={() => onChange(Math.max(min, value - step))}
      className="pressable flex h-12 w-12 shrink-0 items-center justify-center rounded-md border-2 border-border-strong text-2xl font-bold disabled:opacity-40"
    >
      −
    </button>
    <output aria-live="polite" className="tnum min-w-[4.5rem] flex-1 text-center text-lg font-black">
      {display ?? value}
      {suffix.length > 0 ? <span className="t-sm font-normal text-fg-muted"> {suffix}</span> : null}
    </output>
    <button
      type="button"
      aria-label={`More ${label}`}
      disabled={value >= max}
      onClick={() => onChange(Math.min(max, value + step))}
      className="pressable flex h-12 w-12 shrink-0 items-center justify-center rounded-md border-2 border-border-strong text-2xl font-bold disabled:opacity-40"
    >
      +
    </button>
  </div>
);

export const Segmented = <T extends string | number>({
  label,
  options,
  value,
  onChange,
  labelOf,
}: {
  readonly label: string;
  readonly options: readonly T[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly labelOf: (option: T) => string;
}): React.JSX.Element => (
  <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
    {options.map((option) => (
      <button
        key={String(option)}
        type="button"
        role="radio"
        aria-checked={value === option}
        onClick={() => onChange(option)}
        className={`pressable min-h-12 max-w-full flex-1 rounded-md border-2 px-4 py-2 text-sm font-bold ${
          value === option ? 'border-accent bg-selected text-fg' : 'border-border bg-card text-fg-muted'
        }`}
      >
        {labelOf(option)}
      </button>
    ))}
  </div>
);

export const Toggle = ({
  label,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}): React.JSX.Element => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={() => onChange(!checked)}
    className={`pressable flex h-12 w-24 items-center rounded-full border-2 px-1 ${
      checked ? 'justify-end border-accent bg-selected' : 'justify-start border-border-strong bg-card'
    }`}
  >
    <span className={`flex h-9 min-w-[2.25rem] items-center justify-center rounded-full px-2 text-xs font-black ${checked ? 'bg-accent text-accent-fg' : 'bg-bg-sunken text-fg-muted'}`}>
      {checked ? 'On' : 'Off'}
    </span>
  </button>
);

export const Chip = ({
  label,
  pressed,
  onClick,
  disabled = false,
}: {
  readonly label: string;
  readonly pressed: boolean;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}): React.JSX.Element => (
  <button
    type="button"
    aria-pressed={pressed}
    disabled={disabled}
    onClick={onClick}
    className={`pressable min-h-11 max-w-full rounded-full border-2 px-4 py-1.5 text-sm font-bold disabled:opacity-50 ${
      pressed ? 'border-accent bg-selected text-fg' : 'border-border bg-card text-fg-muted'
    }`}
  >
    {pressed ? <span aria-hidden>✓ </span> : null}
    {label}
  </button>
);
