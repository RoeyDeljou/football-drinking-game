'use client';

/**
 * Mounted once at the root layout. Tags this tab's history entries with a real, position-aware
 * index (see `backNavigation.ts` for the full mechanism) so `BackButton` can tell "there is a real
 * in-app entry behind this one" apart from "this tab was opened fresh here" or "the user has
 * already popped all the way back to where this tab's session started". Renders nothing.
 *
 * Two things this tracker must get right:
 *
 * 1. Push vs. replace: a `router.replace(...)` redirect changes the pathname just like a real push
 *    does, but reuses the current history slot instead of adding one — see
 *    `markUpcomingNavigationAsReplace` in `backNavigation.ts`.
 * 2. Push vs. popstate: the browser's OWN back/forward buttons also change the pathname, but they
 *    must never be recorded as a new navigation — the entry they land on already carries its own
 *    correctly-restored tag from when it was first tagged, and re-tagging it here as if it were a
 *    fresh push is exactly the bug this tracker replaced (a monotonic "have you ever navigated"
 *    counter that never accounted for the user going back). We tell popstate-driven pathname
 *    changes apart from in-app push/replace calls with a token bumped by a `popstate` listener and
 *    compared against what the pathname-change effect last saw; the comparison happens once per
 *    pathname change regardless of outcome. Known gap: a popstate that changes ONLY the query
 *    string on the same path never triggers a pathname-change effect run at all, so the bumped
 *    token is left unconsumed — the next REAL push then reads a stale token and is (harmlessly)
 *    treated as if it were popstate-driven, i.e. not recorded. This fails closed (Back then pushes
 *    the fallback route instead of popping) rather than leaking a wrong "has history" answer.
 */

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import {
  consumeReplaceFlag,
  ensureEntryPointTagged,
  recordNavigation,
  syncLastIndexAfterPopState,
} from '@/lib/backNavigation';

export const NavigationTracker = (): null => {
  const pathname = usePathname();
  const previousPathname = useRef<string | null>(null);
  const popStateTokenRef = useRef(0);
  const lastSeenPopStateTokenRef = useRef(0);

  // Tag this tab's current history entry before any navigation can happen. If it's untagged (a
  // fresh document, direct link, or re-entry after leaving for an external site), this gives it its
  // own floor equal to its own index — there is, by definition, no real in-app history behind it.
  useEffect(() => {
    ensureEntryPointTagged();
  }, []);

  // Track the browser's own back/forward navigations so the pathname-change effect below can tell
  // them apart from an in-app router.push/replace call.
  useEffect(() => {
    const handlePopState = (): void => {
      popStateTokenRef.current += 1;
      // Keep the "last known index" bookkeeping in sync with the tab's real position the moment a
      // pop lands, so a later replace on this slot re-tags it with its own correct index rather
      // than a stale, too-high one left over from before the user went back. See
      // `syncLastIndexAfterPopState` in `backNavigation.ts`. This is a defensive resync, not the
      // primary mechanism a replace relies on — see that file's v5 doc for the actual fix.
      syncLastIndexAfterPopState();
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // A cross-document history traversal (browser back/forward across a real top-level navigation —
  // e.g. app -> external site -> back into the app, or a bfcache restore) does not always fire a
  // `popstate` this tab's own listener above ever sees resync correctly (the traversal can cross a
  // document boundary where the OLD document's listeners are simply gone). `pageshow` with
  // `event.persisted` true fires for exactly this case (a bfcache restore), on the document actually
  // being shown, so resync the defensive cache here too. Purely defensive, same as the popstate
  // listener above.
  useEffect(() => {
    const handlePageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) {
        syncLastIndexAfterPopState();
      }
    };
    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, []);

  useEffect(() => {
    // Consume the popstate token once per pathname-change effect run, regardless of which branch
    // below runs — this is what keeps a popstate that didn't change the pathname from later being
    // mistaken for the cause of some unrelated, subsequent pathname change.
    const sawPopState = popStateTokenRef.current !== lastSeenPopStateTokenRef.current;
    lastSeenPopStateTokenRef.current = popStateTokenRef.current;

    if (previousPathname.current !== null && previousPathname.current !== pathname) {
      const wasReplace = consumeReplaceFlag();
      if (!sawPopState) {
        recordNavigation(wasReplace);
      }
      // If this pathname change came from the browser's own back/forward, `history.state` already
      // carries the correctly-restored tag for the entry we just landed on — nothing to record.
    }
    previousPathname.current = pathname;
  }, [pathname]);

  return null;
};
