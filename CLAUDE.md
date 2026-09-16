# Football Drinking Game — project guide

A multiplayer football drinking game. Friends join a room Kahoot-style (6-character PIN, link, or QR) and play
football-themed betting/trivia/party games, either tied to a **live matchday fixture** or as **general games** built
from season data for the top 5 European leagues + the UEFA Champions League.

This app will eventually be embedded as a feature inside a larger **football hub app**. Integration must be a matter of
mounting existing code, never rewriting it. That constraint outranks convenience in every design decision.

## Repository layout

```
packages/game-core       Pure-TypeScript game engine: room state machine, game modules, scoring, penalty rules
packages/football-data   FootballDataProvider interface + API-Football adapter + offline fixture/replay provider
apps/api                 Fastify REST + Socket.IO realtime + Prisma persistence + auth (IdentityProvider adapter)
apps/web                 Next.js + Tailwind client (mobile-first)
docs/                    PLAN.md (phases + acceptance criteria), ARCHITECTURE.md, GAME_CATALOG.md, HUB_INTEGRATION.md
```

npm workspaces (no pnpm on this machine). Run everything from the repo root.

```bash
npm install
npm run dev          # api + web together
npm run typecheck
npm run lint
npm run test
```

## Non-negotiable invariants

1. **`packages/game-core` stays pure.** No React, Next, Node built-ins, Socket.IO, Prisma, or network access. Time and
   randomness are injected (`EngineClock`, `Rng`) so every game is deterministic and replayable in tests.
2. **Rules live in the engine only.** The server is transport + persistence; the client is rendering + input. Neither
   re-implements scoring or validation.
3. **Games are plugins.** A new game is a new `GameModule` + a registered UI component. Adding one must not require
   editing engine internals or the socket layer.
4. **No answer leaks.** Socket payloads are built per recipient; correct answers and other players' picks are withheld
   until reveal.
5. **Guests are first-class.** Every flow works for a PIN-joined guest with no account.
6. **Swappable seams for the hub:** `IdentityProvider` (auth), `FootballDataProvider` (data), `RoomStore` (realtime
   state), and the drink-copy layer. Those four interfaces are how the hub adopts this feature.
7. **No half-finished work.** A phase is complete only when its `docs/PLAN.md` acceptance criteria all pass and
   `qa-verifier` returns `VERDICT: PASS`.

## Drink layer

Host-facing copy is alcohol-explicit ("drink", "sips", "down it"). Internally the engine still emits neutral
`PenaltyEvent`s and the UI renders them through a single `drinkCopy` module, so wording is changed in one file.
Signup carries an 18+ confirmation and a responsible-drinking notice.

## Subagents — use them for every task

Defined in `.claude/agents/`. Route work by ownership; run independent agents in parallel, then gate with `qa-verifier`.

| Agent | Owns | Use it for |
|---|---|---|
| `game-engine-architect` | `packages/game-core` | Game rules, round lifecycle, scoring, penalties, engine contracts |
| `football-data-engineer` | `packages/football-data` | Providers, normalization, caching, prefetch, fixtures/replay |
| `realtime-backend-engineer` | `apps/api` | REST, sockets, rooms/PIN, auth, friends, Prisma |
| `game-ux-engineer` | `apps/web` | Screens, lobby, join flow, game UIs, loading states, styling |
| `qa-verifier` | nothing (read-only) | Phase gates and any "is this actually done?" question |

Rules of engagement: give an agent the phase's acceptance criteria verbatim, never let two agents write the same
package in parallel, and never accept an agent's "done" without a `qa-verifier` pass.

## Conventions

- TypeScript strict everywhere; no `any` in committed code (`unknown` + narrowing instead).
- Zod schemas validate every boundary: REST bodies, socket events, provider responses, game config.
- Vitest for unit/integration tests; Playwright for the web end-to-end flow.
- Domain ids are branded types (`RoomId`, `PlayerId`, `FixtureId`) — never bare `string` across a boundary.
- Competition and provider ids live in config maps, never inline at a call site.
