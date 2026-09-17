# Football Drinking Game

A multiplayer football drinking game for watching matches with friends. Join a room Kahoot-style with a 6-character
PIN, a link, or a QR code, then play football betting, trivia, and party games — either tied to a **live matchday
fixture** or as **general games** built from season data.

Competitions: Premier League, La Liga, Serie A, Bundesliga, Ligue 1, UEFA Champions League.

Built to be dropped into a larger football hub app as a feature: the game engine and data layer are standalone
packages, and identity, football data, realtime state, and presentation are all adapter seams.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

```bash
npm install
npm run dev
```

No API key is needed to develop or play: the data layer defaults to a recorded-fixture provider that can replay a
real match timeline at any speed. Add an API-Football key to go live — see `packages/football-data/README.md`.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Runs the API and the web client together |
| `npm run typecheck` | Project-wide TypeScript build |
| `npm run lint` | ESLint, including the rules that keep the engine platform-agnostic |
| `npm test` | Vitest unit + integration suites |
| `npm run format` | Prettier |

## Layout

```
packages/game-core       Pure-TypeScript game engine: room state machine, game modules, scoring, penalties
packages/football-data   Provider interface + API-Football adapter + offline fixture/replay provider
apps/api                 Fastify REST + Socket.IO realtime + Prisma persistence + auth
apps/web                 Next.js + Tailwind client (mobile-first)
```

## Documentation

- [docs/PLAN.md](docs/PLAN.md) — build phases with acceptance criteria and status
- [docs/GAME_CATALOG.md](docs/GAME_CATALOG.md) — every game, its data needs, and its drink mechanic
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit and where the hub seams are
- [CLAUDE.md](CLAUDE.md) — project invariants and the specialist subagents

## A note on the drinking layer

Copy in the client is alcohol-explicit. Signup carries an 18+ confirmation and a responsible-drinking notice, and
penalties are capped per round and per session. Internally the engine emits neutral penalty events rendered through a
single copy module, so wording can be changed — or softened for a given market — in one file.
