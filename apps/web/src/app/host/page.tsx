'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AgeGateGuard } from '@/components/AgeGateGuard';
import { BackButton } from '@/components/BackButton';
import { Banner, BigButton, Card } from '@/components/ui';
import type { ApiResult, Competition, FixtureSummary } from '@/lib/api';
import { createRoom, listCompetitionFixtures, listCompetitions } from '@/lib/api';
import { fixtureLoadElapsedPhase } from '@/lib/fixtureLoadElapsed';
import { matchdayAvailability, type CompetitionLiveCheck } from '@/lib/matchdayAvailability';
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
      setMatchdayChecks(competitions.map(() => ({ status: 'pending' })));
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
  const matchdayLocked = matchdayState === 'unavailable' && category !== 'matchday';

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
    adopt({
      roomId: result.value.roomId,
      pin: result.value.pin,
      playerId: result.value.hostPlayerId,
      roomToken: result.value.roomToken,
      isHost: true,
    });
    router.push(`/room/${result.value.roomId}`);
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 px-6 py-8">
      <BackButton fallbackHref="/" />
      <h1 className="text-3xl font-black">Host a room</h1>

      <Card>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-white/50">Category</h2>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => {
              // A brief flicker to "available" right before the host taps, followed by a re-check
              // that flips it back, must never retroactively un-select them once they're already on
              // this category — the lock only gates a *new* selection.
              if (matchdayLocked) return;
              setCategory('matchday');
            }}
            disabled={matchdayLocked}
            aria-disabled={matchdayLocked}
            className={`tap-target rounded-2xl border-2 px-3 font-bold ${
              category === 'matchday'
                ? 'border-pitch-500 bg-pitch-500/20'
                : matchdayLocked
                  ? 'cursor-not-allowed border-white/10 bg-white/5 opacity-40'
                  : 'border-white/15 bg-white/5'
            }`}
          >
            Matchday
            <div className="mt-1 text-xs font-normal text-white/50">Tied to a real fixture</div>
            <div role="status" aria-live="polite" className="mt-1 text-[10px] font-semibold uppercase tracking-wide">
              {matchdayState === 'searching' ? <span className="text-white/40">Searching…</span> : null}
              {matchdayState === 'unavailable' ? <span className="text-red-300/70">No live games for now</span> : null}
            </div>
          </button>
          <button
            type="button"
            onClick={() => setCategory('general')}
            className={`tap-target rounded-2xl border-2 px-3 font-bold ${
              category === 'general' ? 'border-pitch-500 bg-pitch-500/20' : 'border-white/15 bg-white/5'
            }`}
          >
            General
            <div className="mt-1 text-xs font-normal text-white/50">Season trivia, any time</div>
          </button>
        </div>
      </Card>

      {category === 'matchday' ? (
        <Card>
          {selectedCompetitionId === null ? (
            <>
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-white/50">Pick a league</h2>
              {compView.status === 'loading' ? (
                <div role="status" aria-live="polite" className="py-4 text-center text-sm text-white/60">
                  Loading competitions…
                </div>
              ) : null}
              {compView.status === 'error' ? (
                <div className="flex flex-col gap-3">
                  <Banner tone="error">{compView.message}</Banner>
                  <BigButton variant="secondary" onClick={loadCompetitions}>
                    Try again
                  </BigButton>
                </div>
              ) : null}
              {compView.status === 'ready' ? (
                <div
                  className="flex snap-x gap-3 overflow-x-auto pb-1"
                  role="listbox"
                  aria-label="Leagues"
                >
                  {compView.competitions.map((competition) => (
                    <button
                      key={competition.id}
                      type="button"
                      role="option"
                      aria-selected={false}
                      aria-label={competition.name}
                      onClick={() => chooseCompetition(competition.id)}
                      className="tap-target flex min-w-[9rem] shrink-0 snap-start flex-col items-center gap-2 rounded-2xl border-2 border-white/15 bg-white/5 px-4 py-3 text-center active:border-pitch-500"
                    >
                      {competition.logoUrl !== null ? (
                        // A remote, provider-hosted crest URL — not a build-time asset, so next/image's
                        // static optimization doesn't apply here.
                        <img src={competition.logoUrl} alt="" className="h-10 w-10 object-contain" />
                      ) : (
                        <div className="h-10 w-10 rounded-full bg-white/10" aria-hidden />
                      )}
                      <span className="text-sm font-bold leading-tight">{competition.name}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="mb-1 flex items-center justify-between">
                <BackButton onBack={backToLeagues} label="Change league" className="px-0 text-pitch-400" />
                <h2 className="text-sm font-bold uppercase tracking-wide text-white/50">Pick a fixture</h2>
              </div>
              {selectedCompetitionName !== null ? (
                <p className="mb-3 text-sm text-white/60">
                  League: <span className="font-semibold text-white/80">{selectedCompetitionName}</span>
                </p>
              ) : null}

              {fixView.status === 'loading' ? (
                <div role="status" aria-live="polite" className="flex flex-col items-center gap-1 py-4 text-center text-sm text-white/60">
                  <span>Loading fixtures…</span>
                  {fixtureLoadElapsedPhase({ loading: true, startedAt: fixturesLoadStartedAt ?? fastNow, now: fastNow }) ===
                  'slow' ? (
                    <span className="text-xs text-white/40">
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
                    <p className="text-xs text-white/40">
                      Lineups are published about an hour before kickoff, so games for an upcoming fixture won&apos;t
                      be selectable until then. Pick a live match for a game you can start now.
                    </p>
                  ) : null}
                  {shouldOfferGameday(liveFixtureCount(fixView.fixtures)) ? (
                    <button
                      type="button"
                      role="option"
                      aria-selected={gamedaySelected}
                      onClick={chooseGameday}
                      className={`tap-target flex shrink-0 flex-col gap-1 rounded-2xl border-2 px-4 py-3 text-left ${
                        gamedaySelected ? 'border-pitch-500 bg-pitch-500/20' : 'border-white/15 bg-white/5'
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-bold">Play the whole live gameday</span>
                        <span className="shrink-0 rounded-full bg-red-500/20 px-2 py-0.5 text-xs font-bold text-red-300">
                          LIVE
                        </span>
                      </span>
                      <span className="text-xs text-white/50">
                        {gamedayOptionLabel(liveFixtureCount(fixView.fixtures))} — rounds rotate across every one
                      </span>
                    </button>
                  ) : null}
                  <div className="flex max-h-80 snap-y flex-col gap-3 overflow-y-auto pr-1" role="listbox" aria-label="Fixtures">
                  {fixView.fixtures.map((fixture) => {
                    const live = isFixtureLive(fixture);
                    const badge = liveBadgeLabel(fixture);
                    const selected = !gamedaySelected && selectedFixture?.fixtureId === fixture.fixtureId;
                    return (
                      <button
                        key={fixture.fixtureId}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => chooseFixture(fixture)}
                        className={`tap-target flex shrink-0 snap-start flex-col gap-1 rounded-2xl border-2 px-4 py-3 text-left ${
                          selected ? 'border-pitch-500 bg-pitch-500/20' : 'border-white/15 bg-white/5'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-bold">
                            {fixture.homeTeam.name} vs {fixture.awayTeam.name}
                          </span>
                          {live ? (
                            <span className="shrink-0 rounded-full bg-red-500/20 px-2 py-0.5 text-xs font-bold text-red-300">
                              {badge}
                            </span>
                          ) : null}
                        </div>
                        {!live ? (
                          <span className="text-xs text-white/50">
                            {formatKickoffLocal(fixture.kickoff)} · {kickoffCountdown(fixture.kickoff, now)}
                          </span>
                        ) : null}
                      </button>
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
          <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-white/50">Competition</h2>
          <p className="mb-3 text-xs text-white/40">
            Optional — leave on &quot;All competitions&quot; to draw players from every league combined.
          </p>
          {compView.status === 'loading' ? (
            <div role="status" aria-live="polite" className="py-4 text-center text-sm text-white/60">
              Loading competitions…
            </div>
          ) : null}
          {compView.status === 'error' ? (
            <div className="flex flex-col gap-3">
              <Banner tone="error">{compView.message}</Banner>
              <BigButton variant="secondary" onClick={loadCompetitions}>
                Try again
              </BigButton>
            </div>
          ) : null}
          {compView.status === 'ready' ? (
            <div className="flex snap-x gap-3 overflow-x-auto pb-1" role="listbox" aria-label="Competitions">
              <button
                type="button"
                role="option"
                aria-selected={generalCompetitionId === null}
                onClick={() => setGeneralCompetitionId(null)}
                className={`tap-target flex min-w-[9rem] shrink-0 snap-start flex-col items-center justify-center gap-2 rounded-2xl border-2 px-4 py-3 text-center active:border-pitch-500 ${
                  generalCompetitionId === null ? 'border-pitch-500 bg-pitch-500/20' : 'border-white/15 bg-white/5'
                }`}
              >
                <span className="text-sm font-bold leading-tight">All competitions</span>
              </button>
              {compView.competitions.map((competition) => (
                <button
                  key={competition.id}
                  type="button"
                  role="option"
                  aria-selected={generalCompetitionId === competition.id}
                  aria-label={competition.name}
                  onClick={() => setGeneralCompetitionId(competition.id)}
                  className={`tap-target flex min-w-[9rem] shrink-0 snap-start flex-col items-center gap-2 rounded-2xl border-2 px-4 py-3 text-center active:border-pitch-500 ${
                    generalCompetitionId === competition.id
                      ? 'border-pitch-500 bg-pitch-500/20'
                      : 'border-white/15 bg-white/5'
                  }`}
                >
                  {competition.logoUrl !== null ? (
                    // A remote, provider-hosted crest URL — not a build-time asset, so next/image's
                    // static optimization doesn't apply here.
                    <img src={competition.logoUrl} alt="" className="h-10 w-10 object-contain" />
                  ) : (
                    <div className="h-10 w-10 rounded-full bg-white/10" aria-hidden />
                  )}
                  <span className="text-sm font-bold leading-tight">{competition.name}</span>
                </button>
              ))}
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-white/50">Settings</h2>
        <label className="flex flex-col gap-1 text-sm font-semibold text-white/70">
          Rounds per game
          <input
            type="number"
            min={1}
            max={50}
            value={rounds}
            onChange={(event) => setRounds(Number(event.target.value))}
            className="tap-target rounded-xl border border-white/15 bg-white/5 px-4 text-lg text-white"
          />
        </label>
        <label className="mt-3 flex flex-col gap-1 text-sm font-semibold text-white/70">
          Your nickname (host)
          <input
            value={hostNickname}
            onChange={(event) => setHostNickname(event.target.value)}
            maxLength={24}
            className="tap-target rounded-xl border border-white/15 bg-white/5 px-4 text-lg text-white"
          />
        </label>
      </Card>

      {error !== null ? <Banner tone="error">{error}</Banner> : null}

      <BigButton onClick={() => void onCreate()} disabled={busy}>
        {busy ? 'Creating room…' : 'Create room'}
      </BigButton>
    </main>
  );
}
