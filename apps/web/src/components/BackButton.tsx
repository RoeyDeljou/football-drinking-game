'use client';

/**
 * The one back/leave-navigation affordance shared across every setup/navigation screen (`/host`,
 * `/join`) and reused for the matchday picker's "Change league" step-back.
 * Pop the browser's own history when there is a real, still-in-app history entry behind the
 * current one; otherwise push an explicit fallback route (arriving via a direct link/QR code/new
 * tab, or having already popped all the way back to where this tab's session started, both leave
 * no in-app screen to pop back to — popping the browser's raw history in either case could leave
 * the app entirely). See `decideBackAction`/`hasInAppHistory` in `backNavigation.ts` for the
 * position-aware history tracking that decides this (not just "has the user ever navigated").
 *
 * Pass `onBack` to override navigation entirely (e.g. "Change league" just resets local state
 * instead of leaving the page) while keeping the same look or wired to the same keyboard/tap
 * target so the affordance stays visually and behaviourally consistent everywhere it appears.
 */

import { useRouter } from 'next/navigation';
import { decideBackAction, hasInAppHistory } from '@/lib/backNavigation';

export const BackButton = ({
  fallbackHref = '/',
  label = 'Back',
  onBack,
  className = '',
}: {
  readonly fallbackHref?: string;
  readonly label?: string;
  readonly onBack?: () => void;
  readonly className?: string;
}): React.JSX.Element => {
  const router = useRouter();

  const handleClick = (): void => {
    if (onBack !== undefined) {
      onBack();
      return;
    }
    const action = decideBackAction(hasInAppHistory(), fallbackHref);
    if (action.type === 'history') router.back();
    else router.push(action.href);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label}
      className={`tap-target inline-flex items-center gap-2 self-start rounded-full px-3 text-sm font-bold text-white/80 active:bg-white/10 ${className}`}
    >
      <span aria-hidden className="text-lg leading-none">
        ←
      </span>
      <span>{label}</span>
    </button>
  );
};
