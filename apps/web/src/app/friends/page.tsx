'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Banner, BigButton, Card } from '@/components/ui';
import type { FriendRequestEntry, PublicUser } from '@/lib/api';
import { listFriendRequests, listFriends, respondFriendRequest, searchUsers, sendFriendRequest } from '@/lib/api';
import { loadAuth, type StoredAuth } from '@/lib/storage';

export default function FriendsPage(): React.JSX.Element {
  const [auth, setAuth] = useState<StoredAuth | null | undefined>(undefined);
  const [friends, setFriends] = useState<readonly PublicUser[]>([]);
  const [incoming, setIncoming] = useState<readonly FriendRequestEntry[]>([]);
  const [outgoing, setOutgoing] = useState<readonly FriendRequestEntry[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly PublicUser[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setAuth(loadAuth());
  }, []);

  const refresh = useCallback(async (token: string): Promise<void> => {
    const [friendsResult, requestsResult] = await Promise.all([listFriends(token), listFriendRequests(token)]);
    if (friendsResult.ok) setFriends(friendsResult.value.friends);
    if (requestsResult.ok) {
      setIncoming(requestsResult.value.incoming);
      setOutgoing(requestsResult.value.outgoing);
    }
  }, []);

  useEffect(() => {
    if (auth === null || auth === undefined) return;
    void refresh(auth.accessToken);
  }, [auth, refresh]);

  if (auth === undefined) return <main className="p-6" />;

  if (auth === null) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-10 text-center">
        <p className="text-white/70">Sign in to add friends.</p>
        <Link href="/auth">
          <BigButton>Sign in</BigButton>
        </Link>
      </main>
    );
  }

  const runSearch = async (): Promise<void> => {
    if (query.trim().length === 0) return;
    const result = await searchUsers(query.trim(), auth.accessToken);
    if (result.ok) setResults(result.value.users);
  };

  const request = async (targetUserId: string): Promise<void> => {
    const result = await sendFriendRequest(targetUserId, auth.accessToken);
    setMessage(result.ok ? 'Friend request sent.' : result.message);
    if (result.ok) await refresh(auth.accessToken);
  };

  const respond = async (requestId: string, action: 'accept' | 'decline'): Promise<void> => {
    await respondFriendRequest(requestId, action, auth.accessToken);
    await refresh(auth.accessToken);
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 px-6 py-8">
      <h1 className="text-3xl font-black">Friends</h1>

      <Card>
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-white/50">Find people</h2>
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name"
            className="tap-target flex-1 rounded-xl border border-white/15 bg-white/5 px-4 text-white"
          />
          <button
            type="button"
            onClick={() => void runSearch()}
            className="tap-target rounded-xl bg-pitch-500 px-4 font-bold text-white"
          >
            Search
          </button>
        </div>
        {message !== null ? (
          <div className="mt-3">
            <Banner>{message}</Banner>
          </div>
        ) : null}
        <ul className="mt-3 flex flex-col gap-2">
          {results.map((user) => (
            <li key={user.id} className="flex items-center justify-between rounded-xl bg-white/5 px-4 py-3">
              <span>{user.displayName}</span>
              <button type="button" onClick={() => void request(user.id)} className="text-sm font-bold text-pitch-500">
                Add
              </button>
            </li>
          ))}
        </ul>
      </Card>

      {incoming.length > 0 ? (
        <Card>
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-white/50">Requests</h2>
          <ul className="flex flex-col gap-2">
            {incoming.map((entry) => (
              <li key={entry.requestId} className="flex items-center justify-between rounded-xl bg-white/5 px-4 py-3">
                <span>{entry.user.displayName}</span>
                <span className="flex gap-3">
                  <button type="button" onClick={() => void respond(entry.requestId, 'accept')} className="font-bold text-pitch-500">
                    Accept
                  </button>
                  <button type="button" onClick={() => void respond(entry.requestId, 'decline')} className="font-bold text-white/50">
                    Decline
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-white/50">Your friends</h2>
        <ul className="flex flex-col gap-2">
          {friends.map((friend) => (
            <li key={friend.id} className="rounded-xl bg-white/5 px-4 py-3">
              {friend.displayName}
            </li>
          ))}
          {friends.length === 0 ? <li className="text-sm text-white/50">No friends yet.</li> : null}
        </ul>
      </Card>

      {outgoing.length > 0 ? (
        <Card>
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-white/50">Sent</h2>
          <ul className="flex flex-col gap-2 text-sm text-white/60">
            {outgoing.map((entry) => (
              <li key={entry.requestId}>{entry.user.displayName} — pending</li>
            ))}
          </ul>
        </Card>
      ) : null}
    </main>
  );
}
