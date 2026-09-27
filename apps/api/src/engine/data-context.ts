/**
 * Builds the engine's `RoundDataContext` from `@fdg/football-data`, for whichever category
 * (`matchday` | `general`) the room's active/selected game belongs to.
 *
 * Matchday rooms are prefetched once (see `runMatchdayPrefetch`, driven from the loading screen)
 * and the resulting bundle is cached per room (`matchday-cache.ts`) — every later dispatch reads
 * the cache instead of hitting the network again. General rooms share one process-wide dataset
 * built lazily on first use, or earlier by the boot warm-up (`AppContext.generalDataset`,
 * see general-dataset-access.ts).
 *
 * Gameday rooms (one room, rounds rotating across every fixture currently live in one competition)
 * work the same way but through `runGamedayPrefetch`/`gameday-cache.ts`: a `GamedayBundle` is cached
 * per room, `refreshGamedayLiveSet` keeps its live-fixture pool current (see its doc comment for the
 * drift policy), and `buildRoundDataContext` picks which of that pool's `MatchdayBundle`s to feed in
 * for the round currently being generated — round-robin over the room's own round count so far. The
 * engine itself (`packages/game-core`) is never touched or made aware any of this is happening: from
 * its point of view this is an ordinary matchday round, same as the single-fixture case.
 */

import type { DataRequirementKey, GameCategory, RoomAction, RoomState, RoundDataContext } from '@fdg/game-core';
import { checkModulePlayable, EMPTY_DATA_CONTEXT } from '@fdg/game-core';
import type { CompetitionId, FixtureId, GamedayBundle, MatchdayBundle, PrefetchStepId, PrefetchStepStatus } from '@fdg/football-data';
import { MatchdayPrefetcher, PREFETCH_STEP_ORDER } from '@fdg/football-data';
import type { RoomId } from '@fdg/game-core';
import type { AppContext } from '../context.js';
import { getCachedBundle, setCachedBundle } from './matchday-cache.js';
import type { GamedayCacheEntry, RoundKey } from './gameday-cache.js';
import { getCachedGameday, getPinnedRoundFixture, setCachedGameday } from './gameday-cache.js';
import type { RoomMeta } from '../rooms/store.js';

/**
 * One candidate `RoundDataContext` the dispatch layer may hand to `reduceRoom` while trying to
 * generate a round — see `RoundDataResolution`'s doc comment for why there can be more than one and
 * how the caller (`dispatch.ts`) is expected to use them.
 */
export interface RoundDataCandidate {
  readonly context: RoundDataContext;
  /**
   * Set only when `context` came from a specific gameday-pool fixture that a genuine round-generation
   * attempt (`isGenuineRoundGeneration`) might commit to. `null` for every other context — a
   * single-fixture matchday room, a general room, an already-generated round being re-read, or a
   * `SELECT_GAME` probe — none of which are ever pinned by `dispatch.ts` regardless of this field.
   */
  readonly fixtureId: FixtureId | null;
}

/**
 * What `buildRoundDataContext` actually hands back to a dispatch: an ordered, non-empty list of
 * candidates to try against `reduceRoom` in turn (see `dispatch.ts`'s `dispatchAction`), plus the
 * `RoundKey` a fixture pin must be written for *if and only if* the reducer ends up accepting a round
 * built from one of them.
 *
 * This is the fix for the recurring "gameday pinning" bug class: earlier code (`pickAndPinFixture`,
 * now deleted) wrote `pinRoundFixture` speculatively, before `reduceRoom` had run at all — so a
 * rejected generation attempt (any reason: `ROUND_GENERATION_FAILED` from the module's own
 * `generateRound`, `NOT_ENOUGH_PLAYERS`, `LOADING_INCOMPLETE`, …) still left a pin behind, wedging
 * every later retry onto the same fixture forever, even when a different module or a different,
 * still-live fixture could have served the round fine. Fixed by never writing a pin from in here at
 * all: this module only ever *proposes* candidates. `dispatch.ts` is the sole writer of
 * `pinRoundFixture`, and only calls it after `reduceRoom` has actually accepted a round built from one
 * of these candidates, using that specific candidate's `fixtureId` — never ahead of time.
 *
 * For everything except a genuine gameday round-generation attempt, `candidates` has exactly one
 * entry and `gamedayPinKey` is `null` — `dispatch.ts` calls `reduceRoom` once, exactly as before, and
 * never pins anything. Only `isGenuineRoundGeneration` (`START_SESSION`/`ADVANCE` about to call
 * `generateRound`) ever produces more than one candidate or a non-null `gamedayPinKey`.
 */
export interface RoundDataResolution {
  readonly candidates: readonly RoundDataCandidate[];
  readonly gamedayPinKey: RoundKey | null;
}

const singleCandidate = (context: RoundDataContext): RoundDataResolution => ({
  candidates: [{ context, fixtureId: null }],
  gamedayPinKey: null,
});

const bundleToContext = (bundle: MatchdayBundle): RoundDataContext => ({
  fixture: bundle.fixture,
  lineups: bundle.lineups,
  live: bundle.live,
  teams: [bundle.fixture.homeTeam, bundle.fixture.awayTeam],
  players: bundle.squads.flatMap((squad) => squad.players),
  profiles: bundle.profiles,
  seasonStats: bundle.seasonStats,
  quality: bundle.quality,
});

/** Runs the four-step prefetch, caches the bundle, and (optionally) reports live progress. */
export const runMatchdayPrefetch = async (
  ctx: AppContext,
  roomId: RoomId,
  fixtureId: FixtureId,
  onProgress?: (prefetcher: MatchdayPrefetcher) => void,
): Promise<MatchdayBundle | null> => {
  const prefetcher = new MatchdayPrefetcher(ctx.footballData, {
    onProgress: onProgress === undefined ? undefined : () => onProgress(prefetcher),
  });
  const result = await prefetcher.run(fixtureId);
  if (!result.ok) return null;
  setCachedBundle(roomId, result.value);
  return result.value;
};

/** One step's aggregated status/notes across every fixture in a gameday's bundle — shaped so
 * `realtime/loading.ts` can drive the exact same `fixture → lineups → squads → stats` steps the
 * single-fixture loading screen already reports (`MATCHDAY_STEP_KEYS` in `apps/web`), regardless of
 * whether one fixture or several are being prefetched behind the scenes. */
export interface AggregatedPrefetchStep {
  readonly id: PrefetchStepId;
  readonly status: PrefetchStepStatus;
  readonly notes: readonly string[];
}

const aggregateGamedaySteps = (
  byFixture: ReadonlyMap<FixtureId, ReturnType<MatchdayPrefetcher['progress']>>,
  totalCount: number,
): readonly AggregatedPrefetchStep[] => {
  const progresses = [...byFixture.values()];
  return PREFETCH_STEP_ORDER.map((id) => {
    const known = progresses
      .map((progress) => progress.steps.find((step) => step.id === id))
      .filter((step): step is NonNullable<typeof step> => step !== undefined);
    const notes = known.flatMap((step) => step.notes);

    let status: PrefetchStepStatus;
    if (known.some((step) => step.status === 'running')) {
      status = 'running';
    } else if (totalCount > 0 && progresses.length >= totalCount && known.every((step) => step.status !== 'pending')) {
      status = known.some((step) => step.status === 'done') ? 'done' : 'failed';
    } else {
      status = 'pending';
    }
    return { id, status, notes };
  });
};

/** Runs `MatchdayPrefetcher.runGameday` for every fixture currently live in `competitionId`, caches
 * the resulting `GamedayBundle` (see `gameday-cache.ts`), and (optionally) reports aggregated
 * step progress across every fixture in flight. */
export const runGamedayPrefetch = async (
  ctx: AppContext,
  roomId: RoomId,
  competitionId: CompetitionId,
  onProgress?: (steps: readonly AggregatedPrefetchStep[]) => void,
): Promise<GamedayBundle | null> => {
  const totalResult = await ctx.footballData.listLiveFixtures(competitionId);
  const totalCount = totalResult.ok ? totalResult.value.length : 0;

  const progressByFixture = new Map<FixtureId, ReturnType<MatchdayPrefetcher['progress']>>();
  const prefetcher = new MatchdayPrefetcher(ctx.footballData);
  const result = await prefetcher.runGameday(competitionId, {
    onFixtureProgress:
      onProgress === undefined
        ? undefined
        : (fixtureId, progress) => {
            progressByFixture.set(fixtureId, progress);
            onProgress(aggregateGamedaySteps(progressByFixture, totalCount));
          },
  });
  if (!result.ok) return null;

  // Merge into whatever is already cached for this room rather than replacing it wholesale:
  // `bundle.fixtures` must stay grow-only even across a loading-screen re-run (e.g. `START_LOADING`
  // retried, or a room's second `START_LOADING` for a later game), exactly like
  // `refreshGamedayLiveSet`'s own periodic poll already treats it (see that function's doc comment).
  // A fixture a round was already pinned to (see `pinRoundFixture`) before this prefetch ran must keep
  // resolving via `fixture-annotation.ts` for as long as that round is referenced, even if it has since
  // left the live set and this fresh prefetch batch no longer includes it. Only `fixtureOrder` — which
  // fixtures are eligible for a *new* round — is replaced wholesale with the freshly-polled live set;
  // it deliberately does not carry anything over.
  const existing = getCachedGameday(roomId);
  const freshFixtures = result.value.fixtures;
  const freshIds = new Set(freshFixtures.map((bundle) => bundle.fixture.id));
  const carriedOver = (existing?.bundle.fixtures ?? []).filter((bundle) => !freshIds.has(bundle.fixture.id));
  const fixtures = [...carriedOver, ...freshFixtures];

  setCachedGameday(roomId, {
    competitionId,
    bundle: { competitionId, fixtures, skipped: result.value.skipped },
    fixtureOrder: freshFixtures.map((bundle) => bundle.fixture.id),
    lastPolledAt: Date.now(),
  });
  return result.value;
};

/** How often the live-fixture pool for a gameday room is re-polled — same order of magnitude as
 * `DEFAULT_FIXTURE_LIST_TTL_MS` in `competitions/fixture-list-cache.ts`, which this mirrors: fixture
 * lists change slowly outside kickoff/final-whistle moments, so polling much faster than this just
 * burns provider quota for no benefit, and much slower would leave a finished match rotating into
 * rounds for minutes after the final whistle. */
export const GAMEDAY_LIVE_POLL_MS = 90_000;

/**
 * Keeps a cached `GamedayBundle`'s rotation pool current. A no-op (returns the existing entry
 * unchanged) unless `GAMEDAY_LIVE_POLL_MS` has elapsed since the last poll — so this is cheap to call
 * on every dispatch, the same way `buildRoundDataContext` already does for the cheap single-fixture
 * cache read.
 *
 * Drift policy: a fixture that has stopped being live is dropped from `fixtureOrder` only (no longer
 * eligible for a *new* round — a round already generated from it is untouched, since round content is
 * fixed at generation time, not re-derived from this pool later). Its `MatchdayBundle` stays in
 * `bundle.fixtures` regardless — grow-only, never pruned — because `fixture-annotation.ts` needs to
 * resolve a *pinned* round's fixture for as long as that round is still referenced, which can outlive
 * the match itself (a host lingering on the reveal screen after full time, say). A newly-live fixture
 * needs its own `MatchdayBundle` prefetched before it can be rotated into, so it only becomes eligible
 * once that finishes (the next poll after it kicks off, in practice). If a provider call fails
 * outright, the existing pool is kept as-is (never emptied by a transient upstream hiccup) and the
 * poll clock is still reset, so a failing upstream is retried once per interval rather than hot-looping.
 */
export const refreshGamedayLiveSet = async (ctx: AppContext, roomId: RoomId): Promise<GamedayCacheEntry | null> => {
  const entry = getCachedGameday(roomId);
  if (entry === null) return null;
  if (Date.now() - entry.lastPolledAt < ctx.gamedayLivePollMs) return entry;

  const liveResult = await ctx.footballData.listLiveFixtures(entry.competitionId);
  if (!liveResult.ok) {
    const bumped: GamedayCacheEntry = { ...entry, lastPolledAt: Date.now() };
    setCachedGameday(roomId, bumped);
    return bumped;
  }

  const liveIds = liveResult.value.map((fixture) => fixture.id);
  const existingById = new Map(entry.bundle.fixtures.map((bundle) => [bundle.fixture.id, bundle] as const));

  // Newly-live fixtures were not part of the original `runGameday` batch — fetch their bundle now.
  // Sequential, not concurrent: this only runs at most once per `GAMEDAY_LIVE_POLL_MS`, and drift
  // mid-session is normally one or two fixtures, never a whole fresh slate.
  const added: MatchdayBundle[] = [];
  for (const fixtureId of liveIds) {
    if (existingById.has(fixtureId)) continue;
    const fresh = new MatchdayPrefetcher(ctx.footballData);
    const result = await fresh.run(fixtureId);
    if (result.ok) added.push(result.value);
  }

  // `bundle.fixtures` is grow-only, never pruned: a fixture that drops out of the live set still has
  // an already-generated round that may need its bundle later (`fixture-annotation.ts` looks a pinned
  // round's fixture up here, and it must resolve for as long as the round is still referenced — not
  // just for as long as the match stays live). Only `fixtureOrder` (the rotation *eligibility* list,
  // consulted purely for picking a *new* round) shrinks when a fixture stops being live.
  const fixtures = [...entry.bundle.fixtures, ...added];
  // Rotation order follows `listLiveFixtures`' own order (soonest-kicked-off first, same as the
  // fixture picker) rather than being re-sorted here.
  const fixtureOrder = liveIds.filter((id) => fixtures.some((bundle) => bundle.fixture.id === id));

  const refreshed: GamedayCacheEntry = {
    competitionId: entry.competitionId,
    bundle: { competitionId: entry.competitionId, fixtures, skipped: entry.bundle.skipped },
    fixtureOrder,
    lastPolledAt: Date.now(),
  };
  setCachedGameday(roomId, refreshed);
  return refreshed;
};

/**
 * Which `RoundKey` the round currently being generated for `room` (in response to `action`) will
 * resolve to once `reduceRoom` actually commits it — mirrors the reducer's own session/round
 * indexing exactly (see `reducer.ts`'s `START_SESSION` and `ADVANCE` cases) so this can never
 * disagree with the round `reduceRoom` is about to build:
 *
 * - `START_SESSION` always starts a brand-new session, *regardless* of whether the previously-active
 *   one (if any) had already played out every planned round — the reducer force-finishes it
 *   unconditionally. Crucially, `state.activeSessionIndex` at this point (the state *before* this
 *   dispatch is reduced) still points at that outgoing session, not the new one: the new session's
 *   index is `state.sessions.length` (the index it WILL have once appended), never
 *   `state.activeSessionIndex`. Using the latter is exactly the bug this function exists to avoid —
 *   it would key a brand-new game's round 0 by the *previous* game's round count, silently
 *   misattributing both the "now playing" banner and the round's actual generated content to the
 *   wrong fixture from the second game in a room onward.
 * - Any other dispatch while an active, not-yet-finished, not-yet-exhausted session exists (i.e. a
 *   normal in-session `ADVANCE`, or any other action — `TICK`, `SUBMIT_ANSWER`, `SELECT_GAME` while
 *   still mid-session — dispatched while that round is current) resolves to that session's next round
 *   index, `(activeSessionIndex, rounds.length)`.
 * - Otherwise (lobby, or intermission with no session left to resume) falls back to the same
 *   "next new session" key `START_SESSION` will use.
 *
 * Crucially, this key is *computed* on every dispatch that needs a data context, but it must only ever
 * be *pinned* (see `gameday-cache.ts`) by the one dispatch that is actually about to call
 * `generateRound` for it — see `isGenuineRoundGeneration` below and its doc comment for why: this
 * function alone cannot tell a genuine `START_SESSION`/`ADVANCE` round build apart from a `SELECT_GAME`
 * playability probe, a `TICK`, or a `SUBMIT_ANSWER`, all of which can resolve to the exact same
 * not-yet-generated key without ever actually building that round.
 */
const resolveNextRoundKey = (room: RoomState, action: RoomAction): RoundKey => {
  if (action.type === 'START_SESSION') {
    return { sessionIndex: room.sessions.length, roundIndex: 0 };
  }
  const activeIndex = room.activeSessionIndex;
  const active = activeIndex === null ? undefined : room.sessions[activeIndex];
  if (
    activeIndex !== null &&
    active !== undefined &&
    active.finishedAt === null &&
    active.rounds.length < active.roundsPlanned
  ) {
    return { sessionIndex: activeIndex, roundIndex: active.rounds.length };
  }
  return { sessionIndex: room.sessions.length, roundIndex: 0 };
};

/**
 * Whether `action`, dispatched against `room` in the state *before* this dispatch is reduced, is the
 * one action that will actually call the resolved module's `generateRound` — i.e. mirrors exactly the
 * phase/session gates `reducer.ts` itself checks ahead of its own two (and only two) `buildRound` call
 * sites, `START_SESSION` and `ADVANCE` (read `reducer.ts`, do not guess). Every other action either:
 *   - reads an already-generated round (`TICK`, `SUBMIT_ANSWER`, `LOCK_ROUND`, `REVEAL_ROUND`, an
 *     `ADVANCE` that's merely closing out `roundReveal` into `intermission`, …) — none of these read
 *     `deps.data` at all (the only two reads of it anywhere in `reduceRoom` are `buildRound` and
 *     `SELECT_GAME`'s playability check); or
 *   - is `SELECT_GAME`, which only ever needs `deps.data.quality` for a playability check, never a
 *     specific fixture.
 * Conflating any of these with genuine generation was the exact bug: a `SELECT_GAME` probe, a `TICK`,
 * or a `SUBMIT_ANSWER` used to pin a fixture for a round that might never even be built with that
 * module (the host can change their mind before `START_SESSION`), permanently jamming a later,
 * differently-moduled round that could have played fine — see `resolveNextRoundKey`'s doc comment.
 * This check is necessarily a best-effort mirror of the reducer's phase gates only, not every rejection
 * reason (e.g. `NOT_ENOUGH_PLAYERS`, `UNKNOWN_MODULE`) — if this returns `true` but the reducer still
 * rejects for one of those, no pin is written at all: pinning now happens at *commit time*, in
 * `dispatch.ts`'s `dispatchAction`, strictly after `reduceRoom` has actually accepted a round built
 * from a given fixture's data (and, defensively, after that acceptance is durably saved) — never
 * speculatively ahead of the reducer's own decision. This function only decides which `RoundKey` a
 * *successful* generation attempt would need pinned; it never writes a pin itself. A key with no pin
 * yet is free to try every candidate in turn on its next genuine attempt, and whichever candidate
 * `reduceRoom` actually accepts is the one committed — not a "first write wins" race, since there is
 * only ever one in-flight attempt per room (see `enqueueForRoom`).
 */
const isGenuineRoundGeneration = (room: RoomState, action: RoomAction): boolean => {
  if (action.type === 'START_SESSION') {
    return room.phase === 'lobby' || room.phase === 'loading' || room.phase === 'intermission';
  }
  if (action.type === 'ADVANCE') {
    if (room.phase !== 'intermission') return false;
    const activeIndex = room.activeSessionIndex;
    const active = activeIndex === null ? undefined : room.sessions[activeIndex];
    return active !== undefined && active.finishedAt === null && active.rounds.length < active.roundsPlanned;
  }
  return false;
};

/** Whether the round identified by `key` has already been generated and appended to `room`'s state —
 * i.e. `RoomState.sessions[key.sessionIndex].rounds[key.roundIndex]` exists. When it does, its fixture
 * was already pinned at generation time and must be read back verbatim, never recomputed. */
const roundAlreadyGenerated = (room: RoomState, key: RoundKey): boolean =>
  room.sessions[key.sessionIndex]?.rounds[key.roundIndex] !== undefined;

/**
 * Builds the ordered list of candidates the round currently being generated may rotate to. Only ever
 * called (see below) for the one dispatch that is genuinely about to attempt generating a round — and
 * never itself writes a pin (see `RoundDataResolution`'s doc comment); `dispatch.ts` does that, once,
 * after `reduceRoom` actually accepts a round built from whichever of these candidates it tried.
 *
 * The list starts at the round-robin assigned candidate for this round index
 * (`playable[roundIndex % playable.length]`) — over the *currently-playable* subset of the pool, not
 * the full `fixtureOrder`, so an unplayable fixture's rotation *successor* never gets a disproportionate
 * share of rounds (filtering first gives every playable fixture an even share) — and then walks every
 * other playable candidate exactly once, in rotation order, wrapping around. This is what makes the
 * dispatch layer's retry-across-candidates possible: `checkModulePlayable`'s boolean quality flags
 * cannot see every way a module's own `generateRound` might still fail on a specific fixture's actual
 * content (e.g. every on-pitch fact happening to be identical, or this session having already used up
 * a thin fixture's only usable content) — so if the assigned candidate's round gets rejected, the next
 * candidate in this same list gets a real shot instead of the whole dispatch failing outright, as long
 * as any live fixture can actually serve the round.
 *
 * Returns a single `EMPTY_DATA_CONTEXT` candidate (with a `null` `fixtureId`, so it is never pinned)
 * when there is nothing to rotate through at all — e.g. every live fixture in the competition has
 * finished mid-session, or every live fixture's data is too thin for this module. `reduceRoom` already
 * turns "a matchday module got `EMPTY_DATA_CONTEXT`" into a clean `DATA_UNAVAILABLE`/
 * `ROUND_GENERATION_FAILED` rejection rather than crashing or silently wedging the room, so this
 * deliberately does not invent a second failure path.
 */
const pickCandidates = (
  entry: GamedayCacheEntry,
  key: RoundKey,
  dataRequirements: readonly DataRequirementKey[],
): readonly RoundDataCandidate[] => {
  const playableIds = entry.fixtureOrder.filter((fixtureId) => {
    const bundle = entry.bundle.fixtures.find((candidate) => candidate.fixture.id === fixtureId);
    return bundle !== undefined && checkModulePlayable({ dataRequirements }, bundle.quality).playable;
  });
  if (playableIds.length === 0) return [{ context: EMPTY_DATA_CONTEXT, fixtureId: null }];

  const startIndex = key.roundIndex % playableIds.length;
  const ordered: FixtureId[] = [];
  for (let offset = 0; offset < playableIds.length; offset += 1) {
    const id = playableIds[(startIndex + offset) % playableIds.length];
    if (id !== undefined) ordered.push(id);
  }

  return ordered.map((fixtureId): RoundDataCandidate => {
    const bundle = entry.bundle.fixtures.find((candidate) => candidate.fixture.id === fixtureId);
    return bundle === undefined
      ? { context: EMPTY_DATA_CONTEXT, fixtureId: null }
      : { context: bundleToContext(bundle), fixtureId };
  });
};

/**
 * Answers "is this module playable against *some* currently-live fixture right now" for a
 * `SELECT_GAME` playability probe, without committing to (or pinning) any particular one — the host
 * may still change their mind and pick a different module before `START_SESSION` actually generates a
 * round, and whichever fixture that eventually rotates to is free to be a different one than whatever
 * looked good here.
 */
const probePlayability = (
  entry: GamedayCacheEntry,
  dataRequirements: readonly DataRequirementKey[],
): RoundDataContext => {
  for (const fixtureId of entry.fixtureOrder) {
    const bundle = entry.bundle.fixtures.find((candidate) => candidate.fixture.id === fixtureId);
    if (bundle === undefined) continue;
    if (checkModulePlayable({ dataRequirements }, bundle.quality).playable) return bundleToContext(bundle);
  }
  return EMPTY_DATA_CONTEXT;
};

const buildGamedayRoundContext = async (
  ctx: AppContext,
  room: RoomState,
  action: RoomAction,
  competitionId: CompetitionId,
  dataRequirements: readonly DataRequirementKey[],
): Promise<RoundDataResolution> => {
  let entry = getCachedGameday(room.id);
  if (entry === null) {
    const bundle = await runGamedayPrefetch(ctx, room.id, competitionId);
    entry = bundle === null ? null : getCachedGameday(room.id);
  } else {
    entry = (await refreshGamedayLiveSet(ctx, room.id)) ?? entry;
  }
  if (entry === null) return singleCandidate(EMPTY_DATA_CONTEXT);

  const key = resolveNextRoundKey(room, action);

  // The round for this key was already generated (and pinned at that time) — always reuse it
  // verbatim, regardless of what this dispatch is. This is what makes reconnect/`TICK`/`SUBMIT_ANSWER`
  // on the currently-open round (and re-reads of any past round) correct. Never re-pinned: it already
  // has a pin, and `dispatch.ts` only ever writes one for a *newly*-accepted round.
  if (roundAlreadyGenerated(room, key)) {
    const pinned = getPinnedRoundFixture(room.id, key);
    const bundle = pinned === null ? undefined : entry.bundle.fixtures.find((candidate) => candidate.fixture.id === pinned);
    return singleCandidate(bundle === undefined ? EMPTY_DATA_CONTEXT : bundleToContext(bundle));
  }

  // No round exists yet for this key. Only offer candidates for a brand-new choice if THIS dispatch is
  // genuinely the one about to generate it — everything else either needs no data context at all
  // (deps.data is unused outside `buildRound` and `SELECT_GAME`'s check) or, for `SELECT_GAME`, only an
  // unpinned playability probe. Neither of those ever sets `gamedayPinKey`, so `dispatch.ts` can never
  // write a pin for them regardless of what `reduceRoom` does with the (unused, or probe-only) data.
  if (!isGenuineRoundGeneration(room, action)) {
    const context = action.type === 'SELECT_GAME' ? probePlayability(entry, dataRequirements) : EMPTY_DATA_CONTEXT;
    return singleCandidate(context);
  }

  return { candidates: pickCandidates(entry, key, dataRequirements), gamedayPinKey: key };
};

export const buildRoundDataContext = async (
  ctx: AppContext,
  room: RoomState,
  meta: RoomMeta,
  action: RoomAction,
  category: GameCategory | null,
  dataRequirements: readonly DataRequirementKey[],
): Promise<RoundDataResolution> => {
  if (category === null) return singleCandidate(EMPTY_DATA_CONTEXT);

  if (category === 'matchday') {
    const gamedayCompetitionId = meta.gamedayCompetitionId ?? null;
    if (gamedayCompetitionId !== null) {
      return buildGamedayRoundContext(ctx, room, action, gamedayCompetitionId, dataRequirements);
    }

    if (meta.fixtureId === null) return singleCandidate(EMPTY_DATA_CONTEXT);
    const cached = getCachedBundle(room.id);
    if (cached !== null) return singleCandidate(bundleToContext(cached));
    const bundle = await runMatchdayPrefetch(ctx, room.id, meta.fixtureId);
    return singleCandidate(bundle === null ? EMPTY_DATA_CONTEXT : bundleToContext(bundle));
  }

  const dataset = await ctx.generalDataset();
  return singleCandidate({
    fixture: null,
    lineups: null,
    live: null,
    teams: dataset.teams,
    players: dataset.players,
    profiles: dataset.profiles,
    seasonStats: dataset.seasonStats,
    quality: dataset.quality,
  });
};
