import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { useEffect } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** Primary = gold fill with board-green text (the one thing to do); secondary = chalk outline. */
const VARIANT_CLASSES: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg disabled:bg-bg-sunken disabled:text-fg-subtle disabled:opacity-70',
  secondary: 'border-2 border-border-strong bg-transparent text-fg disabled:opacity-40',
  ghost: 'bg-transparent text-fg-muted underline-offset-4 disabled:opacity-40',
  danger: 'border-2 border-down bg-down/10 text-down disabled:opacity-40',
};

export const BigButton = ({
  variant = 'primary',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { readonly variant?: Variant }): React.JSX.Element => (
  <button
    className={`tap-target pressable w-full rounded-md px-4 py-4 text-lg font-bold tracking-tight sm:px-6 ${VARIANT_CLASSES[variant]} ${className}`}
    {...rest}
  >
    {children}
  </button>
);

export const Card = ({ children, className = '' }: { readonly children: ReactNode; readonly className?: string }): React.JSX.Element => (
  <div className={`card p-4 sm:p-5 ${className}`}>{children}</div>
);

/** The tracked uppercase micro label above a heading or block. */
export const Eyebrow = ({ children, className = '' }: { readonly children: ReactNode; readonly className?: string }): React.JSX.Element => (
  <p className={`t-eyebrow ${className}`}>{children}</p>
);

/**
 * A big selectable option (game, league, fixture, answer). Selected = gold frame + gold tint, so the
 * state never relies on colour alone: `aria-pressed`/`aria-checked` is set by the caller via `role`.
 */
export const OptionButton = ({
  selected = false,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { readonly selected?: boolean }): React.JSX.Element => (
  <button
    type="button"
    className={`tap-target pressable max-w-full rounded-md border-2 px-3 py-3 text-left sm:px-4 font-bold disabled:opacity-60 ${
      selected ? 'border-accent bg-selected text-fg' : 'border-border bg-card text-fg'
    } ${className}`}
    {...rest}
  >
    {children}
  </button>
);

/** A labelled text input (56px, chalk outline, gold focus). */
export const Field = ({
  label,
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { readonly label: string }): React.JSX.Element => (
  <label className="flex flex-col gap-1.5">
    <span className="t-eyebrow">{label}</span>
    <input className={`field-input ${className}`} {...rest} />
  </label>
);

export const Spinner = ({ label }: { readonly label: string }): React.JSX.Element => (
  <div className="flex flex-col items-center gap-3 py-6 text-center" role="status" aria-live="polite">
    <div
      className="h-10 w-10 animate-spin rounded-full border-4 border-border border-t-accent motion-reduce:animate-none"
      aria-hidden
    />
    <p className="t-body text-fg-muted">{label}</p>
  </div>
);

export const Banner = ({
  tone = 'info',
  children,
}: {
  readonly tone?: 'info' | 'error' | 'warn';
  readonly children: ReactNode;
}): React.JSX.Element => {
  const toneClasses =
    tone === 'error'
      ? 'border-down/60 bg-down/10 text-down'
      : tone === 'warn'
        ? 'border-warn/60 bg-warn/10 text-warn'
        : 'border-border bg-card text-fg-muted';
  return (
    <div className={`rounded-md border-2 px-4 py-3 text-sm font-semibold leading-snug ${toneClasses}`} role="status">
      {children}
    </div>
  );
};

/**
 * A blocking confirm step for irreversible/destructive actions (e.g. deleting a room) — a plain
 * tap must never fire the action itself. Keyboard reachable (native buttons, Escape cancels) and
 * traps nothing beyond what a same-page overlay needs; respects reduced motion by not animating.
 */
export const ConfirmDialog = ({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  onConfirm,
  onCancel,
}: {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly tone?: 'danger' | 'primary';
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      // Scrolls as a whole if a short landscape phone or 200% zoom can't fit the sheet, and keeps clear of
      // the notch / home indicator.
      className="fixed inset-0 z-50 flex justify-center overflow-y-auto bg-scrim pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(1rem,env(safe-area-inset-top))]"
      onClick={onCancel}
    >
      <div
        className="my-auto w-full max-w-md rounded-lg border-2 border-border-strong bg-bg-raised p-5 shadow-sheet sm:p-6 lg:max-w-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="confirm-dialog-title" className="t-d2">
          {title}
        </h2>
        <p className="t-body mt-2 text-fg-muted">{message}</p>
        <div className="mt-5 flex flex-col gap-3 land:flex-row-reverse">
          <BigButton variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </BigButton>
          <BigButton variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </BigButton>
        </div>
      </div>
    </div>
  );
};

/** The room PIN as six tiles. `hero` is the lobby's host-facing size (readable across a table). */
export const PinBadge = ({
  pin,
  size = 'md',
}: {
  readonly pin: string;
  readonly size?: 'md' | 'hero';
}): React.JSX.Element => (
  <div className={`pin-row ${size === 'hero' ? 'pin-hero' : ''}`} role="img" aria-label={`Room PIN ${pin.split('').join(' ')}`}>
    <div className="pin-tiles" aria-hidden>
      {pin.split('').map((char, index) => (
        <span key={`${char}-${index}`} className="pin-tile">
          {char}
        </span>
      ))}
    </div>
  </div>
);

export const CountdownBar = ({
  deadlineAt,
  now,
  totalMs,
}: {
  readonly deadlineAt: number | null;
  readonly now: number;
  readonly totalMs: number;
}): React.JSX.Element | null => {
  if (deadlineAt === null) return null;
  const remainingMs = Math.max(0, deadlineAt - now);
  const seconds = Math.ceil(remainingMs / 1000);
  const ratio = totalMs <= 0 ? 0 : Math.min(100, Math.max(0, (remainingMs / totalMs) * 100));
  return (
    <div className="w-full" aria-live="off">
      <div className="h-3 w-full overflow-hidden rounded-full bg-bg-sunken">
        <div
          className="h-full bg-accent transition-[width] duration-300 ease-linear motion-reduce:transition-none"
          style={{ width: `${ratio}%` }}
        />
      </div>
      <p className="tnum mt-1 text-center text-sm font-bold text-fg-muted">{seconds}s left</p>
    </div>
  );
};
