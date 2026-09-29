# Architecture

## Shape

```
        apps/web (Next.js)                         apps/api (Fastify + Socket.IO)
   ┌───────────────────────────┐            ┌────────────────────────────────────────┐
   │ screens + game UIs        │  socket    │ gateway: validate → authorize →        │
   │ registered by module id   │◄──────────►│ dispatch into engine → project per     │
   │ drinkCopy render layer    │   REST     │ recipient → broadcast                  │
   └───────────────────────────┘            │ IdentityProvider · RoomStore · Prisma  │
                                            └───────────────┬───────────────┬────────┘
                                                            │               │
                                            packages/game-core     packages/football-data
                                            pure reducers,          FootballDataProvider
                                            GameModules, scoring,   ApiFootball | Fixture
                                            penalties, projection   prefetch + cache
```

Data flows one way: client input → server validation → engine reducer → new state → per-recipient projection →
broadcast. The client never computes a result, and the server never contains a rule.

## packages/game-core

- **Ports:** `EngineClock` (now), `Rng` (seeded). Injected, so a whole session replays deterministically from a seed
  plus an action log — which is also how tests are written.
- **Room state machine:** `lobby → loading → playing → roundReveal → intermission → finished`, with `aborted` as a
  terminal branch. Transitions are the only place session status changes.
- **GameModule contract** (one file per game, registered in a map):
  - `id`, `category: 'matchday' | 'general'`, `configSchema`, `dataRequirements`
  - `generateRound(ctx)` → round payload + hidden solution
  - `validateSubmission(round, submission)` → typed accept/reject
  - `scoreRound(round, submissions)` → per-player points + `PenaltyEvent[]`
  - `projectRound(round, playerId, phase)` → what that player is allowed to see
- **Scoring:** correctness + decaying speed bonus + streak multiplier, with explicit tie rules.
- **Penalties:** neutral `PenaltyEvent { target, sips, reason }`, capped per round and per session.

## packages/football-data

- One `FootballDataProvider` interface; two implementations (`ApiFootballProvider`, `FixtureProvider`) chosen by env.
- Adapters validate upstream payloads with Zod and normalize into internal domain types; provider shapes never escape.
- `MatchdayPrefetcher` runs the loading-screen pipeline in ordered steps and reports real progress per step.
- `GeneralDataset` is built once at app start from season data for the six competitions and cached.
- Reliability: TTL cache, request coalescing, rate limiter, backoff on 429/5xx, and a `DataQuality` report that lets
  the engine disable games whose data is unavailable.

## apps/api

- Fastify for REST (auth, friends, rooms), Socket.IO for realtime.
- `IdentityProvider` is the auth seam; `LocalIdentityProvider` uses argon2id with rotating refresh tokens.
- `RoomStore` is the realtime-state seam: in-memory now, Redis later, with no call-site changes.
- Prisma + Postgres everywhere — local dev, tests, and production (a local instance runs via the root
  `docker-compose.yml`; see `apps/api/tests/helpers.ts` for how tests isolate themselves inside it).
- General dataset: built by a scheduled sync (GitHub Actions, `npm run sync:dataset`), stored as one JSON row in Postgres
  (`GeneralDatasetSnapshot`) behind the `GeneralDatasetStore` port; the server loads it at startup and refreshes stale
  data in the background (see `docs/DEPLOYMENT.md`).
- Rooms are keyed by a 6-character PIN from an unambiguous alphabet (no `0/O`, `1/I`).
- Fixture picker for hosting a matchday room, so a host never has to know a raw provider fixture id:
  - `GET /competitions` — the six supported competitions straight from `COMPETITION_CONFIGS` (no provider call,
    instant). `200 { competitions: Competition[] }`.
  - `GET /competitions/:id/fixtures?window=live|upcoming` — real fixtures for that competition, from
    `FootballDataProvider.getFixturesByCompetition`. `:id` is one of the internal competition slugs returned by
    `GET /competitions` (e.g. `premier-league`, `champions-league`), not a provider id.
    - `window` is optional. Omitted: live fixtures first (soonest-kicked-off first), then `SCHEDULED` fixtures
      kicking off in the next 14 days (soonest first) — 14 days comfortably spans a domestic
      midweek/weekend pairing or a UCL group/knockout gap without surfacing fixtures too far out to plan a
      session around. `window=live` or `window=upcoming` narrows to just one half of that list. Finished,
      postponed, cancelled and out-of-window fixtures are always excluded. Capped at 20 results.
    - `200 { fixtures: [{ fixtureId, kickoff, status, minute, competitionId, homeTeam: { name, crestUrl },
      awayTeam: { name, crestUrl } }] }` — an empty array (still `200`) means "no live games for this
      competition right now", which is a UI state, not an error.
    - `400 { error: { code: 'UNKNOWN_COMPETITION' } }` for an id not in `COMPETITION_CONFIGS`; `400
      { error: { code: 'INVALID_QUERY' } }` for a bad `window`.
    - `503 { error: { code: 'DATA_UNAVAILABLE' } }` when the provider call fails — never a bare 500.
    - Cached per competition id for 90s (`apps/api/src/competitions/fixture-list-cache.ts`) so the picker never
      hammers the free-tier provider; only successes are cached, so a transient upstream failure is retried on
      the very next request rather than repeated for the whole TTL.

## apps/web

- Next.js App Router, Tailwind, mobile-first. A socket provider exposes the projected room state; screens are dumb
  renderers of it.
- A `GAME_SCREENS` registry maps module id → component, mirroring the engine registry. Adding a game touches two
  registries and nothing else.
- All penalty/score wording goes through `drinkCopy`.

## The four hub seams

| Seam | Interface | What the hub does |
|---|---|---|
| Identity | `IdentityProvider` | Implements it against the hub's own user store / SSO |
| Football data | `FootballDataProvider` | Points it at the hub's existing data pipeline instead of API-Football |
| Realtime state | `RoomStore` | Swaps in the hub's Redis/cluster-backed store |
| Presentation | `GAME_SCREENS` + `drinkCopy` | Re-skins screens and rewords copy; engine untouched |

`game-core` and `football-data` are publishable packages with no app dependencies, so the hub consumes them as-is.

## Live-event ingestion (apps/api/src/live)

Provider live events reach the engine through one loop, `createLiveIngestion` (`live/ingestion.ts`), owned by
`buildApp` and exposed as `ctx.liveIngestion`.

- **Watch set.** `dispatchAction` calls `ctx.liveIngestion.roomChanged(record)` after every dispatch. `planWatch`
  (`live/watch-plan.ts`) says a room needs a fixture only while it is `playing`, its session is unfinished, the module
  declares `supportsLiveEvents`, and the current round is `open`. Single-fixture rooms watch `meta.fixtureId`; gameday
  rooms watch the fixture the current round is pinned to.
- **One poll per fixture.** Rooms attach to a per-fixture watcher. Its `getLiveMatchState` poll chain is
  setTimeout-after-completion (never two in flight), default every `LIVE_POLL_INTERVAL_MS` (15s, the provider's live
  TTL), 60s pre-kickoff, exponential backoff (x2, capped 120s, +/-10% jitter) on any failure. Each poll delivers the
  full id-stable event list as `MATCH_EVENTS` to every attached room via `dispatchAction`; the reducer dedupes by id, so
  duplicate polls, reconnects and restarts are no-ops (no save, no broadcast). Changed rooms are broadcast through
  `gateway.broadcast`.
- **Stop conditions.** FINISHED (seen live) gets one confirming poll, then stops; POSTPONED/CANCELLED stop at once. A
  stopped watcher keeps its cached events until no room references it (late rooms are served from the cache). Last
  room detaches -> timer cleared. `close()` (called from `buildApp().close()`) clears every timer and awaits in-flight
  polls. Timers are injectable (`LiveScheduler`) for deterministic tests.
- Events are re-validated with Zod (`live/schemas.ts`); malformed or foreign-fixture events are dropped and logged.
