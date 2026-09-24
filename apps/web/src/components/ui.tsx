import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANT_CLASSES: Record<Variant, string> = {
  primary: 'bg-pitch-500 text-white active:bg-pitch-700 disabled:bg-pitch-900 disabled:text-white/40',
  secondary: 'bg-white/10 text-white active:bg-white/20 disabled:opacity-40',
  ghost: 'bg-transparent text-white border border-white/20 active:bg-white/10 disabled:opacity-40',
  danger: 'bg-red-600 text-white active:bg-red-800 disabled:opacity-40',
};

export const BigButton = ({
  variant = 'primary',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { readonly variant?: Variant }): React.JSX.Element => (
  <button
    className={`tap-target w-full rounded-2xl px-6 py-4 text-lg font-bold tracking-tight transition-colors ${VARIANT_CLASSES[variant]} ${className}`}
    {...rest}
  >
    {children}
  </button>
);

export const Card = ({ children, className = '' }: { readonly children: ReactNode; readonly className?: string }): React.JSX.Element => (
  <div className={`rounded-3xl border border-white/10 bg-white/[0.04] p-5 ${className}`}>{children}</div>
);

export const Spinner = ({ label }: { readonly label: string }): React.JSX.Element => (
  <div className="flex flex-col items-center gap-3 py-6 text-center" role="status" aria-live="polite">
    <div
      className="h-10 w-10 animate-spin rounded-full border-4 border-white/20 border-t-pitch-500 motion-reduce:animate-none"
      aria-hidden
    />
    <p className="text-sm text-white/70">{label}</p>
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
      ? 'border-red-500/50 bg-red-500/10 text-red-200'
      : tone === 'warn'
        ? 'border-amber-500/50 bg-amber-500/10 text-amber-200'
        : 'border-white/20 bg-white/5 text-white/80';
  return <div className={`rounded-2xl border px-4 py-3 text-sm ${toneClasses}`} role="status">{children}</div>;
};

export const PinBadge = ({ pin }: { readonly pin: string }): React.JSX.Element => (
  <div className="flex justify-center gap-2" aria-label={`Room PIN ${pin.split('').join(' ')}`}>
    {pin.split('').map((char, index) => (
      <span
        key={`${char}-${index}`}
        className="flex h-14 w-10 items-center justify-center rounded-xl bg-white/10 text-3xl font-black text-white sm:h-16 sm:w-12"
      >
        {char}
      </span>
    ))}
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
      <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full bg-pitch-500 transition-[width] duration-300 ease-linear motion-reduce:transition-none"
          style={{ width: `${ratio}%` }}
        />
      </div>
      <p className="mt-1 text-center text-sm font-semibold text-white/70">{seconds}s left</p>
    </div>
  );
};
