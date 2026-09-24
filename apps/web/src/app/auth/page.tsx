'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner, BigButton, Card } from '@/components/ui';
import { login, register, toStoredAuth } from '@/lib/api';
import { RESPONSIBLE_DRINKING_NOTICE } from '@/lib/drinkCopy';
import { saveAuth } from '@/lib/storage';

type Mode = 'login' | 'register';

export default function AuthPage(): React.JSX.Element {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    if (mode === 'register' && !ageConfirmed) {
      setError('You must confirm you are 18 or older.');
      return;
    }
    setBusy(true);
    const result =
      mode === 'login'
        ? await login({ email, password })
        : await register({ email, password, displayName, ageConfirmed18: true });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    saveAuth(toStoredAuth(result.value));
    router.push('/');
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-10">
      <h1 className="text-center text-3xl font-black">{mode === 'login' ? 'Sign in' : 'Create account'}</h1>

      <div className="flex gap-2 rounded-2xl bg-white/5 p-1">
        <button
          type="button"
          onClick={() => setMode('login')}
          className={`tap-target flex-1 rounded-xl text-sm font-bold ${mode === 'login' ? 'bg-pitch-500' : ''}`}
        >
          Sign in
        </button>
        <button
          type="button"
          onClick={() => setMode('register')}
          className={`tap-target flex-1 rounded-xl text-sm font-bold ${mode === 'register' ? 'bg-pitch-500' : ''}`}
        >
          Register
        </button>
      </div>

      <Card>
        <form className="flex flex-col gap-4" onSubmit={(event) => void onSubmit(event)}>
          {mode === 'register' ? (
            <label className="flex flex-col gap-1 text-sm font-semibold text-white/70">
              Display name
              <input
                required
                minLength={1}
                maxLength={40}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                className="tap-target rounded-xl border border-white/15 bg-white/5 px-4 text-lg text-white"
              />
            </label>
          ) : null}
          <label className="flex flex-col gap-1 text-sm font-semibold text-white/70">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="tap-target rounded-xl border border-white/15 bg-white/5 px-4 text-lg text-white"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold text-white/70">
            Password
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="tap-target rounded-xl border border-white/15 bg-white/5 px-4 text-lg text-white"
            />
          </label>

          {mode === 'register' ? (
            <>
              <label className="flex items-start gap-3 text-sm text-white/80">
                <input
                  type="checkbox"
                  checked={ageConfirmed}
                  onChange={(event) => {
                    setAgeConfirmed(event.target.checked);
                    if (event.target.checked) setError(null);
                  }}
                  className="mt-1 h-6 w-6 shrink-0"
                />
                I confirm I am 18 years of age or older.
              </label>
              <Banner>{RESPONSIBLE_DRINKING_NOTICE}</Banner>
            </>
          ) : null}

          {error !== null ? <Banner tone="error">{error}</Banner> : null}

          <BigButton type="submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </BigButton>
        </form>
      </Card>
    </main>
  );
}
