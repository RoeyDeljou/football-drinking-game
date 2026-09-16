# Build plan — phases and acceptance criteria

A phase is complete only when **every** criterion below is demonstrably met and `qa-verifier` returns
`VERDICT: PASS`. No phase starts before the previous one passes.

Status legend: `TODO` / `IN PROGRESS` / `DONE`

---

## Phase 0 — Foundations · DONE

Monorepo scaffold, tooling, subagents, documentation of the contracts.

Acceptance criteria:

- [x] npm workspaces monorepo with `packages/game-core`, `packages/football-data`, `apps/api`, `apps/web`
- [x] TypeScript strict base config, ESLint, Prettier, Vitest wired at the root
- [x] `.claude/agents/` contains the five subagents; `CLAUDE.md` documents layout, invariants, and routing
- [x] `docs/PLAN.md`, `docs/GAME_CATALOG.md`, `docs/ARCHITECTURE.md` written
- [x] `npm install`, `npm run typecheck`, `npm run lint`, `npm run test` all succeed on the empty scaffold
- [x] git repository initialized with a sensible `.gitignore`

## Phase 1 — Game engine core · TODO

Owner: `game-engine-architect`

- [ ] Branded domain ids, room/session state types, and the full action union
- [ ] Pure reducer for the room lifecycle: `lobby → loading → playing → round-reveal → intermission → finished`
- [ ] `GameModule` contract: config schema, round generation, answer submission, validation, scoring, penalty emission
- [ ] `EngineClock` and `Rng` ports; zero direct `Date.now()`/`Math.random()` inside engine code
- [ ] Scoring service: correctness, speed bonus, streaks, ties; cumulative leaderboard
- [ ] Penalty engine emitting `PenaltyEvent`s (target: self / others / everyone; magnitude in sips; caps)
- [ ] Per-recipient state projection (`projectFor(playerId)`) that strips answers and rival picks pre-reveal
- [ ] Vitest coverage of every reducer branch, tie handling, late/duplicate/invalid submissions, host-only actions
- [ ] `npm run test -w packages/game-core` green; no platform imports (verified by a lint rule)

## Phase 2 — Football data layer · TODO

Owner: `football-data-engineer`

- [ ] Normalized domain types: `Competition`, `Team`, `Fixture`, `Lineup`, `Player`, `PlayerSeasonStats`, `MatchEvent`, `LiveMatchState`
- [ ] `FootballDataProvider` interface covering fixtures by date/competition, lineups, squads, season stats, live events
- [ ] `ApiFootballProvider`: RapidAPI adapter, Zod-validated responses, TTL cache, request coalescing, rate limiter, backoff
- [ ] `FixtureProvider`: recorded JSON for all 6 competitions plus a replayable match timeline at configurable speed
- [ ] `MatchdayPrefetcher` exposing stepwise progress (fixtures → lineups → squads → stats) for the loading screen
- [ ] `GeneralDataset` builder: the season data general games draw from, loaded once at app start and cached
- [ ] `DataQuality` reporting so the engine can disable a game whose required data is missing
- [ ] Offline tests for both providers, cache/rate-limit behaviour, and prefetch progress ordering

## Phase 3 — Backend: rooms, realtime, accounts · TODO

Owner: `realtime-backend-engineer`

- [ ] Prisma schema: users, credentials, refresh tokens, friendships, rooms, room players, game sessions, round results, stats
- [ ] `IdentityProvider` interface + `LocalIdentityProvider` (argon2id, access/refresh JWT rotation)
- [ ] Auth REST: register (18+ confirmation), login, refresh, logout, me
- [ ] Friends REST: search users, send/accept/decline/remove, list friends, invite a friend to a room
- [ ] Room REST: create room, resolve PIN, room summary
- [ ] Socket.IO gateway: join by PIN as guest or user, lobby presence, host controls, submit answer, advance round, reconnect restore
- [ ] Engine integration: server dispatches actions into `game-core` and broadcasts per-recipient projections
- [ ] Zod validation and per-event authorization on every socket event; host-only actions enforced server-side
- [ ] `RoomStore` interface with in-memory implementation; durable result writes to the database
- [ ] Integration tests: full auth cycle, two clients in one room playing a complete game, host-permission denial, reconnect

## Phase 4 — Web client, Phase-1 game set playable end to end · TODO

Owner: `game-ux-engineer`

- [ ] Landing page: Host / Join with PIN / Sign in
- [ ] Auth screens with 18+ gate and responsible-drinking notice; friends screen
- [ ] Host flow: choose **Matchday** or **General** → matchday fixture picker (6 competitions, live/upcoming) → game picker → settings
- [ ] Matchday loading screen driven by real `MatchdayPrefetcher` progress, with failure + retry
- [ ] Join flow: PIN entry, nickname, link and QR join; lobby with live player list and host start control
- [ ] Play screens for the Phase-1 set: **M1 Match Markets**, **M2 Who's That Player?**, **M3 Shirt Number**, **G1 Guess the Player**, **G6 Trivia Rush**
- [ ] Reveal screen with correct answer, per-player result, and drink instructions via `drinkCopy`
- [ ] Round leaderboard and final results with a drink tally
- [ ] Reconnecting state, socket error handling, 360px-viewport verified, reduced-motion respected
- [ ] Playwright end-to-end: host + two guests play a full game to the results screen

## Phase 5 — Remaining matchday games · TODO

Owners: `game-engine-architect` (rules) + `game-ux-engineer` (screens), `football-data-engineer` for event feeds

- [ ] M4 Your Man (draft) · M5 Event Roulette · M6 Match Bingo · M7 Minute Sniper
- [ ] M8 Stat Duel · M9 Flash Rounds · M10 Lineup Recall
- [ ] Live-event ingestion loop mapping provider events onto engine triggers, idempotent against duplicate polls
- [ ] Each game: engine tests, UI screen, and a replay-provider run proving it fires correctly during a match

## Phase 6 — Remaining general games · TODO

- [ ] G2 Higher or Lower · G3 Career Path · G4 Name the Top 10 · G5 Odd One Out
- [ ] G7 Price Is Right · G8 Teammate Chain · G9 Two Truths & a Lie · G10 Most Likely To · G11 Spin the Ball
- [ ] Question generators guarantee solvability and no duplicate rounds within a session

## Phase 7 — Hardening and hub readiness · TODO

- [ ] `docs/HUB_INTEGRATION.md`: the four adapter seams, mount points, env, and a worked integration example
- [ ] Rate limiting, abuse protection, room lifetime/cleanup, profanity filter on nicknames
- [ ] Observability: structured logs, error reporting hooks, health endpoints
- [ ] Performance pass: 20 players per room, provider call budget per session measured and documented
- [ ] Full regression: typecheck, lint, unit, integration, Playwright green; `qa-verifier` PASS on the whole app
