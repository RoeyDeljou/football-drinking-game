'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AgeGateGuard } from '@/components/AgeGateGuard';
import { BackButton } from '@/components/BackButton';
import { GameModePicker } from '@/components/GameModePicker';
import { Banner, BigButton, Card, Eyebrow, Field, OptionButton } from '@/components/ui';
import type { ApiResult, Competition, FixtureSummary } from '@/lib/api';
import { createRoom, listCompetitionFixtures, listCompetitions } from '@/lib/api';
import { fixtureLoadElapsedPhase } from '@/lib/fixtureLoadElapsed';
import {
  choiceAfterCategoryChange,
  DEFAULT_CHOICE,
  NO_MINI_GAME_MESSAGE,
  resolveModuleId,
  type ModeChoice,
} from '@/lib/gameMode';
import { isMatchdayVisible, matchdayAvailability, type CompetitionLiveCheck } from '@/lib/matchdayAvailability';
import { savePendingSelection, saveRoomSetup } from '@/lib/storage';
import { setupScopeLabel } from '@/lib/setupScopeLabel';
import {
  competitionsView,
  fixturesView,
  formatKickoffLocal,
  gamedayOptionLabel,
  isFixtureLive,
  kickoffCountdown,
  liveBadgeLabel,
  liveFixtureCount,
  shouldOfferGameday,
} from '@/lib/matchdayPicker';
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
  const [selectedCompetitionId, setSelectedCompetitionId] = useState<string | null>(null);
  const [fixturesResult, setFixturesResult] = useState<ApiResult<{ fixtures: readonly FixtureSummary[] }> | null>(null);
  const [fixturesLoadStartedAt, setFixturesLoadStartedAt] = useState<number | null>(null);
  const [selectedFixture, setSelectedFixture] = useState<FixtureSummary | null>(null);
  const [gamedaySelected, setGamedaySelected] = useState(false);
  /** General-room competition scope. `null` = "all competitions combined" (today's default, unchanged
   * request shape). Separate from `selectedCompetitionId`, which drives the Matchday league→fixture
   * flow and must never be disturbed by picking a General scope. */
  const [generalCompetitionId, setGeneralCompetitionId] = useState<string | null>(null);

  /** Shuffle game (default) vs Select Mini Game + the picked mini game. Reset on a category change. */
  const [modeChoice, setModeChoice] = useState<ModeChoice>(DEFAULT_CHOICE);

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
        previous.length === 0 ? competitions.map(() => ({ status: 'pending' as const })) : previous,
      );
      // Fan out in parallel, one live-fixture request per competition. listCompetitionFixtures
      // never rejects (network failures are caught and returned as an ApiResult), so Promise.all is
      // safe here: a single competition's failure can't derail the others.
      const results = await Promise.all(
        competitions.map((competition) => listCompetitionFixtures(competition.id, 'live')),
      );
      if (sweepId !== matchdaySweepId.current) return;
      setMatchdayChecks(results.map((result) => ({ status: 'settled', result })));
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

  const matchdayState = matchdayAvailability(matchdayChecks, now);
  // Matchday is not rendered at all unless the sweep found a live game (no greyed-out button, no
  // flicker while searching). A host already on Matchday is never yanked out by a re-check.
  const matchdayVisible = isMatchdayVisible(matchdayState, category);

  const switchCategory = (next: Category): void => {
    if (next === category) return;
    setCategory(next);
    setModeChoice(choiceAfterCategoryChange());
  };

  // Request guards: a slow response from a request that's no longer "the current one" (the user
  // switched category/league again before it resolved) must never overwrite state for whatever is
  // now selected. Each guard is bumped before firing a new request and checked before applying it.
  const competitionsRequestId = useRef(0);
  const fixturesRequestId = useRef(0);

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

  const fetchFixturesFor = (competitionId: string): void => {
    setFixturesResult(null);
    setFixturesLoadStartedAt(Date.now());
    const requestId = ++fixturesRequestId.current;
    void listCompetitionFixtures(competitionId).then((result) => {
      if (requestId !== fixturesRequestId.current) return;
      setFixturesResult(result);
    });
  };

  const chooseCompetition = (competitionId: string): void => {
    setSelectedCompetitionId(competitionId);
    setSelectedFixture(null);
    setGamedaySelected(false);
    fetchFixturesFor(competitionId);
  };

  const retryFixtures = (): void => {
    if (selectedCompetitionId === null) return;
    fetchFixturesFor(selectedCompetitionId);
  };

  const backToLeagues = (): void => {
    // Invalidate any fixtures request still in flight for the league we're leaving, so its response
    // can't land after we've already cleared the selection.
    fixturesRequestId.current += 1;
    setSelectedCompetitionId(null);
    setFixturesResult(null);
    setSelectedFixture(null);
    setGamedaySelected(false);
  };

  const chooseFixture = (fixture: FixtureSummary): void => {
    setGamedaySelected(false);
    setSelectedFixture(fixture);
  };

  const chooseGameday = (): void => {
    setSelectedFixture(null);
    setGamedaySelected(true);
  };

  const compView = competitionsView(competitionsResult);
  const fixView = fixturesView(fixturesResult);
  const selectedCompetitionName =
    compView.status === 'ready'
      ? (compView.competitions.find((competition) => competition.id === selectedCompetitionId)?.name ?? null)
      : null;

  const onCreate = async (): Promise<void> => {
    setError(null);
    if (hostNickname.trim().length === 0) {
      setError('Enter a nickname.');
      return;
    }
    if (category === 'matchday' && !gamedaySelected && selectedFixture === null) {
      setError('Pick a fixture, or play the whole live gameday.');
      return;
    }
    if (category === 'matchday' && gamedaySelected && selectedCompetitionId === null) {
      setError('Pick a league first.');
      return;
    }
    const moduleId = resolveModuleId(category, modeChoice);
    if (moduleId === null) {
      // The full hint already sits under the game picker; down here just point back up to it.
      setError('Pick a mini game above first.');
      return;
    }
    const fixtureId = category === 'matchday' && !gamedaySelected ? selectedFixture?.fixtureId : undefined;
    setBusy(true);
    const result = await createRoom({
      category,
      ...(fixtureId !== undefined ? { fixtureId } : {}),
      ...(category === 'matchday' && gamedaySelected && selectedCompetitionId !== null
        ? { gameday: true, competitionId: selectedCompetitionId }
        : {}),
      // Omitted entirely (not sent as null/'') when unset, so "all competitions" stays byte-identical
      // to today's default request shape.
      ...(category === 'general' && generalCompetitionId !== null ? { competitionId: generalCompetitionId } : {}),
      hostNickname: hostNickname.trim(),
      settings: { roundsPerSession: rounds, minPlayersToStart: 1 },
    });
    setBusy(false);
    if (!result.ok) {
      // A race between the gameday option being offered (>= 2 live fixtures at picker-render time)
      // and every one of them finishing right before the room was created — treat it exactly like
      // the ordinary "no live games" empty state, not a raw error: drop back to individual fixtures
      // and refresh the list so the host immediately sees what's actually still playable.
      if (result.code === 'NO_LIVE_FIXTURES') {
        setGamedaySelected(false);
        retryFixtures();
      }
      setError(result.message);
      return;
    }
    // Carry the chosen game to the room: its page dispatches SELECT_GAME once connected.
    savePendingSelection(result.value.roomId, moduleId);
    saveRoomSetup({
      roomId: result.value.roomId,
      category,
      scopeLabel: setupScopeLabel({
        category,
        generalCompetitionName:
          compView.status === 'ready' && generalCompetitionId !== null
            ? (compView.competitions.find((competition) => competition.id === generalCompetitionId)?.name ?? null)
            : null,
        matchdayCompetitionName: selectedCompetitionName,
        gameday: gamedaySelected,
        fixture: gamedaySelected ? null : selectedFixture,
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
        <Eyebrow>{matchdayVisible ? 'Set up your room' : 'General · season trivia'}</Eyebrow>
        <h1 className="t-d1 mt-1">Host a room</h1>
      </div>

      {/* Phones: one column in reading order. 1024+: what to play on the left, how to play (game mode,
          rounds, nickname, Create) on the right, with the right column pinned so Create stays in reach. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 lg:items-start lg:gap-8 land:grid-cols-2 land:items-start land:gap-4">
      <div className="flex min-w-0 flex-col gap-5">
      {matchdayVisible ? (
        <Card>
          <Eyebrow className="mb-3">Category</Eyebrow>
          <div className="grid grid-cols-1 gap-3 min-[340px]:grid-cols-2" role="radiogroup" aria-label="Category">
            <OptionButton
              role="radio"
              aria-checked={category === 'matchday'}
              selected={category === 'matchday'}
              onClick={() => switchCategory('matchday')}
            >
              <span className="flex items-center gap-2">
                Matchday
                <span className="rounded-full bg-live/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-live">
                  Live
                </span>
              </span>
              <span className="t-xs block font-normal text-fg-muted">Tied to a real fixture</span>
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
          {selectedCompetitionId === null ? (
            <>
              <Eyebrow className="mb-3">Pick a league</Eyebrow>
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
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-2 2xl:grid-cols-3" role="listbox" aria-label="Leagues">
                  {compView.competitions.map((competition) => (
                    <OptionButton
                      key={competition.id}
                      role="option"
                      aria-selected={false}
                      aria-label={competition.name}
                      onClick={() => chooseCompetition(competition.id)}
                      className="flex flex-col items-center gap-2 text-center"
                    >
                      {crest(competition)}
                      <span className="text-sm leading-tight">{competition.name}</span>
                    </OptionButton>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-x-2">
                <BackButton onBack={backToLeagues} label="Change league" className="px-0 text-accent" />
                <Eyebrow>Pick a fixture</Eyebrow>
              </div>
              {selectedCompetitionName !== null ? (
                <p className="t-body mb-3 text-fg-muted">
                  League: <span className="font-semibold text-fg">{selectedCompetitionName}</span>
                </p>
              ) : null}

              {fixView.status === 'loading' ? (
                <div role="status" aria-live="polite" className="t-body flex flex-col items-center gap-1 py-4 text-center text-fg-muted">
                  <span>Loading fixtures…</span>
                  {fixtureLoadElapsedPhase({ loading: true, startedAt: fixturesLoadStartedAt ?? fastNow, now: fastNow }) ===
                  'slow' ? (
                    <span className="t-xs text-fg-subtle">
                      A league&apos;s first check can take a few extra seconds — still working…
                    </span>
                  ) : null}
                </div>
              ) : null}
              {fixView.status === 'error' ? (
                <div className="flex flex-col gap-3">
                  <Banner tone="error">{fixView.message}</Banner>
                  <BigButton variant="secondary" onClick={retryFixtures}>
                    Try again
                  </BigButton>
                </div>
              ) : null}
              {fixView.status === 'empty' ? <Banner>No fixtures found for this competition right now.</Banner> : null}
              {fixView.status === 'ready' ? (
                <div className="flex flex-col gap-3">
                  {liveFixtureCount(fixView.fixtures) === 0 ? (
                    <p className="t-xs text-fg-subtle">
                      Lineups are published about an hour before kickoff, so games for an upcoming fixture won&apos;t
                      be selectable until then. Pick a live match for a game you can start now.
                    </p>
                  ) : null}
                  {shouldOfferGameday(liveFixtureCount(fixView.fixtures)) ? (
                    <OptionButton
                      role="option"
                      aria-selected={gamedaySelected}
                      selected={gamedaySelected}
                      onClick={chooseGameday}
                      className="flex flex-col gap-1"
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="min-w-0">Play the whole live gameday</span>
                        <span className="shrink-0 rounded-full bg-live/20 px-2 py-0.5 text-xs font-bold text-live">LIVE</span>
                      </span>
                      <span className="t-xs font-normal text-fg-muted">
                        {gamedayOptionLabel(liveFixtureCount(fixView.fixtures))} — rounds rotate across every one
                      </span>
                    </OptionButton>
                  ) : null}
                  <div className="flex max-h-[min(20rem,60dvh)] flex-col gap-3 overflow-y-auto pr-1 lg:max-h-[min(32rem,60dvh)]" role="listbox" aria-label="Fixtures">
                    {fixView.fixtures.map((fixture) => {
                      const live = isFixtureLive(fixture);
                      const badge = liveBadgeLabel(fixture);
                      const selected = !gamedaySelected && selectedFixture?.fixtureId === fixture.fixtureId;
                      return (
                        <OptionButton
                          key={fixture.fixtureId}
                          role="option"
                          aria-selected={selected}
                          selected={selected}
                          onClick={() => chooseFixture(fixture)}
                          className="flex shrink-0 flex-col gap-1"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="min-w-0">
                              {fixture.homeTeam.name} vs {fixture.awayTeam.name}
                            </span>
                            {live ? (
                              <span className="shrink-0 rounded-full bg-live/20 px-2 py-0.5 text-xs font-bold text-live">{badge}</span>
                            ) : null}
                          </div>
                          {!live ? (
                            <span className="t-xs font-normal text-fg-muted">
                              {formatKickoffLocal(fixture.kickoff)} · {kickoffCountdown(fixture.kickoff, now)}
                            </span>
                          ) : null}
                        </OptionButton>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </>
          )}
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
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-2 2xl:grid-cols-3" role="listbox" aria-label="Competitions">
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
        <GameModePicker category={category} value={modeChoice} onChange={setModeChoice} />
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
              className="tap-target pressable w-16 shrink-0 rounded-md border-2 border-border-strong text-2xl font-bold disabled:opacity-40"
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
              className="tap-target pressable w-16 shrink-0 rounded-md border-2 border-border-strong text-2xl font-bold disabled:opacity-40"
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
