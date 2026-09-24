'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Banner, BigButton, Card } from '@/components/ui';
import { createRoom } from '@/lib/api';
import { useRoom } from '@/lib/room-context';
import { loadAuth, type StoredAuth } from '@/lib/storage';

const DEMO_FIXTURE_ID = '401915445';
const DEMO_FIXTURE_LABEL = 'Demo match: PSG 6-1 Slovan Bratislava (UEFA Champions League, offline-safe)';

type Category = 'matchday' | 'general';

export default function HostPage(): React.JSX.Element {
  const router = useRouter();
  const { adopt } = useRoom();
  const [auth, setAuth] = useState<StoredAuth | null>(null);
  const [category, setCategory] = useState<Category>('general');
  const [fixtureChoice, setFixtureChoice] = useState<'demo' | 'custom'>('demo');
  const [customFixtureId, setCustomFixtureId] = useState('');
  const [rounds, setRounds] = useState(8);
  const [hostNickname, setHostNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAuth(loadAuth());
  }, []);

  const onCreate = async (): Promise<void> => {
    setError(null);
    if (auth === null && hostNickname.trim().length === 0) {
      setError('Enter a nickname.');
      return;
    }
    const fixtureId = category === 'matchday' ? (fixtureChoice === 'demo' ? DEMO_FIXTURE_ID : customFixtureId.trim()) : undefined;
    if (category === 'matchday' && (fixtureId === undefined || fixtureId.length === 0)) {
      setError('Enter a fixture id, or use the demo match.');
      return;
    }
    setBusy(true);
    const result = await createRoom({
      category,
      ...(fixtureId !== undefined ? { fixtureId } : {}),
      ...(auth === null ? { hostNickname: hostNickname.trim() } : {}),
      settings: { roundsPerSession: rounds, minPlayersToStart: 1 },
      ...(auth !== null ? { accessToken: auth.accessToken } : {}),
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
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-white/50">Fixture</h2>
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => setFixtureChoice('demo')}
              className={`tap-target rounded-2xl border-2 px-4 text-left text-sm font-semibold ${
                fixtureChoice === 'demo' ? 'border-pitch-500 bg-pitch-500/20' : 'border-white/15 bg-white/5'
              }`}
            >
              {DEMO_FIXTURE_LABEL}
            </button>
            <button
              type="button"
              onClick={() => setFixtureChoice('custom')}
              className={`tap-target rounded-2xl border-2 px-4 text-left text-sm font-semibold ${
                fixtureChoice === 'custom' ? 'border-pitch-500 bg-pitch-500/20' : 'border-white/15 bg-white/5'
              }`}
            >
              Custom fixture ID
            </button>
            {fixtureChoice === 'custom' ? (
              <input
                value={customFixtureId}
                onChange={(event) => setCustomFixtureId(event.target.value)}
                placeholder="e.g. an ESPN event id"
                className="tap-target rounded-xl border border-white/15 bg-white/5 px-4 text-white"
              />
            ) : null}
          </div>
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
