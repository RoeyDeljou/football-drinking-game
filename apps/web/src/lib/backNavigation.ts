/**
 * Pure decision helper for the shared `BackButton`, plus the in-app navigation tracker it relies
 * on: whether it's safe to pop the browser's own history (there is a real, still-in-app history
 * entry behind the current one) or whether it must instead push an explicit fallback route
 * (arrived via a direct link / bookmark / new tab, or the user has already popped all the way back
 * to where this tab's session started, so popping further could leave the app entirely).
 *
 * HISTORY: this went through several shapes, each one QA broke live:
 *   - v1: a monotonic "have you ever navigated" counter. Wrong because it only ever counts up, so
 *     going back and then trying in-app Back again still thought there was history ahead.
 *   - v2: a tagged, monotonically-increasing POSITION index per history entry (`fdgIdx`, written
 *     into `history.state`), compared against a single tab-wide "entry point" index kept in
 *     `sessionStorage`. Fixed v1's bug.
 *   - v3: fixed a stale "last known index" used when re-tagging a `replace`d slot after browser
 *     back (see `syncLastIndexAfterPopState` below — that part is still correct and kept as-is).
 *   - v4: v2/v3's tab-wide entry-point index was still wrong in kind, not just in a
 *     specific sequence — it lived in `sessionStorage`, ONE value for the whole tab, not one per
 *     history entry. Leaving the app for an external site (a real top-level navigation, not a SPA
 *     route change) and typing an app URL back in creates a brand-new history entry that gets
 *     tagged with a fresh, higher `fdgIdx` — but the tab-wide entry point never moved, so
 *     `hasInAppHistory()` wrongly saw "history behind this" even though the entry immediately
 *     behind the new one is the external site, not more in-app history. QA reproduced this live:
 *     fresh tab -> `/` -> push `/host` -> type an external URL in the address bar -> type an app
 *     URL back in -> tap in-app Back -> lands on the external site.
 *
 *     THE STRUCTURAL FIX: the floor (the index below which there's no real in-app history) now
 *     travels WITH each entry, in `history.state` itself, as `fdgFloor`, right alongside `fdgIdx`.
 *     There is no more tab-wide floor value anywhere:
 *       - A real in-app PUSH mints a new `fdgIdx` but INHERITS the floor of the entry it was
 *         pushed from unchanged.
 *       - A REPLACE keeps both the slot's own current index (v3's fix, unchanged) AND its floor
 *         unchanged — a redirect never moves the floor.
 *       - An UNTAGGED entry — no `fdgIdx`/`fdgFloor` at all, meaning this document was never
 *         tagged before (a genuinely fresh load, OR a re-entry into the app after leaving it for
 *         an external site) — gets a BRAND NEW floor equal to its OWN index. There is, by
 *         definition, no real in-app history behind an untagged entry, no matter what stale
 *         `sessionStorage` state happens to be lying around from an earlier visit in this tab.
 *     `hasInAppHistory()` becomes purely: read `{ fdgIdx, fdgFloor }` off the CURRENT entry's
 *     `history.state` and return `fdgIdx > fdgFloor`. No separate "entry index" lookup at all.
 *
 *     This also structurally closes the previously-documented "new tab inherits sessionStorage"
 *     limitation: since the floor no longer lives in `sessionStorage`, a new tab's fresh (and
 *     therefore untagged) entry always gets its own fresh floor equal to its own index, regardless
 *     of whatever counter/index values that tab happens to have inherited.
 *
 * MECHANISM: every history entry this tab tags gets `{ fdgIdx, fdgFloor }` written into
 * `window.history.state` via `history.replaceState` (edits the CURRENT entry's state in place,
 * never creates a new entry — safe to call after Next's router has already pushed/replaced the
 * entry we're tagging). `history.state` is not something we reset on back/forward ourselves: the
 * browser restores whatever state object was associated with an entry when it's revisited via
 * popstate, so reading `window.history.state` at click-time always reflects the CURRENT entry,
 * correctly restored for browser back/forward too.
 *
 * `fdgIdx` values are still minted from a monotonically-increasing counter kept in
 * `sessionStorage` (`COUNTER_KEY`) purely so each new in-app entry within this tab gets a value
 * higher than the ones before it — the counter itself carries no floor/entry-point meaning
 * anymore, so it inheriting stale values in a new tab (same pre-existing limitation as before) is
 * harmless: it only affects the numbers minted, never whether an entry is on-or-above its own
 * floor.
 *
 * `LAST_KEY` / `LAST_FLOOR_KEY` in `sessionStorage` are a resilience cache, NOT a source of truth:
 * they always mirror the CURRENTLY-tagged entry's own `{ fdgIdx, fdgFloor }`, kept in sync by
 * `tagCurrentHistoryEntry` (every tag), `syncLastIndexAfterPopState` (every popstate / bfcache
 * `pageshow` restore), and `ensureEntryPointTagged` (every mount, even when the entry was already
 * tagged). They exist purely as a defensive fallback — see v5 below for why they must never be the
 * PRIMARY source of truth for a replace's floor decision.
 *
 * v5 — root cause, confirmed by reading Next.js 14.2.35's own source: every
 * `router.push`/`router.replace` call wipes `window.history.state` back to essentially empty
 * (`HistoryUpdater` runs with `preserveCustomHistoryState: false` on every navigation). That means
 * by the time `recordNavigation(true)` runs (the replace handler, wired up in `NavigationTracker`
 * to fire on the pathname-change effect AFTER `router.replace(...)` has already run), `history.state`
 * for the slot being re-tagged has very likely already been clobbered by Next's own machinery — so
 * `recordNavigation(true)` has always had to fall back to the `LAST_KEY`/`LAST_FLOOR_KEY`
 * sessionStorage cache of "what were this entry's values last time we saw them".
 *
 * That cache is resynced in several places (tagging, popstate, now also pageshow and idempotent
 * re-tagging), but a CROSS-DOCUMENT history traversal (browser back/forward across a real
 * top-level navigation — e.g. app -> external site -> back into the app via the URL bar, or a
 * bfcache restore that doesn't fire the events this module listens for in every browser) can still
 * leave it holding another entry's/another document's stale `{idx, floor}`. If a `replace` then
 * happens to fire while sitting on a document-ROOT entry with that stale, wrongly-"has real
 * history" cache value, it wrongly re-tags with `idx > floor` — letting a later in-app Back exit the
 * app entirely. No amount of adding more resync hooks closes this in general, because the bug is
 * "the cache can be read at a moment it's stale", not "the cache isn't resynced enough places".
 *
 * THE FIX: stop depending on the cache's freshness for a replace's floor decision. Instead,
 * `markUpcomingNavigationAsReplace()` — which every replacing call site invokes synchronously,
 * BEFORE calling `router.replace(...)` and therefore strictly before Next's navigation machinery has
 * any chance to wipe `history.state` for THIS specific replace — synchronously reads
 * `getCurrentHistoryEntry()` (ground truth: the CURRENT entry's own, still-intact tag, at the one
 * instant it's guaranteed correct) and stashes it as `capturedReplaceSnapshot`. `recordNavigation(true)`
 * then uses THAT captured snapshot first, falling back to a live re-read of `history.state`.
 *
 * v6 (THIS version) — one more root cause, again confirmed by reading Next.js 14.2.35's own source:
 * v5 still fell back to the `LAST_KEY`/`LAST_FLOOR_KEY` sessionStorage cache as a last resort when
 * BOTH the captured snapshot AND a live re-read of `history.state` came back empty. That's exactly
 * what happens when a `popstate` lands on a page whose Next.js router cache doesn't already hold that
 * page's content: Next fetches it lazily (an `ACTION_SERVER_PATCH`), and that reducer runs with
 * `preserveCustomHistoryState: false`, so `HistoryUpdater` REWRITES the landed-on entry's
 * `history.state` and WIPES our tag — even though no push/replace was ever explicitly called by our
 * own code for that transition, and nothing in `NavigationTracker`'s popstate handling has any tag to
 * resync FROM for it. The entry just sits untagged. If a `replace` then fires while sitting on that
 * now-untagged entry, `getCurrentHistoryEntry()` correctly returns nothing — but v5 then fell back to
 * `getLastKnownEntry()`, a cache of "whatever entry we last saw", which by then could reflect a
 * COMPLETELY DIFFERENT entry visited earlier in the session. The replace wrongly re-tagged the
 * current entry with THAT stale, unrelated `{idx, floor}` pair (often `idx > floor`), and a later
 * in-app Back could walk right past the real app boundary.
 *
 * THE FIX: a replace must NEVER fall back to the sessionStorage cache to decide the current entry's
 * floor/idx. `markUpcomingNavigationAsReplace()` and `recordNavigation(true)`'s live-read fallback
 * both now stop at `getCurrentHistoryEntry()` — if that's `undefined`, the entry is genuinely
 * untagged (fresh document OR wiped by Next's server patch, indistinguishable and NEEDN'T be
 * distinguished) and is treated EXACTLY like any other untagged entry: mint a brand-new index and set
 * `floor = idx`, i.e. fail closed, "no history behind me". The `LAST_KEY`/`LAST_FLOOR_KEY` cache is
 * still maintained (by `tagCurrentHistoryEntry`, `syncLastIndexAfterPopState`, and
 * `ensureEntryPointTagged`) since it may still be useful as a defensive resync source elsewhere, but
 * it is no longer consulted anywhere to decide what floor/idx a currently-untagged entry gets.
 */

const COUNTER_KEY = 'fdg:navIdxCounter';
const LAST_KEY = 'fdg:navLastIdx';
const LAST_FLOOR_KEY = 'fdg:navLastFloor';

type TaggedHistoryState = { readonly fdgIdx?: number; readonly fdgFloor?: number } & Record<string, unknown>;

type TaggedEntry = { readonly idx: number; readonly floor: number };

const readSessionNumber = (key: string): number | undefined => {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw === null) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    // sessionStorage can throw in locked-down/private-browsing contexts; fail closed.
    return undefined;
  }
};

const writeSessionNumber = (key: string, value: number): void => {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(key, String(value));
  } catch {
    // Nothing we can do without storage; hasInAppHistory will fail closed (no history).
  }
};

/** Mint the next unique index for this tab session, persisting the counter itself. */
const mintNextIndex = (): number => {
  const next = (readSessionNumber(COUNTER_KEY) ?? 0) + 1;
  writeSessionNumber(COUNTER_KEY, next);
  return next;
};

/** Reads the CURRENT history entry's tagged `{ fdgIdx, fdgFloor }` directly from `history.state`. */
const getCurrentHistoryEntry = (): TaggedEntry | undefined => {
  if (typeof window === 'undefined') return undefined;
  try {
    const state = window.history.state as TaggedHistoryState | null;
    if (typeof state?.fdgIdx === 'number' && typeof state?.fdgFloor === 'number') {
      return { idx: state.fdgIdx, floor: state.fdgFloor };
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * The last-known `{ idx, floor }` for the slot we're CURRENTLY sitting on (sessionStorage cache).
 * NOTE: as of v6, this must never be consulted to decide the floor/idx for a currently-UNTAGGED
 * entry (a replace's fallback) — see the v6 module doc above. It remains valid for other purposes,
 * e.g. `recordNavigation(false)` reading the PREVIOUS entry's floor to inherit for a real push, since
 * that previous entry is expected to already be tagged and this is just resilience against it not
 * being directly reachable at push time.
 */
const getLastKnownEntry = (): TaggedEntry | undefined => {
  const idx = readSessionNumber(LAST_KEY);
  const floor = readSessionNumber(LAST_FLOOR_KEY);
  return idx !== undefined && floor !== undefined ? { idx, floor } : undefined;
};

/**
 * Tags the CURRENT history entry in place (does not create a new entry) with both its own index
 * and its floor, and mirrors both into the "last known" sessionStorage cache for this slot.
 */
const tagCurrentHistoryEntry = (entry: TaggedEntry): void => {
  if (typeof window === 'undefined') return;
  try {
    const existing = (window.history.state ?? {}) as Record<string, unknown>;
    window.history.replaceState({ ...existing, fdgIdx: entry.idx, fdgFloor: entry.floor }, '');
    writeSessionNumber(LAST_KEY, entry.idx);
    writeSessionNumber(LAST_FLOOR_KEY, entry.floor);
  } catch {
    // If history.replaceState is unavailable/throws, the entry stays untagged and
    // hasInAppHistory() fails closed for it — safe (falls back to an explicit push).
  }
};

/**
 * Call once, on mount, before any pathname-change handling. Tags this tab's current history entry
 * if it isn't already tagged: a fresh tab, a direct link, a brand-new document navigation, OR a
 * re-entry into the app after having left it for an external site all look identical here — an
 * untagged entry — and ALL of them get a brand-new floor equal to their own index, because by
 * definition there is no real in-app history behind an entry nobody has tagged yet. This is what
 * makes leaving-and-returning-to the app safe: no stale sessionStorage value can ever override it,
 * because the floor is never read from sessionStorage for this decision — only `history.state`.
 * Idempotent: safe to call again (e.g. React StrictMode double-invoking effects, or a later
 * remount) once the entry is already tagged.
 */
export const ensureEntryPointTagged = (): void => {
  if (typeof window === 'undefined') return;
  const existing = getCurrentHistoryEntry();
  if (existing !== undefined) {
    // Already tagged — nothing to (re-)tag, but still resync the resilience cache to this SLOT's
    // own real values. Defensive: closes the gap where a cross-document re-entry or bfcache restore
    // leaves an already-tagged entry's cache mirror stale from wherever the tab was before.
    writeSessionNumber(LAST_KEY, existing.idx);
    writeSessionNumber(LAST_FLOOR_KEY, existing.floor);
    return;
  }
  const idx = mintNextIndex();
  tagCurrentHistoryEntry({ idx, floor: idx });
};

/**
 * `NavigationTracker`-only: call once per real client-side pathname change that was NOT caused by
 * the browser's own back/forward (popstate) — those already carry their own restored, correctly
 * tagged `history.state` and must not be re-tagged. `isReplace` distinguishes a `router.replace(...)`
 * redirect (reuses the current slot; keeps its own `{idx, floor}` if reachable, otherwise fails
 * closed rather than minting a new index or moving the floor) from a real `router.push(...)`-style
 * navigation (mint a new index for the new entry, but INHERIT the floor of the entry it was pushed
 * from unchanged).
 */
export const recordNavigation = (isReplace: boolean): void => {
  if (typeof window === 'undefined') return;
  if (isReplace) {
    // PRIMARY: the ground-truth snapshot captured synchronously by `markUpcomingNavigationAsReplace`
    // BEFORE `router.replace(...)` ran and before Next's own navigation machinery had any chance to
    // wipe `history.state` for this specific replace. This never depends on the sessionStorage
    // cache's freshness — see the v5 module doc above for why the cache alone is not sufficient.
    const captured = capturedReplaceSnapshot;
    capturedReplaceSnapshot = undefined;
    // Fallback, only for the (unexpected) case a replace was recorded without ever going through
    // `markUpcomingNavigationAsReplace()`: a live re-read of `history.state` (in case it genuinely
    // wasn't clobbered). Deliberately NO further fallback to the sessionStorage cache here — see the
    // v6 module doc above: an entry that's genuinely untagged at this point (whether because it's a
    // fresh document or because Next's own server-patch wiped an existing tag) must fail closed, i.e.
    // be treated as fresh (new idx, floor = that same idx), never inherit some OTHER entry's cached
    // idx/floor from `getLastKnownEntry()`.
    const last = captured ?? getCurrentHistoryEntry();
    const idx = last?.idx ?? mintNextIndex();
    const floor = last?.floor ?? idx;
    tagCurrentHistoryEntry({ idx, floor });
    return;
  }
  // A real push: the new entry inherits the floor of the entry it was pushed FROM. We're already
  // sitting on the new entry by the time this runs (the pathname already changed), so the previous
  // entry's own state isn't reachable directly — the last-known cache is exactly that entry's own
  // values, since it's kept in sync on every tag and every popstate.
  const previousFloor = getLastKnownEntry()?.floor;
  const idx = mintNextIndex();
  tagCurrentHistoryEntry({ idx, floor: previousFloor ?? idx });
};

/**
 * `NavigationTracker`-only: call on every `popstate` event, and on every `pageshow` event whose
 * `event.persisted` is true (a bfcache restore — a cross-document traversal that does not always
 * fire `popstate` in a way that resyncs this module's state), synchronously, before anything else
 * reads the last-known cache. By the time either event fires, `window.history.state` has already
 * been restored by the browser to the entry being landed on, so reading it here and mirroring it
 * into the last-known cache keeps that cache from ever drifting away from the tab's real current
 * position. This is purely defensive (see the v5 module doc above: `recordNavigation(true)` no
 * longer depends on this cache being fresh as its PRIMARY source of truth), but it still matters as
 * the fallback path and for any other code that reads the cache.
 */
export const syncLastIndexAfterPopState = (): void => {
  const entry = getCurrentHistoryEntry();
  if (entry !== undefined) {
    writeSessionNumber(LAST_KEY, entry.idx);
    writeSessionNumber(LAST_FLOOR_KEY, entry.floor);
  }
};

/**
 * Is there a real, still-in-app history entry behind the current one? Reads `{ fdgIdx, fdgFloor }`
 * directly off the CURRENT entry's `history.state` — no separate, tab-wide lookup at all — and
 * returns true only when the index is strictly greater than that SAME entry's own floor.
 */
export const hasInAppHistory = (): boolean => {
  const entry = getCurrentHistoryEntry();
  return entry !== undefined && entry.idx > entry.floor;
};

/** Test-only: clear all tracked state so specs don't leak across cases. */
export const resetInAppHistoryForTests = (): void => {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(COUNTER_KEY);
    window.sessionStorage.removeItem(LAST_KEY);
    window.sessionStorage.removeItem(LAST_FLOOR_KEY);
  } catch {
    // ignore
  }
};

// Module-level (not sessionStorage) on purpose: this only needs to bridge a single synchronous
// call site -> the tracker's next effect run, never survive a reload.
let nextNavigationIsReplace = false;

// The ground-truth snapshot of the CURRENT entry's own `{idx, floor}`, captured synchronously at
// the one instant it's guaranteed correct: inside `markUpcomingNavigationAsReplace()`, called by
// every replacing call site BEFORE `router.replace(...)` runs. See the v5 module doc above — this
// is what lets `recordNavigation(true)` stop depending on the sessionStorage cache's freshness.
let capturedReplaceSnapshot: TaggedEntry | undefined;

/**
 * Call synchronously, immediately before `router.replace(...)`, at any call site that redirects
 * rather than navigates (the user didn't choose to go anywhere; the app is correcting the URL).
 * Marks the pathname change that's about to happen as one to record via the replace path, AND
 * synchronously captures the current entry's own real `{idx, floor}` — the only moment it's
 * guaranteed not to have been wiped yet by Next's own `router.replace` machinery (which clobbers
 * `history.state` on every navigation; see the v5 module doc above).
 */
export const markUpcomingNavigationAsReplace = (): void => {
  nextNavigationIsReplace = true;
  // Deliberately NOT `?? getLastKnownEntry()` — see the v6 module doc above. If the current entry is
  // genuinely untagged right now (a fresh document, OR Next's own async server-patch already wiped
  // this entry's tag some time before this replace fires), that is exactly the "no real in-app
  // history behind me" case, and `recordNavigation(true)` must be free to mint a brand-new
  // `{idx, floor: idx}` for it rather than inheriting some UNRELATED entry's stale cached values.
  capturedReplaceSnapshot = getCurrentHistoryEntry();
};

/**
 * `NavigationTracker`-only: consumes (reads and clears) the replace flag. Returns true if the
 * pathname change currently being processed was flagged as a `replace`.
 */
export const consumeReplaceFlag = (): boolean => {
  const wasReplace = nextNavigationIsReplace;
  nextNavigationIsReplace = false;
  return wasReplace;
};

export type BackAction = { readonly type: 'history' } | { readonly type: 'push'; readonly href: string };

export const decideBackAction = (hasHistory: boolean, fallbackHref: string): BackAction =>
  hasHistory ? { type: 'history' } : { type: 'push', href: fallbackHref };
