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
- Prisma + Postgres in production, SQLite for local/dev and tests.
- Rooms are keyed by a 6-character PIN from an unambiguous alphabet (no `0/O`, `1/I`).

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
