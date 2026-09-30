/**
 * The live-event window: which `MatchEvent`s a round is allowed to react to.
 *
 * ## The problem
 *
 * The transport re-sends the fixture's **full**, id-stable event list on every poll, and the reducer
 * de-duplicates per round (`RoundRecord.observedEventIds`). Per-round dedupe alone means a *new*
 * round receives every earlier event of the match as a first-time batch — so a multi-round live
 * game (M7 "next goal", bingo cards, event roulette) would settle on a goal scored an hour before the
 * round opened. Events carry only a match clock (`minute` / `extraMinute`), never a wall-clock time,
 * so the engine cannot simply ask "did this happen after the round opened?".
 *
 * ## The rule (`since-round-open`, the default for every live module)
 *
 * A round reacts only to events that are **not part of its baseline** and **not earlier on the match
 * clock than the baseline**:
 *
 * 1. **Baseline = the pre-round history.** Established exactly once per round, by the first of:
 *    - **pre-kickoff at build time** — the round was built before the fixture's scheduled kickoff
 *      (`now < Date.parse(fixture.kickoff)` with the fixture still `SCHEDULED` in the data context).
 *      Nothing can have happened yet, so the baseline is empty and every later event is in-window.
 *      This matters because the transport never delivers an empty list, so a pre-kickoff round would
 *      otherwise take its first post-kickoff batch as history.
 *    - **the first `MATCH_EVENTS` batch the round receives** — otherwise. The transport delivers the
 *      full list to a round immediately after it opens (from the fixture watcher's cache, or an
 *      immediate first poll), so that batch *is* the match as it stood when the round opened. Every
 *      id in it is recorded as seen and never delivered to the module as a live event; the module
 *      gets it once as `history` instead (context such as the current score or "the match is over").
 *      An empty batch is a valid (pre-kickoff) baseline.
 * 2. **Id exclusion.** Baseline ids join `observedEventIds`, so the per-poll full-list re-send is a
 *    no-op for them forever — the same idempotency every live round already had.
 * 3. **Clock floor.** `openedAt` is the latest match clock in the baseline. A later batch's new id
 *    whose clock is *strictly earlier* than `openedAt` is a late-published / back-filled history
 *    event (feeds do add plays retroactively) and is dropped — not recorded, simply re-filtered on
 *    every poll, which keeps it deterministic. Events *at* `openedAt` are kept: the minute the round
 *    opened in is still being played. `FULL_TIME` is exempt from the floor: a whistle not in the
 *    baseline blew after the round opened, whatever minute the feed stamps on it.
 *
 * Why both cuts and not one: ids alone cannot see back-filled history (a new id for an old play);
 * the clock alone cannot tell a 32' goal the round saw at open from a second 32' goal after it, and
 * with no baseline it has no "open" clock at all. Known, accepted limit: an event that happens after
 * the round opened but lands in the *same* poll as its baseline counts as history (at most one poll
 * interval, ~15s); modules document what that means for them (M7: that goal is "before" the round).
 *
 * ## `whole-match`
 *
 * For modules whose round spans the whole fixture and must see all of it (M1's slip settles on the
 * final score, including goals scored before a late-opened round): no baseline, no floor — the
 * pre-existing per-round id dedupe only. `RoundRecord.liveWindow` is `null` for them.
 */

import type { Fixture, MatchEvent } from '@fdg/football-data';
import type { MatchClock } from './match-events.js';
import { clockOf, compareMatchClock, latestClockOf, laterClock } from './match-events.js';

export type LiveEventWindowMode = 'whole-match' | 'since-round-open';

export const DEFAULT_LIVE_EVENT_WINDOW: LiveEventWindowMode = 'since-round-open';

/** How a round's baseline was established. */
export type LiveBaselineSource = 'pre-kickoff' | 'first-batch';

/** Engine-owned per-round window state (`since-round-open` rounds only). JSON-serializable. */
export interface LiveEventWindow {
  /** `null` until the baseline exists; until then the round has seen nothing of the match. */
  readonly baselineSource: LiveBaselineSource | null;
  /** Latest match clock in the baseline — "the match time the round opened at". `null` = before kickoff. */
  readonly openedAt: MatchClock | null;
  /** Latest match clock the round has seen (baseline or in-window). The best "current minute" the feed gives. */
  readonly latest: MatchClock | null;
}

/** Event types exempt from the clock floor (see module doc, rule 3). */
const FLOOR_EXEMPT: readonly MatchEvent['type'][] = ['FULL_TIME'];

/**
 * The window a freshly built round starts with. `null` for `whole-match` modules. Pure: the
 * kickoff comparison uses the injected `now`, never the system clock.
 */
export const initialLiveWindow = (
  mode: LiveEventWindowMode,
  fixture: Fixture | null,
  now: number,
): LiveEventWindow | null => {
  if (mode === 'whole-match') return null;
  const kickoffMs = fixture === null ? Number.NaN : Date.parse(fixture.kickoff);
  const preKickoff = fixture !== null && fixture.status === 'SCHEDULED' && Number.isFinite(kickoffMs) && now < kickoffMs;
  return preKickoff
    ? { baselineSource: 'pre-kickoff', openedAt: null, latest: null }
    : { baselineSource: null, openedAt: null, latest: null };
};

export type LiveWindowStep =
  /** This batch established the baseline: `history` is the de-duplicated batch, never reacted to. */
  | { readonly kind: 'baseline'; readonly window: LiveEventWindow; readonly history: readonly MatchEvent[] }
  /**
   * `fresh` are the unseen, in-window events of this batch (possibly none). `window` is `null` for a
   * `whole-match` round, where every unseen event is fresh.
   */
  | { readonly kind: 'events'; readonly window: LiveEventWindow | null; readonly fresh: readonly MatchEvent[] };

const dedupe = (events: readonly MatchEvent[], seen: ReadonlySet<string>): readonly MatchEvent[] => {
  const known = new Set(seen);
  const out: MatchEvent[] = [];
  for (const event of events) {
    if (known.has(event.id)) continue;
    known.add(event.id);
    out.push(event);
  }
  return out;
};

/**
 * Pure: apply one `MATCH_EVENTS` batch to a round's window. `seen` is the round's
 * `observedEventIds`. With `window === null` (`whole-match`) this is plain id dedupe.
 */
export const stepLiveWindow = (
  window: LiveEventWindow | null,
  batch: readonly MatchEvent[],
  seen: ReadonlySet<string>,
): LiveWindowStep => {
  const unseen = dedupe(batch, seen);
  if (window === null) return { kind: 'events', window: null, fresh: unseen };
  if (window.baselineSource === null) {
    const openedAt = latestClockOf(unseen);
    return {
      kind: 'baseline',
      window: { baselineSource: 'first-batch', openedAt, latest: openedAt },
      history: unseen,
    };
  }
  const floor = window.openedAt;
  const fresh =
    floor === null
      ? unseen
      : unseen.filter(
          (event) => FLOOR_EXEMPT.includes(event.type) || compareMatchClock(clockOf(event), floor) >= 0,
        );
  return {
    kind: 'events',
    window: { ...window, latest: laterClock(window.latest, latestClockOf(fresh)) },
    fresh,
  };
};
