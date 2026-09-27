'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Banner, BigButton, Card } from '@/components/ui';
import type { ApiResult, Competition, FixtureSummary } from '@/lib/api';
import { createRoom, listCompetitionFixtures, listCompetitions } from '@/lib/api';
import { getValidAuthSession } from '@/lib/authSession';
import {
  competitionsView,
  fixturesView,
  formatKickoffLocal,
  isFixtureLive,
  kickoffCountdown,
  liveBadgeLabel,
} from '@/lib/matchdayPicker';
import { useNow } from '@/lib/useNow';
import { useRoom } from '@/lib/room-context';
import type { StoredAuth } from '@/lib/storage';

type Category = 'matchday' | 'general';

export default function HostPage(): React.JSX.Element {
  const router = useRouter();
  const { adopt } = useRoom();
  const [auth, setAuth] = useState<StoredAuth | null>(null);
  const [category, setCategory] = useState<Category>('general');

  const [competitionsResult, setCompetitionsResult] = useState<ApiResult<{ competitions: readonly Competition[] }> | null>(
    null,
  );
  const [selectedCompetitionId, setSelectedCompetitionId] = useState<string | null>(null);
  const [fixturesResult, setFixturesResult] = useState<ApiResult<{ fixtures: readonly FixtureSummary[] }> | null>(null);
  const [selectedFixture, setSelectedFixture] = useState<FixtureSummary | null>(null);

  const [rounds, setRounds] = useState(8);
  const [hostNickname, setHostNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const now = useNow(30_000);

  useEffect(() => {
    void getValidAuthSession().then(setAuth);
  }, []);

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
    if (category === 'matchday' && competitionsResult === null) loadCompetitions();
    // loadCompetitions and competitionsResult are intentionally excluded: this should only
    // re-fire when the category toggle changes, not on every re-render once results arrive.
  }, [category]);

  const fetchFixturesFor = (competitionId: string): void => {
    setFixturesResult(null);
    const requestId = ++fixturesRequestId.current;
    void listCompetitionFixtures(competitionId).then((result) => {
      if (requestId !== fixturesRequestId.current) return;
      setFixturesResult(result);
    });
  };

  const chooseCompetition = (competitionId: string): void => {
    setSelectedCompetitionId(competitionId);
    setSelectedFixture(null);
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
  };

  const compView = competitionsView(competitionsResult);
  const fixView = fixturesView(fixturesResult);
  const selectedCompetitionName =
    compView.status === 'ready'
      ? (compView.competitions.find((competition) => competition.id === selectedCompetitionId)?.name ?? null)
      : null;

  const onCreate = async (): Promise<void> => {
    setError(null);
    // Re-validate (and transparently refresh) right before the network call — the cached `auth`
    // state above may have gone stale if the user sat on this screen past the access token's TTL.
    const session = await getValidAuthSession();
    setAuth(session);
    if (session === null && hostNickname.trim().length === 0) {
      setError('Enter a nickname.');
      return;
    }
    if (category === 'matchday' && selectedFixture === null) {
      setError('Pick a fixture first.');
      return;
    }
    const fixtureId = category === 'matchday' ? selectedFixture?.fixtureId : undefined;
    setBusy(true);
    const result = await createRoom({
      category,
      ...(fixtureId !== undefined ? { fixtureId } : {}),
      ...(session === null ? { hostNickname: hostNickname.trim() } : {}),
      settings: { roundsPerSession: rounds, minPlayersToStart: 1 },
      ...(session !== null ? { accessToken: session.accessToken } : {}),
    });
    setBusy(false);
    if (!result.ok) {
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
      <h1 className="text-3xl font-black">Host a room</h1>

      <Card>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-white/50">Category</h2>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setCategory('matchday')}
            className={`tap-target rounded-2xl border-2 px-3 font-bold ${
              category === 'matchday' ? 'border-pitch-500 bg-pitch-500/20' : 'border-white/15 bg-white/5'
            }`}
          >
            Matchday
            <div className="mt-1 text-xs font-normal text-white/50">Tied to a real fixture</div>
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
                <h2 className="text-sm font-bold uppercase tracking-wide text-white/50">Pick a fixture</h2>
                <button type="button" onClick={backToLeagues} className="tap-target px-2 text-sm font-semibold text-pitch-400">
                  Change league
                </button>
              </div>
              {selectedCompetitionName !== null ? (
                <p className="mb-3 text-sm text-white/60">
                  League: <span className="font-semibold text-white/80">{selectedCompetitionName}</span>
                </p>
              ) : null}

              {fixView.status === 'loading' ? (
                <div role="status" aria-live="polite" className="py-4 text-center text-sm text-white/60">
                  Loading fixtures…
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
                <div className="flex max-h-80 snap-y flex-col gap-3 overflow-y-auto pr-1" role="listbox" aria-label="Fixtures">
                  {fixView.fixtures.map((fixture) => {
                    const live = isFixtureLive(fixture);
                    const badge = liveBadgeLabel(fixture);
                    const selected = selectedFixture?.fixtureId === fixture.fixtureId;
                    return (
                      <button
                        key={fixture.fixtureId}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => setSelectedFixture(fixture)}
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
              ) : null}
            </>
          )}
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
        {auth === null ? (
          <label className="mt-3 flex flex-col gap-1 text-sm font-semibold text-white/70">
            Your nickname (host)
            <input
              value={hostNickname}
              onChange={(event) => setHostNickname(event.target.value)}
              maxLength={24}
              className="tap-target rounded-xl border border-white/15 bg-white/5 px-4 text-lg text-white"
            />
          </label>
        ) : (
          <p className="mt-3 text-sm text-white/50">Hosting as {auth.displayName}.</p>
        )}
      </Card>

      {error !== null ? <Banner tone="error">{error}</Banner> : null}

      <BigButton onClick={() => void onCreate()} disabled={busy}>
        {busy ? 'Creating room…' : 'Create room'}
      </BigButton>
    </main>
  );
}
