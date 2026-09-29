# Handoff — 2026-09-29

Written to hand this project off to a continuation session (cloud or otherwise) with everything a
fresh session would otherwise have to re-derive. Read this before touching anything.

## Where things stand right now

- **Latest commit:** `a9c807d` on `master`, pushed, clean working tree.
- **Live:** https://football-drinking-game-web.vercel.app (Vercel) + `https://fdg-api-x9pw.onrender.com`
  (Render). Both auto-deploy on every push to `master`. Confirmed live and working via direct
  browser/API checks at the end of this session — not just "pushed," actually verified.
- **One thing outstanding, not code:** the general-games dataset snapshot in Postgres was built
  *before* National Teams shipped, so it has 0 players for that competition until the next sync.
  The user was asked to trigger **GitHub → Actions → "Sync general dataset" → Run workflow** once,
  manually. Unknown at the time of writing whether they've done it — check
  `GeneralDatasetSnapshot.payload.competitions` in Postgres (query below) before assuming National
  Teams' general games are playable.
- **A second, independent cloud session** may already be running on branch
  `claude/youthful-hypatia-x2in9b`, also at `a9c807d`. Don't assume you need to coordinate with it,
  but don't be surprised if it exists — ask the user before doing anything that could conflict.

## Infrastructure identifiers (so you don't have to rediscover them)

- GitHub: `RoeyDeljou/football-drinking-game`, branch `master`.
- Vercel project: `prj_Ei22ct3OHvFYiRWysY3QsziCinjM`.
- Render service (API): `srv-daqof2egekts739e21e0`, workspace `tea-daqo1ojncjis739e4gp0`
  (pass `workspaceId` explicitly on every Render MCP call — the session forgets it otherwise).
- Render Postgres: `dpg-daqoep6gekts739e0t20-a`, **free tier, created 2026-09-24, deleted ~2026-10-24**
  (30-day free-tier limit — this will take the whole app's data with it if not upgraded or backed
  up first; not yet decided/actioned as of this handoff).
- Local dev Postgres: embedded, `localhost:5432`, user/pass/db `fdg`. **The default `fdg` database
  is WIN1252-encoded** and spuriously fails any test that writes a non-ASCII name to
  `GeneralDatasetSnapshot` (Postgres error `22P05`). Use
  `postgresql://fdg:fdg@localhost:5432/fdg_utf8?schema=public` for local test runs instead — that
  database was created UTF8 specifically to work around this. Production Postgres is UTF8 and
  unaffected.

Query to check the stored dataset snapshot's age/competitions:
```sql
select id, "builtAt", "savedAt", "playerCount",
  (select array_agg(c->>'code') from jsonb_array_elements(payload->'competitions') c) as codes
from "GeneralDatasetSnapshot";
```

## The workflow this session established (keep following it)

For anything nontrivial: dispatch the owning subagent (`game-engine-architect` for
`packages/game-core`, `football-data-engineer` for `packages/football-data`,
`realtime-backend-engineer` for `apps/api`, `game-ux-engineer` for `apps/web`) to build it, then
dispatch `qa-verifier` for an **independent, adversarial** review — never trust a builder's own
"I tested this" claim at face value. Iterate on `VERDICT: FAIL` until `VERDICT: PASS`, only then
commit and push (which deploys both services immediately and, for `apps/api` changes, wipes
whatever rooms are currently in memory on Render).

This is not process for its own sake — it repeatedly caught real, ship-blocking bugs that would
otherwise have gone live:

- The **gameday mode** (rotate rounds across every live match in a competition) took **four**
  QA-fail rounds to get right. Root cause each time was a variation of "a fixture gets pinned to a
  round before we're sure the round will actually use it." The fix that finally stuck: never pin
  anything until *after* the reducer has accepted the round, and retry other candidates within the
  same dispatch on a content failure.
- The **back-navigation** logic (`apps/web/src/lib/backNavigation.ts`) took **six** rounds across
  the session (spread over the gameday work and later) — five distinct real bugs in browser-history
  edge cases (monotonic counters that never accounted for going back, stale caches after a
  cross-document redirect, Next.js silently wiping `history.state` on every navigation, etc.). Read
  that file's own version-history doc comment before touching it again; it's dense with hard-won
  lessons.
- The **Mixed rotation mode** (today's work) failed twice: once for dropping teams that play in two
  competitions (Liverpool/Atlético/PSG scoped out of their domestic league), once for a real
  information leak (a later round could ask for a shirt number an earlier round had already shown
  on screen). Both fixed and re-verified.

For small, obviously-safe, well-understood fixes (a copy change, a one-line test-count update,
a config tweak with an unambiguous correct value), this session did them directly without spinning
up a full agent+QA round — per explicit user feedback that the multi-round process felt slow when
applied to something that didn't need it. Use judgment on which category a task falls into.

## What got built and shipped today (chronological)

All QA-cleared via the process above unless noted.

1. **Fixed "always 2 sips" drink penalties.** Root cause was in the *engine*
   (`packages/game-core`), not display wording — every wrong/no-answer penalty used one fixed
   configured value. Fix: `rollDrinkSips`/`rolledSelfPenalties` in `penalties.ts`/`helpers.ts` draw
   a weighted random tier through the room's seeded `Rng` (12/30/28/15/10/5% → no drinking / 1 sip /
   2 sips / a chug / a shot / 2 shots). `DEFAULT_PENALTY_CAPS.perPenalty` raised 6→10 so the top
   tier isn't silently truncated. `apps/web/src/lib/drinkCopy.ts` renders the six labels (this part
   shipped slightly earlier and was already correct — the gap was purely that the engine never
   varied the underlying number).
   - **Known gap:** M1 Match Markets' per-lost-market penalty (can fire ~12×/match) is still a
     fixed magnitude — only its no-answer penalty rolls. Deliberate call (rolling every lost-market
     penalty was judged too punishing), but if the user plays M1 a lot they'll still find it
     repetitive. Revisit if asked.
2. **Removed local sign-in/registration/friends UI.** The app is guest-only from its own
   perspective now (pick a nickname, host or join) — login/friends will come from the hub this app
   eventually mounts inside. **The backend `IdentityProvider`/auth REST/friends REST/Prisma tables
   are deliberately untouched** — CLAUDE.md names that as one of four swappable hub-integration
   seams, so it stays as working infrastructure the web UI just stopped calling. New
   `AgeGateGuard`/`lib/ageGate.ts`: a one-time 18+/responsible-drinking confirmation, persisted in
   `localStorage`, gating the host flow, the join flow, AND the `/join/[pin]` deep link a QR code
   resolves to (the removed signup page was the *only* place this notice used to live, so guests
   previously saw it nowhere — this closed a real compliance gap, not just a refactor).
3. **Career Path (G3)** — a real new game module (`packages/game-core/src/modules/g3-career-path.ts`);
   previously only documented in `docs/GAME_CATALOG.md`, never built. Reveals a player's clubs
   oldest-first, multiple-choice, reusing G1's hard-won distractor-fairness design.
4. **"Mixed" rotation mode, one per category** (`G-MIX`/`M-MIX`,
   `packages/game-core/src/modules/mixed.ts`) — the user's explicit ask: "a main game mode... a
   rotation of questions, each round a different game, random." Built as an ordinary `GameModule`
   that wraps and delegates to a randomly-chosen *other* registered module of the same category each
   round (via `ctx.rng`, with per-round candidate retry on an unplayable pick) — **not** a
   reducer/session-level special case, so any future `simultaneous-answer` game added to the
   registry joins the rotation automatically with zero further engine changes. `M1` Match Markets is
   structurally excluded (it's `long-running-bet`-kind, spanning a whole match, not a per-round
   question) — matchday Mixed rotates `M2`/`M3` today, general Mixed rotates `G1`/`G3`/`G6`. Listed
   *first* in the picker per category, per the user's "main game mode" framing.
   - `apps/web/src/games/MixedGameScreen.tsx` + `mixedAdapter.ts`: a thin adapter that unwraps the
     `{kind:'MIXED', moduleId, inner}` envelope and renders the real per-sub-game screen completely
     unmodified — the existing G1/G3/G6/M2/M3 screens have zero awareness they might be running
     inside Mixed.
5. **General rooms can be scoped to one competition** instead of drawing from all of them combined
   (`apps/api/src/engine/general-scope.ts` — a pure in-memory filter of the shared cached dataset,
   cached by dataset object identity, no new provider fetches). Web: a "Competition" picker on the
   General flow, parallel to Matchday's league picker, "All competitions" as the default.
6. **Matchday is greyed out** with "No live games for now" until a background sweep of all
   competitions finds a fresh (kicked off <2h ago) live fixture, re-checked every 90s so it can
   unlock mid-session without a page reload (`apps/web/src/lib/matchdayAvailability.ts`).
7. **National Teams added as a 7th competition.** ESPN has no single feed for international
   football — it's split across ~12 separate league slugs (friendlies, Nations League, World
   Cup/Euro/Copa qualifiers per confederation, the tournaments themselves). New
   `espnAdditionalSlugs`/`allEspnSlugs()` in `packages/football-data/src/competitions.ts` aggregates
   them behind one `CompetitionConfig`, fully backward-compatible with the 6 existing single-slug
   competitions (provably unaffected — same URLs, same request counts). Flows through every
   existing config-driven code path (picker, gameday rotation, general-room scoping, dataset sync)
   with **zero** `apps/web` code changes needed — this is the payoff of the "config map, never
   inline" invariant in CLAUDE.md.

## Known non-blocking issues (not yet fixed, all flagged during QA, none shipped as regressions)

- **Mobile layout:** the room header (`/room/[roomId]`) overflows horizontally at ≤375px width.
  Pre-existing, flagged by multiple QA rounds, never fixed — out of scope each time it came up.
- **`general-scope.ts`'s leaderboard fallback** (for a team with zero `PlayerSeasonStats` rows)
  still keeps only the first competition seen, same bug class as the one that was fixed for the
  stats-row path. Never triggers on the current recorded data (0 such teams), but worth hardening
  before real, live API-Football data introduces one.
- **Mid-season transfers** aren't modeled in `general-scope.ts`'s team→competition filtering — a
  player whose `teamId` doesn't match their `PlayerSeasonStats` row's team (a genuine transfer
  mid-window) would fall out of a scoped view. 0 such cases in current data; a real risk once live
  data reflects an actual transfer window.
- **Playwright e2e suite** was explicitly deferred back in Phase 4 (docs/PLAN.md says so directly)
  and still doesn't exist. All verification since then has been manual/scripted QA-agent browser
  sessions, which have been thorough but aren't a permanent regression suite.
- **Free Render Postgres expires ~2026-10-24.** Not yet decided: upgrade to a paid tier, take
  periodic backups, or accept the data loss and let the dataset re-sync from scratch (rooms/accounts
  would be lost either way — Render's free *web service* already loses in-memory rooms on every
  sleep/redeploy regardless of the database tier).
- **Render free tier sleeps after 15 min idle.** Cold-start impact is now small for general games
  (data loads from the Postgres snapshot in milliseconds) but matchday/live-fixture checks still hit
  live ESPN cold on first use after a wake.

## Next steps (not started, in the order they appear in `docs/PLAN.md`)

- **Phase 5** — remaining matchday games (M4–M10) + M1 in-play markets (deferred from Phase 1) +
  the live-event ingestion loop they need.
- **Phase 6** — remaining general games (G2, G4, G5, G7–G11).
- **Phase 7** — hardening/hub readiness: rate limiting, room lifecycle cleanup, the Playwright
  suite, `docs/HUB_INTEGRATION.md`, a paid-tier decision for Render.
- Confirm the manual dataset sync (see top of this doc) actually ran and National Teams has real
  player data before telling the user it's fully ready.

## Where to read more

- `CLAUDE.md` — the five subagents, the non-negotiable engine invariants, drink-copy conventions.
- `docs/PLAN.md` — phase-by-phase acceptance criteria and QA history for Phases 0–4.
- `docs/ARCHITECTURE.md`, `docs/GAME_CATALOG.md`, `docs/DEPLOYMENT.md` — system design, the full
  game catalog (including still-unbuilt Phase 5/6 games), and the live deployment's setup/quirks.
