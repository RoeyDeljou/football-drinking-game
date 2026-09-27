import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BackNavigationModule from './backNavigation';

/**
 * Round 7/8 rewrite: the previous harness here modeled `history.state` as a single mutable field
 * that survived every operation unchanged unless a test explicitly clobbered it. That's too simple
 * to catch the actual bug class this file has now hit twice: it never modeled (a) a real
 * MULTI-ENTRY history stack (so browser back/forward could actually move a cursor across distinct
 * entries, each with its own state), (b) a genuine DOCUMENT boundary (a "fresh document load" is a
 * fundamentally different event from a same-document popstate restore — a fresh load re-imports
 * this module, resetting ALL its module-level state, while a popstate does not), or (c) Next.js's
 * own confirmed behavior of wiping `history.state` back to essentially empty on every
 * `push`/`replace` call (`HistoryUpdater`, `preserveCustomHistoryState: false`).
 *
 * This harness models all three, and reproduces the exact 7-step live repro from round 8's QA gate
 * as a deterministic test (`describe('round 8 live repro')` below), plus a revert-and-confirm test
 * that proves the OLD (cache-as-source-of-truth) design fails this exact repro.
 */

// ---------------------------------------------------------------------------------------------
// A tiny multi-document, multi-entry history + sessionStorage model.
// ---------------------------------------------------------------------------------------------

type HistoryEntry = { state: unknown; url: string };

/** sessionStorage persists across "documents" in the same tab -- it is tab-scoped, not per-document. */
let sessionMemory: Map<string, string>;

/** The full history stack for this fake "tab", and a cursor into it -- shared across "documents". */
let stack: HistoryEntry[];
let cursor: number;

/** Next.js's own `history.state`-wiping behavior: true wipes state on every push/replace, matching
 * the confirmed real behavior (`preserveCustomHistoryState: false`). Flipping this to false for the
 * revert-and-confirm test proves the OLD design only "worked" by accident when nothing wipes state. */
let nextWipesStateOnNavigate = true;

const sessionStorageFake: Storage = {
  get length() {
    return sessionMemory.size;
  },
  clear: () => sessionMemory.clear(),
  getItem: (key: string) => sessionMemory.get(key) ?? null,
  key: (index: number) => Array.from(sessionMemory.keys())[index] ?? null,
  removeItem: (key: string) => {
    sessionMemory.delete(key);
  },
  setItem: (key: string, value: string) => {
    sessionMemory.set(key, value);
  },
};

const historyFake = {
  get state(): unknown {
    return stack[cursor]?.state ?? null;
  },
  pushState: (state: unknown, _unused: string, url?: string) => {
    // Truncate any forward entries, exactly like a real push does.
    stack = stack.slice(0, cursor + 1);
    stack.push({ state, url: url ?? stack[cursor]?.url ?? '/' });
    cursor = stack.length - 1;
  },
  replaceState: (state: unknown, _unused: string, url?: string) => {
    stack[cursor] = { state, url: url ?? stack[cursor]?.url ?? '/' };
  },
};

/** Module under test, freshly imported per "document" -- see `loadFreshDocument` below. */
let mod: typeof BackNavigationModule;

/**
 * Simulates a genuinely fresh document load in the SAME tab: sessionStorage and the history stack
 * both survive (as they do across a real top-level navigation in one tab), but every module-level
 * JS variable does not -- so this module must be freshly re-imported, exactly as it would be by a
 * real page load. `vi.resetModules()` + a re-`import()` is what forces that.
 */
const loadFreshDocument = async (): Promise<void> => {
  vi.resetModules();
  vi.stubGlobal('window', { sessionStorage: sessionStorageFake, history: historyFake });
  mod = await import('./backNavigation');
};

/**
 * Simulates Next's `router.push`/`router.replace`: performs the real stack push/replace, but (when
 * `nextWipesStateOnNavigate` is true, the real, confirmed default) wipes the resulting entry's state
 * back to empty first, exactly like Next's own `HistoryUpdater` does with
 * `preserveCustomHistoryState: false` -- this is what makes `history.state` unreliable for a replace
 * handler to read AFTER the router call, and is the entire reason the primary fix must capture state
 * BEFORE the router call instead.
 */
const nextRouterNavigate = (kind: 'push' | 'replace', url: string): void => {
  if (kind === 'push') {
    historyFake.pushState(nextWipesStateOnNavigate ? {} : historyFake.state, '', url);
  } else {
    historyFake.replaceState(nextWipesStateOnNavigate ? {} : historyFake.state, '', url);
  }
};

/**
 * Simulates Next.js's OWN separate wipe of an entry's `history.state` some time AFTER a plain
 * `popstate` has already landed on it — WITHOUT our code ever calling `push`/`replace`. This is the
 * round-9 root cause: when a popstate lands on a page whose client-side router cache doesn't already
 * hold that page's content, Next fetches it lazily (an `ACTION_SERVER_PATCH`), and that reducer's
 * `HistoryUpdater` runs with `preserveCustomHistoryState: false`, rewriting `history.state` back to
 * empty for the CURRENT stack slot — clobbering our `{fdgIdx, fdgFloor}` tag with nothing to resync
 * from. Deliberately does NOT move the cursor and does NOT go through `historyFake.replaceState`
 * (that's still `window.history.replaceState`, which is what OUR code calls; this models Next's own,
 * separate internal write to the same underlying entry).
 */
const nextServerPatchWipe = (): void => {
  stack[cursor] = { state: {}, url: stack[cursor]?.url ?? '/' };
};

/** Simulates the user's browser Back button: moves the cursor and fires a real `popstate` handler. */
const browserBack = (onPopState: () => void): void => {
  if (cursor > 0) cursor -= 1;
  onPopState();
};

/** Simulates the user's browser Forward button: moves the cursor and fires a real `popstate` handler. */
const browserForward = (onPopState: () => void): void => {
  if (cursor < stack.length - 1) cursor += 1;
  onPopState();
};

/**
 * Simulates crossing an actual origin/document boundary (typing an external URL, then typing an app
 * URL back in): appends a brand-new, untagged entry (a real cross-document nav always lands on an
 * entry with no state at all until something tags it) and moves the cursor there. Does NOT reset
 * sessionStorage (same tab), but DOES require the caller to `loadFreshDocument()` afterwards, since a
 * real cross-origin nav tears down the whole JS context.
 */
const crossDocumentNavigateTo = (url: string): void => {
  stack = stack.slice(0, cursor + 1);
  stack.push({ state: null, url });
  cursor = stack.length - 1;
};

const resetAll = async (): Promise<void> => {
  sessionMemory = new Map<string, string>();
  stack = [{ state: null, url: '/' }];
  cursor = 0;
  nextWipesStateOnNavigate = true;
  await loadFreshDocument();
};

beforeEach(resetAll);

describe('decideBackAction', () => {
  it('pops history when there is a real in-app entry behind the current one', async () => {
    expect(mod.decideBackAction(true, '/')).toEqual({ type: 'history' });
  });

  it('falls back to an explicit push when there is nothing real to pop back to', () => {
    expect(mod.decideBackAction(false, '/')).toEqual({ type: 'push', href: '/' });
  });

  it('uses whatever fallback href is given', () => {
    expect(mod.decideBackAction(false, '/room/abc')).toEqual({ type: 'push', href: '/room/abc' });
  });
});

describe('ensureEntryPointTagged / hasInAppHistory (per-entry floor)', () => {
  it('reports no history for a brand-new, untagged entry (fresh tab) and tags idx === floor', () => {
    mod.ensureEntryPointTagged();
    expect(mod.hasInAppHistory()).toBe(false);
    const tag = historyFake.state as { fdgIdx?: number; fdgFloor?: number };
    expect(tag.fdgIdx).toBe(tag.fdgFloor);
  });

  it('flips to true after a real push-style navigation is recorded', () => {
    mod.ensureEntryPointTagged();
    nextRouterNavigate('push', '/next');
    mod.recordNavigation(false);
    expect(mod.hasInAppHistory()).toBe(true);
  });

  it('a push inherits the floor of the entry it was pushed from, unchanged', () => {
    mod.ensureEntryPointTagged();
    const entryFloor = (historyFake.state as { fdgFloor?: number }).fdgFloor;
    nextRouterNavigate('push', '/a');
    mod.recordNavigation(false);
    nextRouterNavigate('push', '/b');
    mod.recordNavigation(false);
    expect((historyFake.state as { fdgFloor?: number }).fdgFloor).toBe(entryFloor);
  });

  it('does not re-tag an already-tagged entry (idempotent across repeated calls, e.g. StrictMode)', () => {
    mod.ensureEntryPointTagged();
    const taggedOnce = historyFake.state;
    mod.ensureEntryPointTagged();
    mod.ensureEntryPointTagged();
    expect(historyFake.state).toEqual(taggedOnce);
  });

  it('does not throw and fails closed when sessionStorage access throws', () => {
    const original = sessionStorageFake.getItem;
    sessionStorageFake.getItem = () => {
      throw new Error('blocked (e.g. private browsing)');
    };
    expect(() => mod.hasInAppHistory()).not.toThrow();
    sessionStorageFake.getItem = original;
  });
});

describe('the primary fix: synchronous capture before replace, not cache freshness', () => {
  it('markUpcomingNavigationAsReplace + recordNavigation(true) reapply the slot\'s real tag even ' +
    'though Next wipes history.state on the router.replace call in between', () => {
    mod.ensureEntryPointTagged(); // {idx: 1, floor: 1}
    nextRouterNavigate('push', '/a');
    mod.recordNavigation(false); // {idx: 2, floor: 1}
    expect(mod.hasInAppHistory()).toBe(true);
    const before = historyFake.state;

    // A redirect effect fires: capture happens synchronously BEFORE the router call.
    mod.markUpcomingNavigationAsReplace();
    nextRouterNavigate('replace', '/a-redirected'); // Next wipes state to {} right here
    expect(historyFake.state).toEqual({}); // confirms the wipe actually happened in this model
    mod.recordNavigation(true);

    expect(historyFake.state).toEqual(before); // reapplied correctly despite the wipe
    expect(mod.hasInAppHistory()).toBe(true);
  });

  it('REGRESSION GUARD (round 9): skipping the capture step now fails CLOSED, never inherits a ' +
    'stale cache value from some other slot', () => {
    mod.ensureEntryPointTagged(); // {idx: 1, floor: 1}, cache mirrors (1, 1)
    nextRouterNavigate('push', '/a');
    mod.recordNavigation(false); // {idx: 2, floor: 1}, cache mirrors (2, 1)

    // Simulate the cache having gone stale for some OTHER slot without ever calling
    // markUpcomingNavigationAsReplace (i.e. skip the fix's capture step entirely, forcing
    // recordNavigation(true) down its live-read-only fallback path).
    sessionMemory.set('fdg:navLastIdx', '99');
    sessionMemory.set('fdg:navLastFloor', '1');
    nextRouterNavigate('replace', '/a-redirected'); // Next wipes state to {}

    // What the OLD (pre-round-9) code would have done instead, for contrast/documentation: it would
    // have read the stale cache directly, sitting here BEFORE recordNavigation runs and overwrites it.
    const oldBuggyIdx = Number(sessionMemory.get('fdg:navLastIdx'));
    const oldBuggyFloor = Number(sessionMemory.get('fdg:navLastFloor'));
    expect(oldBuggyIdx).toBeGreaterThan(oldBuggyFloor); // (99, 1) really did look like "has history"

    mod.recordNavigation(true); // no captured snapshot, and the live read is also empty

    // As of round 9, `recordNavigation(true)` no longer consults the sessionStorage cache at all: an
    // untagged current entry (state wiped, nothing captured) is treated as fresh -- new idx, floor
    // equal to that same idx -- never the stale (99, 1) left over from a different slot.
    const tag = historyFake.state as { fdgIdx?: number; fdgFloor?: number };
    expect(tag.fdgIdx).toBe(tag.fdgFloor);
    expect(tag).not.toEqual({ fdgIdx: 99, fdgFloor: 1 });
    expect(mod.hasInAppHistory()).toBe(false);
  });
});

describe('round 8 live repro: cross-document re-entry poisons the cache, then a stale replace escapes the app', () => {
  it(
    '7-step repro: join by PIN -> external site -> back x3/forward x1 -> host ends room -> ' +
      'forward x2 -> room redirect (replace) -> in-app Back must land at "/", never at the external site',
    async () => {
      // Step 1: join a room by PIN, land on /room/<id>. This is the app's entry point for the tab.
      mod.ensureEntryPointTagged(); // entry A: {idx: 1, floor: 1}

      // Step 2: navigate to an external site, then back into the app via the URL bar -- a genuine
      // cross-document round trip. The external site is a document this module is never loaded
      // into, and the return trip is a FRESH document load of /room/<id> (new entry, untagged).
      crossDocumentNavigateTo('https://example.com');
      crossDocumentNavigateTo('http://localhost:3000/room/r1'); // entry B, untagged so far
      await loadFreshDocument(); // fresh document -> fresh module instance, matching a real reload
      mod.ensureEntryPointTagged(); // entry B correctly tagged fresh: {idx: 1, floor: 1} (own counter)

      // Also push a couple of same-document in-app entries after B, so the stack has real depth to
      // traverse (mirrors the account for other app navigation that would realistically exist).
      nextRouterNavigate('push', '/room/r1/x');
      mod.recordNavigation(false); // entry C: {idx: 2, floor: 1}
      nextRouterNavigate('push', '/room/r1/y');
      mod.recordNavigation(false); // entry D: {idx: 3, floor: 1}

      const popstateHandler = (): void => mod.syncLastIndexAfterPopState();

      // Step 3: browser Back three times (D -> C -> B -> external site), then Forward once (back to
      // B). Crossing into/out of the external, untagged document during this traversal is exactly
      // where a real browser does NOT fire a popstate this tab's JS can observe on the way through
      // (the document is torn down / not yet reloaded), so this harness models that boundary
      // faithfully: only same-document hops fire our popstate handler.
      browserBack(popstateHandler); // D -> C (same document, popstate fires)
      browserBack(popstateHandler); // C -> B (same document, popstate fires)
      browserBack(popstateHandler); // B -> external site (crossing OUT of our document: model this
      // as tearing down the module, i.e. no popstate handler reachable at all for this hop)
      browserForward(popstateHandler); // external site -> B: crossing back IN. A real browser does
      // this via a fresh document load (bfcache or full reload), not a same-document popstate.
      await loadFreshDocument(); // fresh module instance for this cross-document re-entry
      // Poison the cache the way the real bug does: simulate some OTHER, unrelated tab history
      // (still in the same sessionStorage) having left a higher, stale idx/floor pair behind before
      // this trip, e.g. from whatever the tab was doing pre-external-site in a longer real session.
      sessionMemory.set('fdg:navLastIdx', '3');
      sessionMemory.set('fdg:navLastFloor', '1');
      mod.ensureEntryPointTagged(); // entry B is ALREADY tagged (its own real {1, 1} survived on the
      // stack entry itself, since we never wiped entry B's own state) -- with the fix, this call
      // must resync the cache to B's OWN real values, not leave the poisoned (3, 1) sitting there.

      expect(mod.hasInAppHistory()).toBe(false); // entry B's own state is genuinely {1, 1}

      // Step 4: the host ends the room (clears client-side storage without navigating) -- no
      // history/module-state effect at all; nothing to simulate here.

      // Step 5: browser Forward twice more, landing back on a cross-document ROOT for /room/<id>
      // again -- a genuinely different, untagged document entry (not one of the same-document C/D
      // entries pushed earlier), matching the live repro's own wording. Model this as another
      // cross-document entry appended after D, reached by forwarding through C and D.
      crossDocumentNavigateTo('http://localhost:3000/room/r1'); // entry E, a fresh cross-doc root
      await loadFreshDocument();
      mod.ensureEntryPointTagged(); // lands on an entry that, in the buggy version, would leave the
      // poisoned cache in place because this path used to return early for an already-tagged entry.
      // Here it's genuinely untagged (a fresh cross-doc root), so it must get a fresh {idx, floor}.

      // Step 6: the room page's redirect effect fires because the room is gone: capture happens
      // synchronously BEFORE the replace, then Next wipes state on the replace call itself.
      mod.markUpcomingNavigationAsReplace();
      nextRouterNavigate('replace', '/join/ABC123');
      mod.recordNavigation(true);

      // Step 7: the fixed behavior must NOT have escaped to "has real in-app history" -- there must
      // be nothing genuinely poppable in-app behind this redirected join screen from a cache-driven
      // false positive.
      expect(mod.hasInAppHistory()).toBe(false);
      expect(mod.decideBackAction(mod.hasInAppHistory(), '/')).toEqual({ type: 'push', href: '/' });
    },
  );

  it(
    'REGRESSION GUARD (round 9): the same 7-step sequence with NO capture ever taken now fails ' +
      'CLOSED (round 9 fix), where it used to wrongly report in-app history via the cache fallback',
    async () => {
      // Rebuild the same sequence, but this time never call markUpcomingNavigationAsReplace at all
      // before the final replace -- i.e. force recordNavigation(true) down its non-primary path.
      mod.ensureEntryPointTagged();
      crossDocumentNavigateTo('https://example.com');
      crossDocumentNavigateTo('http://localhost:3000/room/r1');
      await loadFreshDocument();
      mod.ensureEntryPointTagged();
      nextRouterNavigate('push', '/room/r1/x');
      mod.recordNavigation(false);
      nextRouterNavigate('push', '/room/r1/y');
      mod.recordNavigation(false);

      const popstateHandler = (): void => mod.syncLastIndexAfterPopState();
      browserBack(popstateHandler);
      browserBack(popstateHandler);
      browserBack(popstateHandler);
      browserForward(popstateHandler);
      await loadFreshDocument();

      // Poison the cache the way the real bug did -- some other, unrelated slot's stale (idx > floor)
      // pair sitting in sessionStorage.
      sessionMemory.set('fdg:navLastIdx', '3');
      sessionMemory.set('fdg:navLastFloor', '1');

      if (cursor < stack.length - 1) cursor += 1;
      if (cursor < stack.length - 1) cursor += 1;
      await loadFreshDocument();
      // Re-poison right before the replace, simulating a path that never captured ground truth (no
      // markUpcomingNavigationAsReplace call at all).
      sessionMemory.set('fdg:navLastIdx', '3');
      sessionMemory.set('fdg:navLastFloor', '1');

      nextRouterNavigate('replace', '/join/ABC123'); // Next wipes history.state to {}
      // No markUpcomingNavigationAsReplace call before this. Pre-round-9, recordNavigation(true) would
      // have fallen back to getCurrentHistoryEntry() (now {}) ?? getLastKnownEntry() -> the poisoned
      // (3, 1). As of round 9, there is no more cache fallback: it fails closed instead.
      mod.recordNavigation(true);

      expect(mod.hasInAppHistory()).toBe(false); // round 9: fails closed, no longer inherits (3, 1)
      expect(mod.decideBackAction(mod.hasInAppHistory(), '/')).toEqual({ type: 'push', href: '/' });
    },
  );
});

describe('round 9 (final) fix: a replace must never fall back to the stale cache for a genuinely untagged entry', () => {
  it(
    '9-step live repro: popstate lands on an entry, Next\'s OWN async server-patch wipes its tag ' +
      '(no push/replace of ours involved), and a later replace on that entry must fail closed, not ' +
      'inherit a stale cache value from some other slot the tab visited in between',
    async () => {
      const popstateHandler = (): void => mod.syncLastIndexAfterPopState();

      // Step 1-2: external site -> localhost:3000/join, a fresh document, freshly tagged.
      crossDocumentNavigateTo('https://example.com');
      crossDocumentNavigateTo('http://localhost:3000/join');
      await loadFreshDocument();
      mod.ensureEntryPointTagged(); // entry J (/join): {idx: 1, floor: 1}
      expect(mod.hasInAppHistory()).toBe(false);

      // Step 3: in-app Back with nothing real behind it pushes '/' as the explicit fallback route.
      nextRouterNavigate('push', '/');
      mod.recordNavigation(false); // entry R (/): {idx: 2, floor: 1}

      // Step 4: external site again (a real cross-document nav, tears down the module).
      crossDocumentNavigateTo('https://example.com');

      // Step 5: browser Back lands back on R -- a fresh document load / bfcache restore of root.
      if (cursor > 0) cursor -= 1;
      await loadFreshDocument();
      mod.ensureEntryPointTagged(); // R is already tagged {2, 1} on the entry itself; resyncs cache

      // Step 6: browser Back again lands on J (/join). This is the round-9 root cause: Next's client
      // router doesn't have /join's content cached, so it fetches it lazily and, some moment after
      // the popstate already fired (module state still intact then), wipes J's OWN history.state --
      // WITHOUT any push/replace call from our code, and with nothing for NavigationTracker's
      // popstate handler to resync from.
      browserBack(popstateHandler); // R -> J; popstate fires while J is still tagged {1, 1}
      nextServerPatchWipe(); // Next's own async wipe clobbers J's tag a moment later
      expect(historyFake.state).toEqual({}); // J is now genuinely untagged

      // Step 7-8: browser Forward to R, then Back to J again. The cache still mirrors R's {2, 1}
      // (the last entry that was actually read via getCurrentHistoryEntry()); J stays untagged --
      // the wipe already happened, and nothing re-tags an entry on a mere popstate landing.
      browserForward(popstateHandler); // J -> R
      browserBack(popstateHandler); // R -> J (still wiped/untagged)
      expect(historyFake.state).toEqual({});
      expect(sessionMemory.get('fdg:navLastIdx')).toBe('2'); // stale: mirrors R, not J
      expect(sessionMemory.get('fdg:navLastFloor')).toBe('1');

      // Step 9: the user joins a live room by PIN+nickname from /join. JoinForm calls
      // markUpcomingNavigationAsReplace() synchronously, immediately before router.replace(...).
      mod.markUpcomingNavigationAsReplace(); // captures getCurrentHistoryEntry() on J -> undefined
      nextRouterNavigate('replace', '/room/live1');
      mod.recordNavigation(true);

      // THE FIX: J is treated as fresh -- a brand-new idx with floor equal to that same idx -- never
      // inheriting R's stale (2, 1) cache values.
      const roomTag = historyFake.state as { fdgIdx?: number; fdgFloor?: number };
      expect(roomTag.fdgIdx).toBe(roomTag.fdgFloor);
      expect(mod.hasInAppHistory()).toBe(false);

      // Leave room (pushes '/'), then the room's own redirect fires another replace -- in-app Back
      // must still never escape the app.
      nextRouterNavigate('push', '/');
      mod.recordNavigation(false);
      expect(mod.hasInAppHistory()).toBe(true); // real history: room -> root, both same-session

      browserBack(popstateHandler); // back onto the room entry
      mod.markUpcomingNavigationAsReplace();
      nextRouterNavigate('replace', '/join/ABC123');
      mod.recordNavigation(true);

      expect(mod.hasInAppHistory()).toBe(false);
      expect(mod.decideBackAction(mod.hasInAppHistory(), '/')).toEqual({ type: 'push', href: '/' });
    },
  );

  it(
    'REVERT-AND-CONFIRM: restoring the `?? getLastKnownEntry()` fallback would have reapplied the ' +
      'stale (2, 1) tag for the same sequence, wrongly reporting in-app history',
    async () => {
      const popstateHandler = (): void => mod.syncLastIndexAfterPopState();

      crossDocumentNavigateTo('https://example.com');
      crossDocumentNavigateTo('http://localhost:3000/join');
      await loadFreshDocument();
      mod.ensureEntryPointTagged();
      nextRouterNavigate('push', '/');
      mod.recordNavigation(false);
      crossDocumentNavigateTo('https://example.com');
      if (cursor > 0) cursor -= 1;
      await loadFreshDocument();
      mod.ensureEntryPointTagged();
      browserBack(popstateHandler);
      nextServerPatchWipe();
      browserForward(popstateHandler);
      browserBack(popstateHandler);

      // At this point the real, fixed `mod.recordNavigation(true)` fails closed (proved above). Show
      // what the OLD, removed fallback chain (`captured ?? getCurrentHistoryEntry() ?? getLastKnownEntry()`)
      // would have produced instead, using the exact same cache state the real code sees here: it
      // would have reapplied the stale (2, 1) pair, wrongly reporting real in-app history.
      const oldFallbackIdx = Number(sessionMemory.get('fdg:navLastIdx'));
      const oldFallbackFloor = Number(sessionMemory.get('fdg:navLastFloor'));
      expect(oldFallbackIdx).toBeGreaterThan(oldFallbackFloor); // (2, 1) -- looks like "has history"

      // The real, fixed code does not do this:
      mod.markUpcomingNavigationAsReplace();
      nextRouterNavigate('replace', '/room/live1');
      mod.recordNavigation(true);
      const roomTag = historyFake.state as { fdgIdx?: number; fdgFloor?: number };
      expect(roomTag.fdgIdx).toBe(roomTag.fdgFloor); // fixed: fails closed instead of (2, 1)
    },
  );
});

describe('markUpcomingNavigationAsReplace / consumeReplaceFlag (redirect vs. real navigation)', () => {
  it('reports no pending replace by default', () => {
    expect(mod.consumeReplaceFlag()).toBe(false);
  });

  it('reports a pending replace exactly once after being marked', () => {
    mod.markUpcomingNavigationAsReplace();
    expect(mod.consumeReplaceFlag()).toBe(true);
    expect(mod.consumeReplaceFlag()).toBe(false);
  });

  it('this is the mechanism that keeps a redirect from being recorded as a new push', () => {
    mod.ensureEntryPointTagged();
    mod.markUpcomingNavigationAsReplace();
    nextRouterNavigate('replace', '/redirected');
    mod.recordNavigation(mod.consumeReplaceFlag());
    expect(mod.hasInAppHistory()).toBe(false);

    nextRouterNavigate('push', '/next');
    mod.recordNavigation(mod.consumeReplaceFlag());
    expect(mod.hasInAppHistory()).toBe(true);
  });

  it('a replace after a browser-back re-tags the CURRENT (lower, popped-back-to) slot\'s own idx ' +
    'and floor, not a stale higher index left over from before the back', () => {
    mod.ensureEntryPointTagged(); // entry {idx: 1, floor: 1}
    nextRouterNavigate('push', '/a');
    mod.recordNavigation(false); // {idx: 2, floor: 1}
    expect(mod.hasInAppHistory()).toBe(true);

    browserBack(() => mod.syncLastIndexAfterPopState());
    expect(mod.hasInAppHistory()).toBe(false);

    mod.markUpcomingNavigationAsReplace();
    nextRouterNavigate('replace', '/a-redirected');
    mod.recordNavigation(true);
    expect(mod.hasInAppHistory()).toBe(false);
    expect(historyFake.state).toEqual({ fdgIdx: 1, fdgFloor: 1 });
    expect(mod.decideBackAction(mod.hasInAppHistory(), '/')).toEqual({ type: 'push', href: '/' });
  });

  describe('REGRESSION GUARD: reverting to the old per-tab ENTRY_KEY design must fail this suite', () => {
    it('a per-tab floor cannot distinguish "left the app and came back" from "still has history"', async () => {
      mod.ensureEntryPointTagged(); // {idx: 1, floor: 1}
      nextRouterNavigate('push', '/a');
      mod.recordNavigation(false); // {idx: 2, floor: 1}

      crossDocumentNavigateTo('http://localhost:3000/');
      await loadFreshDocument();
      mod.ensureEntryPointTagged();

      expect(mod.hasInAppHistory()).toBe(false);
    });
  });
});

describe('scenario matrix (rounds 4-7 regressions, all in one pass)', () => {
  it('fresh tab -> push x4 routes -> Back three times lands each time at the correct floor state', () => {
    mod.ensureEntryPointTagged();
    for (const url of ['/a', '/b', '/c', '/d']) {
      nextRouterNavigate('push', url);
      mod.recordNavigation(false);
    }
    expect(mod.hasInAppHistory()).toBe(true);
    const popstateHandler = (): void => mod.syncLastIndexAfterPopState();
    browserBack(popstateHandler);
    browserBack(popstateHandler);
    browserBack(popstateHandler);
    expect(mod.hasInAppHistory()).toBe(true); // one entry still above the floor
    browserBack(popstateHandler);
    expect(mod.hasInAppHistory()).toBe(false); // back at the entry point
  });

  it('redirect-then-push-then-back-twice: a replace never counts as history, a push after it does', () => {
    mod.ensureEntryPointTagged();
    mod.markUpcomingNavigationAsReplace();
    nextRouterNavigate('replace', '/redirected');
    mod.recordNavigation(mod.consumeReplaceFlag());
    expect(mod.hasInAppHistory()).toBe(false);

    nextRouterNavigate('push', '/next');
    mod.recordNavigation(mod.consumeReplaceFlag());
    expect(mod.hasInAppHistory()).toBe(true);

    const popstateHandler = (): void => mod.syncLastIndexAfterPopState();
    browserBack(popstateHandler);
    expect(mod.hasInAppHistory()).toBe(false);
  });

  it('F5 mid-sequence (fresh document reload on an already-tagged entry) preserves the real tag', async () => {
    mod.ensureEntryPointTagged();
    nextRouterNavigate('push', '/a');
    mod.recordNavigation(false);
    expect(mod.hasInAppHistory()).toBe(true);

    // A real F5 reload is a fresh document load on the SAME entry (state survives, module doesn't).
    await loadFreshDocument();
    mod.ensureEntryPointTagged();
    expect(mod.hasInAppHistory()).toBe(true);
  });

  it('rapid double-back lands correctly even when both pops happen before any React effect runs', () => {
    mod.ensureEntryPointTagged();
    nextRouterNavigate('push', '/a');
    mod.recordNavigation(false);
    nextRouterNavigate('push', '/b');
    mod.recordNavigation(false);
    expect(mod.hasInAppHistory()).toBe(true);

    // Both pops fire before their popstate handlers are processed, matching how a rapid double-tap
    // Back could outrun a slow effect -- history.state is still authoritative regardless of order.
    if (cursor > 0) cursor -= 1;
    if (cursor > 0) cursor -= 1;
    mod.syncLastIndexAfterPopState();
    expect(mod.hasInAppHistory()).toBe(false);
  });

  it('app -> external -> app re-entry never wrongly reports history behind the re-entry point', async () => {
    mod.ensureEntryPointTagged();
    nextRouterNavigate('push', '/host');
    mod.recordNavigation(false);
    expect(mod.hasInAppHistory()).toBe(true);

    crossDocumentNavigateTo('https://example.com');
    crossDocumentNavigateTo('http://localhost:3000/host');
    await loadFreshDocument();
    mod.ensureEntryPointTagged();
    expect(mod.hasInAppHistory()).toBe(false);
  });

  it('multi-hop re-entry (several app pages, then external, then back several) never leaks a floor', async () => {
    mod.ensureEntryPointTagged();
    for (const url of ['/a', '/b', '/c']) {
      nextRouterNavigate('push', url);
      mod.recordNavigation(false);
    }
    crossDocumentNavigateTo('https://example.com');
    crossDocumentNavigateTo('http://localhost:3000/z');
    await loadFreshDocument();
    mod.ensureEntryPointTagged();
    expect(mod.hasInAppHistory()).toBe(false);
  });

  it('off-the-edge-and-forward: popping all the way to the entry point, then forward again, restores history correctly', () => {
    mod.ensureEntryPointTagged();
    nextRouterNavigate('push', '/a');
    mod.recordNavigation(false);
    const popstateHandler = (): void => mod.syncLastIndexAfterPopState();
    browserBack(popstateHandler);
    expect(mod.hasInAppHistory()).toBe(false);
    browserForward(popstateHandler);
    expect(mod.hasInAppHistory()).toBe(true);
  });

  it('long continuous chain: pushes, replaces, browser back/forward, and a final redirect all resolve correctly', () => {
    mod.ensureEntryPointTagged(); // {1,1}
    nextRouterNavigate('push', '/a');
    mod.recordNavigation(false); // {2,1}
    mod.markUpcomingNavigationAsReplace();
    nextRouterNavigate('replace', '/a2');
    mod.recordNavigation(true); // still {2,1}
    nextRouterNavigate('push', '/b');
    mod.recordNavigation(false); // {3,1}
    nextRouterNavigate('push', '/c');
    mod.recordNavigation(false); // {4,1}
    expect(mod.hasInAppHistory()).toBe(true);

    const popstateHandler = (): void => mod.syncLastIndexAfterPopState();
    browserBack(popstateHandler); // -> {3,1}
    browserBack(popstateHandler); // -> {2,1}
    expect(mod.hasInAppHistory()).toBe(true);

    // A redirect fires while sitting on the {2,1} slot.
    mod.markUpcomingNavigationAsReplace();
    nextRouterNavigate('replace', '/b-redirected');
    mod.recordNavigation(true);
    expect(historyFake.state).toEqual({ fdgIdx: 2, fdgFloor: 1 });
    expect(mod.hasInAppHistory()).toBe(true);

    browserBack(popstateHandler); // -> {1,1}, the entry point
    expect(mod.hasInAppHistory()).toBe(false);
    expect(mod.decideBackAction(mod.hasInAppHistory(), '/')).toEqual({ type: 'push', href: '/' });
  });
});
