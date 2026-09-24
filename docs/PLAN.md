# Build plan — phases and acceptance criteria

A phase is complete only when **every** criterion below is demonstrably met and `qa-verifier` returns
`VERDICT: PASS`. No phase starts before the previous one passes.

Status legend: `TODO` / `IN PROGRESS` / `DONE`

**Live since 2026-09-24:** https://football-drinking-game-web.vercel.app (Vercel + Render, free tier). Deployed
ahead of Phase 7 at the user's explicit request, once Phases 1-4 gave a genuinely playable app with real data —
see `docs/DEPLOYMENT.md` for the setup, the free-tier Postgres 30-day expiry to watch for, and how to redeploy.
Phase 7's hardening work (rate limiting, room lifecycle cleanup, paid-tier upgrade) still applies to this live
deployment, not just a future one.

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

## Phase 1 — Game engine core + the five Phase-1 game modules · DONE

Owner: `game-engine-architect`

The five Phase-1 modules (`M1` Match Markets, `M2` Who's That Player?, `M3` Shirt Number, `G1` Guess the Player,
`G6` Trivia Rush) are implemented here as rules-only modules, so Phases 3 and 4 have real games to serve and render.

- [x] Branded domain ids, room/session state types, and the full action union
- [x] Pure reducer for the room lifecycle: `lobby → loading → playing → roundReveal → intermission → finished` (+ `aborted`)
- [x] `GameModule` contract: config schema, round generation, answer submission, validation, scoring, penalty emission
- [x] `EngineClock` and `Rng` ports; zero direct `Date.now()`/`Math.random()` inside engine code
- [x] Scoring service: correctness, speed bonus, streaks, ties; cumulative leaderboard
- [x] Penalty engine emitting `PenaltyEvent`s (target: self / others / everyone; magnitude in sips; caps)
- [x] Per-recipient state projection (`projectFor(playerId)`) that strips answers and rival picks pre-reveal
- [x] Vitest coverage of every reducer branch, tie handling, late/duplicate/invalid submissions, host-only actions
- [x] Module implementations with full rules + tests: `M1` Match Markets, `M2` Who's That Player?, `M3` Shirt Number, `G1` Guess the Player, `G6` Trivia Rush
- [x] `npm run test`, `npm run lint`, `npm run typecheck` green; no platform imports (enforced by the ESLint rule)

## Phase 2 — Football data layer (free sources only) · DONE

Owner: `football-data-engineer`

Constraint (2026-09-16): **free data sources only.** Verified findings:
- **ESPN public site API** (no key): fixtures/scoreboards, live status, confirmed lineups with shirt numbers, key events,
  play-by-play commentary, team match stats, per-player match stats, and squad bios (age, DOB, height, nationality,
  shirt number) for all six competitions. Unofficial and undocumented: no SLA, may change, terms unclear — acceptable
  for development, must be re-evaluated before a commercial hub launch.
- **Wikidata SPARQL** (no key): career history (club + start/end years) for G3 Career Path and G8 Teammate Chain.
- **API-Football free key** (100 requests/day): kept as an optional fallback adapter, never required.
- **football-data.org free tier**: excluded — no lineups, events, or squads, and delayed scores.
- **Market values**: no free source. Decided 2026-09-16: G7 becomes **Guess the Number** on free stats.

- [x] Normalized domain types: `Competition`, `Team`, `Fixture`, `Lineup`, `Player`, `PlayerSeasonStats`, `MatchEvent`, `LiveMatchState`
- [x] `FootballDataProvider` interface covering fixtures by date/competition, lineups, squads, season stats, live events
- [x] `EspnProvider` (primary, free, no key): Zod-validated, normalized, TTL cache, coalescing, polite rate limit, backoff
- [x] `WikidataCareerProvider`: career history enrichment with caching and a strict query budget
- [x] `CompositeProvider`: routes each capability to the best configured source, merges, and reports provenance in notes
- [x] `ApiFootballProvider`: optional fallback adapter (free key, 100 requests/day), same guarantees
- [x] `FixtureProvider`: recorded JSON for all 6 competitions plus a replayable match timeline at configurable speed
- [x] `MatchdayPrefetcher` exposing stepwise progress (fixtures → lineups → squads → stats) for the loading screen
- [x] `GeneralDataset` builder: the season data general games draw from, loaded once at app start and cached
- [x] `DataQuality` reporting so the engine can disable a game whose required data is missing
- [x] Offline tests for every provider (recorded raw payloads), composite routing, cache/rate-limit behaviour, replay, prefetch progress ordering, general dataset, data quality, factory selection
- [x] `npm run typecheck`, `npm run lint`, `npm test` green

## Phase 3 — Backend: rooms, realtime, accounts · DONE

Owner: `realtime-backend-engineer`

- [x] Prisma schema: users, credentials, refresh tokens, friendships, rooms, room players, game sessions, round results, stats
- [x] `IdentityProvider` interface + `LocalIdentityProvider` (argon2id, access/refresh JWT rotation)
- [x] Auth REST: register (18+ confirmation), login, refresh, logout, me
- [x] Friends REST: search users, send/accept/decline/remove, list friends, invite a friend to a room
- [x] Room REST: create room, resolve PIN, room summary
- [x] Socket.IO gateway: join by PIN as guest or user, lobby presence, host controls, submit answer, advance round, reconnect restore
- [x] Engine integration: server dispatches actions into `game-core` and broadcasts per-recipient projections
- [x] Zod validation and per-event authorization on every socket event; host-only actions enforced server-side
- [x] `RoomStore` interface with in-memory implementation; durable result writes to the database
- [x] Integration tests: full auth cycle, two clients in one room playing a complete game, host-permission denial, reconnect

QA history: round 1 found a critical defect (hardcoded default auth/room-token secrets with no production guard,
combined with an unauthenticated endpoint leaking a room's host id, allowing full room takeover from just a PIN)
plus a test that claimed to play a full game but didn't. Round 2 confirmed both fixed under independent re-attack,
but found the `.env.example` placeholder secrets were still long enough and unlisted to slip past the new guard.
Round 3: VERDICT: PASS, with the exploit chain independently re-attempted from scratch and confirmed closed, a full
3-player 8-round game played and audited for leaks by the verifier directly, and a sensitivity-controlled
reproduction of the dispatch race condition fix.

## Phase 4 — Web client, Phase-1 game set playable end to end · DONE

Owner: `game-ux-engineer`

- [x] Landing page: Host / Join with PIN / Sign in
- [x] Auth screens with 18+ gate and responsible-drinking notice; friends screen
- [~] Host flow: choose **Matchday** or **General** → matchday fixture picker (6 competitions, live/upcoming) → game picker → settings —
  matchday picker is a demo fixture + free-text fixture id, not a real browse-6-competitions picker (no `apps/api`
  endpoint to list fixtures yet); deferred, tracked below
- [x] Matchday loading screen driven by real `MatchdayPrefetcher` progress, with failure + retry
- [x] Join flow: PIN entry, nickname, link and QR join; lobby with live player list and host start control
- [x] Play screens for the Phase-1 set: **M1 Match Markets**, **M2 Who's That Player?**, **M3 Shirt Number**, **G1 Guess the Player**, **G6 Trivia Rush**
- [x] Reveal screen with correct answer, per-player result, and drink instructions via `drinkCopy`
- [x] Round leaderboard and final results with a drink tally
- [x] Reconnecting state, socket error handling, 360px-viewport verified, reduced-motion respected
- [~] Playwright end-to-end: host + two guests play a full game to the results screen — not built; deferred in
  favor of getting a playable app in front of the user faster (explicit user priority, 2026-09-17). The same
  ground was instead covered by qa-verifier driving two real browser sessions through every game by hand across
  three QA rounds. Revisit before Phase 7 hardening.

Follow-ups opened: a real fixture-browse REST endpoint in `apps/api` (owner: `realtime-backend-engineer`) and a
Playwright suite (owner: `game-ux-engineer`), both tracked for Phase 7.

QA history: round 1 played all five games end to end in real two-browser sessions and confirmed the core loop,
no-answer-leak, and reconnect all genuinely work, but found 5 blocking defects — most importantly a dead
"play another game" action at session end, and a stale stored room session silently hijacking a new PIN/QR/link
join into the wrong room. Round 2 confirmed all 5 fixed under live re-test, but found one more: rejoining an
already-ended room bricked the client on a permanent, uncloseable "connecting" spinner. Round 3: VERDICT: PASS,
with the fix independently re-verified at both the primary layer (the stale room is cleared, so no dead
"Rejoin" button ever appears) and the fallback layer (a session that survives anyway lands on a working
"back to start" screen, not a hang).

## Phase 5 — Remaining matchday games · TODO

Owners: `game-engine-architect` (rules) + `game-ux-engineer` (screens), `football-data-engineer` for event feeds

- [ ] M4 Your Man (draft) · M5 Event Roulette · M6 Match Bingo · M7 Minute Sniper
- [ ] M8 Stat Duel · M9 Flash Rounds · M10 Lineup Recall
- [ ] M1 in-play markets (deferred from Phase 1, 2026-09-17): markets that open and settle independently during the
  match, on top of the pre-kickoff slip already shipped
- [ ] Live-event ingestion loop mapping provider events onto engine triggers, idempotent against duplicate polls
- [ ] Each game: engine tests, UI screen, and a replay-provider run proving it fires correctly during a match

## Phase 6 — Remaining general games · TODO

- [ ] G2 Higher or Lower · G3 Career Path · G4 Name the Top 10 · G5 Odd One Out
- [ ] G7 Guess the Number · G8 Teammate Chain · G9 Two Truths & a Lie · G10 Most Likely To · G11 Spin the Ball
- [ ] Question generators guarantee solvability and no duplicate rounds within a session

## Phase 7 — Hardening and hub readiness · TODO

- [ ] `docs/HUB_INTEGRATION.md`: the four adapter seams, mount points, env, and a worked integration example
- [ ] Rate limiting, abuse protection, room lifetime/cleanup, profanity filter on nicknames
- [ ] Observability: structured logs, error reporting hooks, health endpoints
- [ ] Performance pass: 20 players per room, provider call budget per session measured and documented
- [ ] Full regression: typecheck, lint, unit, integration, Playwright green; `qa-verifier` PASS on the whole app
