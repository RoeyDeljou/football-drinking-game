'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AgeGateGuard } from '@/components/AgeGateGuard';
import { BackButton } from '@/components/BackButton';
import { FixturePicker } from '@/components/FixturePicker';
import { GameModePicker } from '@/components/GameModePicker';
import { GameSettingsEditor } from '@/components/GameSettingsEditor';
import { configFor, DEFAULT_SETTINGS, type SettingsState } from '@/lib/gameSettings';
import { Banner, BigButton, Card, Eyebrow, Field, OptionButton } from '@/components/ui';
import type { ApiResult, Competition } from '@/lib/api';
import { createRoom, listCompetitionFixtures, listCompetitions } from '@/lib/api';
import {
  choiceAfterCategoryChange,
  DEFAULT_CHOICE,
  NO_MINI_GAME_MESSAGE,
  resolveModuleId,
  type ModeChoice,
} from '@/lib/gameMode';
import { isFreshLiveFixture, isMatchdayVisible, matchdayAvailability, type CompetitionLiveCheck } from '@/lib/matchdayAvailability';
import { type FixtureSelection } from '@/lib/fixtureSelection';
import { savePendingSelection, saveRoomSetup } from '@/lib/storage';
import { setupScopeLabel } from '@/lib/setupScopeLabel';
import { competitionsView } from '@/lib/matchdayPicker';
import { competitionMonogram } from '@/lib/competitionMonogram';
import { useNow } from '@/lib/useNow';
import { useRoom } from '@/lib/room-context';

type Category = 'matchday' | 'general';

/** How often to re-sweep every competition for a newly-live match while the host sits on this
 * page. Matches the server's own fixture-list cache TTL, so a tighter interval would just be
 * hammering a cache that hasn't changed. */
const MATCHDAY_SWEEP_INTERVAL_MS = 90_000;

export default function HostPage(): React.JSX.Element {
  return (
    <AgeGateGuard>
      <HostPageContent />
    </AgeGateGuard>
  );
}

function HostPageContent(): React.JSX.Element {
  const router = useRouter();
  const { adopt } = useRoom();
  const [category, setCategory] = useState<Category>('general');

  const [competitionsResult, setCompetitionsResult] = useState<ApiResult<{ competitions: readonly Competition[] }> | null>(
    null,
  );
  /** The ticked matches (one = single-match room, several = rotation). */
  const [fixtureSelection, setFixtureSelection] = useState<FixtureSelection>([]);
  /** General-room competition scope. `null` = "all competitions combined" (today's default, unchanged
   * request shape). Separate from `selectedCompetitionId`, which drives the Matchday league→fixture
   * flow and must never be disturbed by picking a General scope. */
  const [generalCompetitionId, setGeneralCompetitionId] = useState<string | null>(null);

  /** Shuffle game (default) vs Select Mini Game + the picked mini game. Reset on a category change. */
  const [modeChoice, setModeChoice] = useState<ModeChoice>(DEFAULT_CHOICE);

  /** Custom settings for the picked mini game (Default rules send no config). */
  const [settings, setSettings] = useState<SettingsState>(DEFAULT_SETTINGS);

  const [rounds, setRounds] = useState(8);
  const [hostNickname, setHostNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const now = useNow(30_000);
  const fastNow = useNow(1_000);

  // Background sweep across every competition for a fresh live fixture, driving whether the
  // Matchday category can be selected at all. Kept separate from the league/fixture pickers above
  // (which only run once a league is chosen) — this runs unconditionally as soon as the page mounts.
  const [matchdayChecks, setMatchdayChecks] = useState<readonly CompetitionLiveCheck[]>([]);
  const matchdaySweepId = useRef(0);
  const matchdaySweepInFlight = useRef(false);

  const runMatchdaySweep = (): void => {
    // Don't stack overlapping sweeps if the previous one (competitions list + per-competition
    // fixture fan-out) is still in flight when the next interval tick fires.
    if (matchdaySweepInFlight.current) return;
    matchdaySweepInFlight.current = true;
    const sweepId = ++matchdaySweepId.current;
    void listCompetitions().then(async (competitionsResult) => {
      if (sweepId !== matchdaySweepId.current) return;
      if (!competitionsResult.ok) {
        // Can't even get the competition list — nothing to sweep. Report it as one failed check so
        // the decision function still resolves (to "unavailable") instead of sitting in "searching"
        // forever.
        setMatchdayChecks([{ status: 'settled', result: competitionsResult }]);
        matchdaySweepInFlight.current = false;
        return;
      }
      const competitions = competitionsResult.value.competitions;
      // Only the first sweep starts from 'pending'. A re-sweep keeps the last settled results on
      // screen until the new ones land, so a known live game doesn't vanish (and shift the whole
      // page) for however long the 90s re-check takes.
      setMatchdayChecks((previous) =>
        previous.length === competitions.length ? previous : competitions.map(() => ({ status: 'pending' as const })),
      );
      // Fan out in parallel, one live-fixture request per competition, and apply each answer the moment
      // it lands: a competition with a live match makes Matchday available without waiting for the slowest
      // one. listCompetitionFixtures never rejects (failures come back as an ApiResult), so a single
      // competition failing can't derail the others.
      await Promise.all(
        competitions.map((competition, index) =>
          listCompetitionFixtures(competition.id, 'live').then((result) => {
            if (sweepId !== matchdaySweepId.current) return;
            setMatchdayChecks((previous) =>
              previous.map((check, position) => (position === index ? { status: 'settled' as const, result } : check)),
            );
          }),
        ),
      );
      if (sweepId !== matchdaySweepId.current) return;
      matchdaySweepInFlight.current = false;
    });
  };

  useEffect(() => {
    runMatchdaySweep();
    const id = window.setInterval(runMatchdaySweep, MATCHDAY_SWEEP_INTERVAL_MS);
    return () => window.clearInterval(id);
    // Intentionally run once on mount: runMatchdaySweep reads refs, not state, so it doesn't need to
    // be re-created on every render.
  }, []);

  // Every live fixture the sweep has found so far, from any competition (answers arrive independently).
  const liveFixtures = matchdayChecks.flatMap((check) =>
    check.status === 'settled' && check.result.ok ? check.result.value.fixtures.filter((fixture) => isFreshLiveFixture(fixture, now)) : [],
  );
  const sweepStartedAt = useRef(Date.now());
  const matchdayState = matchdayAvailability(matchdayChecks, now);
  // Matchday is not rendered at all unless the sweep found a live game (no greyed-out button, no
  // flicker while searching). A host already on Matchday is never yanked out by a re-check.
  const matchdayVisible = isMatchdayVisible(matchdayState, category);
  // The first sweep is slow on a cold server: after ~3s keep the slot reserved with a "Checking live
  // games…" Matchday option, so it appears (or quietly goes) without the page jumping around.
  const checkingLive = !matchdayVisible && matchdayState === 'searching' && fastNow - sweepStartedAt.current > 3_000;
  const showCategoryCard = matchdayVisible || checkingLive;

  const switchCategory = (next: Category): void => {
    if (next === category) return;
    setCategory(next);
    setFixtureSelection([]);
    setSettings(DEFAULT_SETTINGS);
    setError(null);
    setModeChoice(choiceAfterCategoryChange());
  };

  // Request guards: a slow response from a request that's no longer "the current one" (the user
  // switched category/league again before it resolved) must never overwrite state for whatever is
  // now selected. Each guard is bumped before firing a new request and checked before applying it.
  const competitionsRequestId = useRef(0);

  const loadCompetitions = (): void => {
    setCompetitionsResult(null);
    const requestId = ++competitionsRequestId.current;
    void listCompetitions().then((result) => {
      if (requestId !== competitionsRequestId.current) return;
      setCompetitionsResult(result);
    });
  };

  useEffect(() => {
    // Both Matchday (league→fixture) and General (optional competition scope) draw from the same
    // `GET /competitions` list — fetch it once, lazily, the first time either category needs it.
    if ((category === 'matchday' || category === 'general') && competitionsResult === null) loadCompetitions();
    // loadCompetitions and competitionsResult are intentionally excluded: this should only
    // re-fire when the category toggle changes, not on every re-render once results arrive.
  }, [category]);

  const compView = competitionsView(competitionsResult);
  const onCreate = async (): Promise<void> => {
    setError(null);
    if (hostNickname.trim().length === 0) {
      setError('Enter a nickname.');
      return;
    }
    if (category === 'matchday' && fixtureSelection.length === 0) {
      setError('Tick at least one match.');
      return;
    }
    const moduleId = resolveModuleId(category, modeChoice);
    if (moduleId === null) {
      // The full hint already sits under the game picker; down here just point back up to it.
      setError('Pick a mini game above first.');
      return;
    }
    setBusy(true);
    const result = await createRoom({
      category,
      // One ticked match = a single-match room, several = a rotation room; the server tells them apart.
      ...(category === 'matchday' ? { fixtureIds: fixtureSelection.map((entry) => entry.fixture.fixtureId) } : {}),
      // Omitted entirely (not sent as null/'') when unset, so "all competitions" stays byte-identical
      // to today's default request shape.
      ...(category === 'general' && generalCompetitionId !== null ? { competitionId: generalCompetitionId } : {}),
      hostNickname: hostNickname.trim(),
      settings: { roundsPerSession: rounds, minPlayersToStart: 1 },
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    // Carry the chosen game to the room: its page dispatches SELECT_GAME once connected.
    savePendingSelection(result.value.roomId, moduleId, configFor(moduleId, settings));
    saveRoomSetup({
      roomId: result.value.roomId,
      category,
      scopeLabel: setupScopeLabel({
        category,
        generalCompetitionName:
          compView.status === 'ready' && generalCompetitionId !== null
            ? (compView.competitions.find((competition) => competition.id === generalCompetitionId)?.name ?? null)
            : null,
        fixtures: fixtureSelection.map((entry) => entry.fixture),
      }),
    });
    adopt({
      roomId: result.value.roomId,
      pin: result.value.pin,
      playerId: result.value.hostPlayerId,
      roomToken: result.value.roomToken,
      isHost: true,
    });
    router.push(`/room/${result.value.roomId}`);
  };

  // A text mark, never the provider's logo image — see lib/competitionMonogram.ts for why.
  const crest = (competition: Competition): React.JSX.Element => (
    <div
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border-strong bg-bg-sunken text-sm font-bold tracking-wide text-fg-muted"
      aria-hidden
    >
      {competitionMonogram(competition.name)}
    </div>
  );

  const loadingRow = (message: string): React.JSX.Element => (
    <div role="status" aria-live="polite" className="t-body py-4 text-center text-fg-muted">
      {message}
    </div>
  );

  return (
    <main className="page page-wide gap-5">
      <BackButton fallbackHref="/" />
      <div>
        <Eyebrow>{showCategoryCard ? 'Set up your room' : 'General · season trivia'}</Eyebrow>
        <h1 className="t-d1 mt-1">Host a room</h1>
      </div>

      {/* Phones: one column in reading order. 1024+: what to play on the left, how to play (game mode,
          rounds, nickname, Create) on the right, with the right column pinned so Create stays in reach. */}
      <div className="split-cols gap-5 [--split-min:20rem] lg:items-start lg:gap-8 land:items-start land:gap-4">
      <div className="flex min-w-0 flex-col gap-5">
      {showCategoryCard ? (
        <Card>
          <Eyebrow className="mb-3">Category</Eyebrow>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-3" role="radiogroup" aria-label="Category">
            <OptionButton
              role="radio"
              aria-checked={category === 'matchday'}
              selected={category === 'matchday'}
              disabled={checkingLive}
              aria-busy={checkingLive}
              onClick={() => switchCategory('matchday')}
            >
              <span className="flex flex-wrap items-center gap-x-2">
                Matchday
                {checkingLive ? null : (
                  <span className="whitespace-nowrap rounded-full bg-live/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-live">
                    Live
                  </span>
                )}
              </span>
              <span role={checkingLive ? 'status' : undefined} className="t-xs block font-normal text-fg-muted">
                {checkingLive ? 'Checking live games…' : 'Tied to real matches'}
              </span>
            </OptionButton>
            <OptionButton
              role="radio"
              aria-checked={category === 'general'}
              selected={category === 'general'}
              onClick={() => switchCategory('general')}
            >
              General
              <span className="t-xs block font-normal text-fg-muted">Season trivia, any time</span>
            </OptionButton>
          </div>
        </Card>
      ) : null}

      {category === 'matchday' ? (
        <Card>
          <Eyebrow className="mb-3">Pick your matches</Eyebrow>
          {compView.status === 'loading' ? loadingRow('Loading competitions…') : null}
          {compView.status === 'error' ? (
            <div className="flex flex-col gap-3">
              <Banner tone="error">{compView.message}</Banner>
              <BigButton variant="secondary" onClick={loadCompetitions}>
                Try again
              </BigButton>
            </div>
          ) : null}
          {compView.status === 'ready' ? (
            <FixturePicker
              competitions={compView.competitions}
              liveFixtures={liveFixtures}
              selection={fixtureSelection}
              onChange={setFixtureSelection}
              now={now}
            />
          ) : null}
        </Card>
      ) : null}

      {category === 'general' ? (
        <Card>
          <Eyebrow className="mb-1">Competition</Eyebrow>
          <p className="t-xs mb-3 text-fg-subtle">
            Optional — leave on &quot;All competitions&quot; to draw players from every league combined.
          </p>
          {compView.status === 'loading' ? loadingRow('Loading competitions…') : null}
          {compView.status === 'error' ? (
            <div className="flex flex-col gap-3">
              <Banner tone="error">{compView.message}</Banner>
              <BigButton variant="secondary" onClick={loadCompetitions}>
                Try again
              </BigButton>
            </div>
          ) : null}
          {compView.status === 'ready' ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,8.5rem),1fr))] gap-3" role="listbox" aria-label="Competitions">
              <OptionButton
                role="option"
                aria-selected={generalCompetitionId === null}
                selected={generalCompetitionId === null}
                onClick={() => setGeneralCompetitionId(null)}
                className="flex flex-col items-center justify-center gap-2 text-center"
              >
                <span className="text-sm leading-tight">All competitions</span>
              </OptionButton>
              {compView.competitions.map((competition) => (
                <OptionButton
                  key={competition.id}
                  role="option"
                  aria-selected={generalCompetitionId === competition.id}
                  aria-label={competition.name}
                  selected={generalCompetitionId === competition.id}
                  onClick={() => setGeneralCompetitionId(competition.id)}
                  className="flex flex-col items-center gap-2 text-center"
                >
                  {crest(competition)}
                  <span className="text-sm leading-tight">{competition.name}</span>
                </OptionButton>
              ))}
            </div>
          ) : null}
        </Card>
      ) : null}

      </div>

      <div className="flex min-w-0 flex-col gap-5 [@media(min-width:1024px)_and_(min-height:860px)]:sticky [@media(min-width:1024px)_and_(min-height:860px)]:top-6">
      <Card>
        <Eyebrow className="mb-3">Game</Eyebrow>
        <GameModePicker category={category} value={modeChoice}
          onChange={(next) => {
            // Settings belong to one game: another pick starts on Default rules.
            if (resolveModuleId(category, next) !== resolveModuleId(category, modeChoice)) setSettings(DEFAULT_SETTINGS);
            setModeChoice(next);
            setError(null);
          }}
        />
        {modeChoice.mode === 'select' && resolveModuleId(category, modeChoice) !== null ? (
          <div className="mt-4">
            <GameSettingsEditor
              moduleId={resolveModuleId(category, modeChoice) ?? ''}
              state={settings}
              onChange={setSettings}
              teams={{ home: fixtureSelection[0]?.fixture.homeTeam.name ?? 'Home', away: fixtureSelection[0]?.fixture.awayTeam.name ?? 'Away' }}
            />
          </div>
        ) : null}
        {modeChoice.mode === 'select' && resolveModuleId(category, modeChoice) === null ? (
          <p className="t-sm mt-3 font-semibold text-warn" role="status">
            {NO_MINI_GAME_MESSAGE}
          </p>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="t-eyebrow" id="rounds-label">
            Rounds per game
          </span>
          <div className="flex items-center gap-3" role="group" aria-labelledby="rounds-label">
            <button
              type="button"
              aria-label="Fewer rounds"
              disabled={rounds <= 1}
              onClick={() => setRounds((current) => Math.max(1, current - 1))}
              className="tap-target pressable min-w-[44px] flex-[0_1_4rem] rounded-md border-2 border-border-strong text-2xl font-bold disabled:opacity-40"
            >
              −
            </button>
            <output aria-live="polite" className="t-score tnum flex-1 text-center">
              {rounds}
            </output>
            <button
              type="button"
              aria-label="More rounds"
              disabled={rounds >= 50}
              onClick={() => setRounds((current) => Math.min(50, current + 1))}
              className="tap-target pressable min-w-[44px] flex-[0_1_4rem] rounded-md border-2 border-border-strong text-2xl font-bold disabled:opacity-40"
            >
              +
            </button>
          </div>
        </div>
        <Field
          label="Your nickname (host)"
          value={hostNickname}
          onChange={(event) => setHostNickname(event.target.value)}
          maxLength={24}
          autoComplete="nickname"
          placeholder="Your name at the table"
        />
      </Card>

      {error !== null ? (
        <div role="alert">
          <Banner tone="error">{error}</Banner>
        </div>
      ) : null}

      <BigButton onClick={() => void onCreate()} disabled={busy}>
        {busy ? 'Creating room…' : 'Create room'}
      </BigButton>
      </div>
      </div>
    </main>
  );
}
