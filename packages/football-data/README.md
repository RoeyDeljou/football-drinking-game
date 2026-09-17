# @fdg/football-data

The football data layer. One interface, two wirings, and the normalized domain types everything else in the app is
written against.

```
consumers  ──►  FootballDataProvider  ──┬──►  live wiring     CompositeProvider: EspnProvider (primary)
                                        │                      + WikidataCareerProvider (careers)
                                        │                      + ApiFootballProvider (fallback, only if a
                                        │                        free key is configured)
                                        └──►  fixture wiring  FixtureProvider (recorded JSON, offline,
                                                                deterministic, with match replay)
```

`apps/api`, `apps/web` and `packages/game-core` see **only** `FootballDataProvider` and the domain types in
`src/domain.ts`. No ESPN/Wikidata/API-Football shape, Zod schema, HTTP status, cache or rate limiter ever escapes
the adapter boundary — which is what makes this package the `FootballDataProvider` seam the hub swaps out.

## Quick start

```ts
import { createFootballDataProvider, MatchdayPrefetcher, createGeneralDatasetLoader } from '@fdg/football-data';

// `live` is the default: ESPN + Wikidata, no key required (free, unofficial, real network calls).
const provider = createFootballDataProvider();

// For offline/dev/tests, ask for the recorded snapshot explicitly — no key, no network:
// const provider = createFootballDataProvider({ provider: 'fixture' });

// Matchday: drive the loading screen off real step progress.
const prefetcher = new MatchdayPrefetcher(provider, {
  onProgress: (p) => render(p.steps, p.ratio),
});
const bundle = await prefetcher.run(fixtureId);
if (bundle.ok) {
  enableGames(bundle.value.gameAvailability); // per-game availability from DataQuality
}

// General games: build the season dataset once at app start, then reuse it.
const general = createGeneralDatasetLoader(provider);
const dataset = await general.load();
```

Nothing throws on bad upstream data. Every call returns a `DataResult<T>`: `{ ok: true, value, notes, fromCache }`
or `{ ok: false, error: { kind, message, status, retryable, attempts } }`. `createFootballDataProvider` itself
*can* throw, but only for a genuine misconfiguration — see `FOOTBALL_DATA_PROVIDER` below.

## Choosing a provider

Provider selection happens in exactly one place, `createFootballDataProvider(config)`:

| `config.provider` | Result |
|---|---|
| omitted / `'live'` | `CompositeProvider`: `EspnProvider` (primary, free, no key) + `WikidataCareerProvider` (careers, free, no key), plus `ApiFootballProvider` as a fallback **only if** `apiFootball.apiKey` is set |
| `'fixture'` | `FixtureProvider`: the recorded snapshot in `data/`, fully offline, with match replay |

There is no `'auto'` or `'api-football'` value. `API_FOOTBALL_KEY` does **not** switch anything to live data —
`live` already is the default — it only adds API-Football as a fallback source alongside ESPN.

The API key (when used) is **passed in**, never read from the ambient environment by this package. `apps/api`
bridges the two with `readFootballDataConfigFromEnv`:

```ts
import { createFootballDataProvider, readFootballDataConfigFromEnv } from '@fdg/football-data';

const provider = createFootballDataProvider(readFootballDataConfigFromEnv(process.env));
```

`readFootballDataConfigFromEnv` throws `FootballDataConfigError` if `FOOTBALL_DATA_PROVIDER` is set to anything
other than `live` or `fixture` — a typo'd value is a configuration mistake, not a silent fallback.

### Environment variables

All optional. With none of them set you get the `live` wiring (ESPN + Wikidata, real network calls, no key). Set
`FOOTBALL_DATA_PROVIDER=fixture` for the offline recorded provider — the intended default for CI and tests.

| Variable | Default | Meaning |
|---|---|---|
| `FOOTBALL_DATA_PROVIDER` | `live` | `live` \| `fixture` — anything else throws |
| `FOOTBALL_DATA_USER_AGENT` | `DEFAULT_DATA_USER_AGENT` | Sent to ESPN and Wikidata; Wikimedia requires a descriptive one with a contact URL, deployments should set their own |
| `FOOTBALL_LIVE_POLL_MS` | `15000` | Live event poll interval |
| `ESPN_BASE_URL` | ESPN's public site API | Override to point at a proxy or mock |
| `ESPN_RATE_LIMIT_PER_MINUTE` | see `ESPN_DEFAULT_RATE_LIMIT` | Local request ceiling, expressed per minute, enforced as a 5s window |
| `WIKIDATA_ENABLED` | `true` | Set to `0`/`false`/`no`/`off` to run `live` without career enrichment (G3/G8 then report no career data instead of querying Wikidata) |
| `WIKIDATA_SPARQL_URL` | `WIKIDATA_SPARQL_ENDPOINT` | Override the SPARQL endpoint |
| `WIKIDATA_MAX_QUERIES_PER_HOUR` | see `WIKIDATA_DEFAULT_RATE_LIMIT` | Hard hourly budget; exceeding it fails a query with `RATE_LIMITED` rather than hammering Wikidata |
| `API_FOOTBALL_KEY` | — | Free-tier RapidAPI key (100 requests/day). **Its presence is what adds API-Football as a fallback** alongside ESPN — it does not switch the provider, and `live` works with no key at all |
| `API_FOOTBALL_HOST` | `api-football-v1.p.rapidapi.com` | `x-rapidapi-host` header |
| `API_FOOTBALL_BASE_URL` | `https://api-football-v1.p.rapidapi.com/v3` | Override to point at a proxy or mock |
| `API_FOOTBALL_SEASON` | from `src/competitions.ts` | Season start year, e.g. `2025` |
| `FOOTBALL_DATA_DIR` | packaged `data/` | Directory holding the recorded JSON (`fixture` wiring only) |
| `FOOTBALL_REPLAY_FIXTURE_ID` | — | Recorded fixture to replay (see below; `fixture` wiring only) |
| `FOOTBALL_REPLAY_SPEED` | `1` | Match minutes per real minute |
| `FOOTBALL_REPLAY_START_MINUTE` | `0` | Minute the replay starts at |
| `FOOTBALL_FIXTURE_LATENCY_MS` | `0` | Fake per-call latency, to make the loading screen visible in dev |

Env var names are also exported as `FOOTBALL_DATA_ENV_VARS` so nothing has to spell them twice.

## Replaying a match with no live match

`FixtureProvider` can replay a recorded timeline, which is how matchday games get developed and tested on a
Tuesday morning. `data/timelines/401915445.json` is a real, complete Paris Saint-Germain 6–1 Slovan Bratislava
(UEFA Champions League) timeline — 89 events, genuinely kick-off to full time.

```bash
FOOTBALL_REPLAY_FIXTURE_ID=401915445 FOOTBALL_REPLAY_SPEED=10 npm run dev
```

At `SPEED=10` the match plays out in well under ten real minutes. The match minute is a **pure function of the
injected clock times the speed multiplier** — there is no `setTimeout`-driven mode — so tests drive it exactly.
`createFootballDataProvider` returns the `FootballDataProvider` interface, which has no replay controls by
design (a hub's own provider has no concept of "replay"); to drive a replay directly, construct `FixtureProvider`
itself:

```ts
import { asFixtureId, createManualClock, FixtureProvider, createNodeDataSource } from '@fdg/football-data';

const clock = createManualClock();
const provider = new FixtureProvider({
  dataSource: createNodeDataSource(),
  clock,
  replay: { fixtureId: '401915445', speedMultiplier: 10, autoStart: false },
});
await provider.ready();

provider.advanceReplayTo(57);                 // explicit: jump to just after Ferran Torres' 4th goal
const live = await provider.getLiveMatchState(asFixtureId('401915445'));
// live.value.fixture.score -> { home: 4, away: 0 }, minute 55

provider.advanceReplayTo(94);                 // the real final whistle for this match
// live re-fetched here -> status 'FINISHED', score { home: 6, away: 1 }

await clock.advance(60_000);                  // or let the clock drive it instead: +10 elapsed minutes
```

The replay derives everything a live feed would report at that minute: status (`SCHEDULED` → `LIVE` →
`HALF_TIME` → `LIVE` → `FINISHED`, taken from the period markers in the feed), score and half-time score from the
goal events, counting stats (corners, cards, shots, offsides, fouls) from the events that have actually fired, and
rate stats (possession, passes, pass accuracy) converging on the recorded full-time values.

## Request budget

Every live source goes through the same shared pipeline (`src/upstream.ts`), each with its own polite, conservative
rate limit — these are unofficial/free endpoints, so the defaults favour not getting blocked over throughput:

```
TTL cache  →  request coalescing  →  rate limiter  →  HTTP with retry/backoff  →  Zod  →  normalize
```

- **TTL cache** — per-endpoint expiry (`DEFAULT_CACHE_TTL`): 15s for live events, 5m for lineups, 6h for season
  stats, 12h for squads, 24h for player profiles. Failures are never cached.
- **Coalescing** — N concurrent callers on the same key produce exactly one upstream call. Twenty players joining
  a room at once is one request, not twenty.
- **Rate limiter** — sliding window, queued in arrival order. ESPN defaults to `ESPN_DEFAULT_RATE_LIMIT` (5
  requests / 5s, 2 concurrent — tune with `ESPN_RATE_LIMIT_PER_MINUTE`); Wikidata defaults to
  `WIKIDATA_DEFAULT_RATE_LIMIT` (1 request / 2s, 1 concurrent) plus the separate hourly query budget in
  `WIKIDATA_MAX_QUERIES_PER_HOUR`; API-Football (fallback only) is bounded by its own free-tier ceiling (100
  requests/day).
- **Retry** — exponential backoff with jitter on 429 and 5xx (honouring `Retry-After`), and on network errors and
  timeouts. 4xx other than 429 is **not** retried, because repeating it only burns quota.

Documented poll intervals live in `DEFAULT_POLL_INTERVALS`. At the default 15s event poll, a 90-minute match costs
roughly 360 event calls plus ~180 statistics calls per room — and the cache means concurrent rooms on the same
fixture share them.

## Missing data is normal

Upstream data is routinely incomplete: lineups are not published until an hour before kick-off, API-Football
carries no market values at all, career history depends on a separate transfers endpoint. None of that is an
error. Partial data normalizes to explicit `null`/`[]` plus a `DataQuality` report:

```ts
const quality = bundle.value.quality;         // hasLineups, hasShirtNumbers, hasLiveEvents, …, notes[]
const availability = bundle.value.gameAvailability;
// [{ gameId: 'M3', available: false, missing: ['hasShirtNumbers'] }, …]
```

`GAME_DATA_REQUIREMENTS` maps every catalog game id to the capabilities it needs, so the engine disables a game
whose data is unavailable instead of generating a broken round. Adding a game means adding one row to that map.

## Public API

Built for three kinds of consumer:

**Everyone** — `createFootballDataProvider`, `readFootballDataConfigFromEnv`, `describeLiveWiring`,
`FootballDataProvider`, the domain types, `DataResult` helpers, `MatchdayPrefetcher`, `createGeneralDatasetLoader`,
`evaluateGameAvailability`, `buildGuessableStats` (G7).

**Competitions** — `COMPETITIONS`, `COMPETITION_CONFIGS`, `competitionConfigById/ByCode/ByApiFootballId/ByEspnSlug`,
`allCompetitions`, `seasonLabel`, `seasonStartYear`. The six supported competitions and their ESPN slugs /
API-Football league ids live in `src/competitions.ts` and nowhere else; never spell a provider id at a call site.

**Tests and the hub** — `createManualClock`, `createInMemoryDataSource`, `ResourceCache`, `RateLimiter`,
`requestWithRetry`, `MatchReplay`, `loadRecordedDataset`, `createTeamNameResolver`, and every source's `normalize*`
functions (`espn/normalize.ts`, `api-football/normalize.ts`).

## Layout

```
src/domain.ts                        the frozen normalized contract (game-core imports it type-only)
src/competitions.ts                  the one competitions config map (ESPN slugs + API-Football league ids)
src/provider.ts                      FootballDataProvider + poll intervals
src/result.ts                        DataResult / DataError
src/factory.ts                       createFootballDataProvider + env bridge (the only place that decides the wiring)
src/composite.ts                     CompositeProvider: routes each capability, merges, reports provenance
src/clock.ts                         DataClock port, system clock, createManualClock
src/cache.ts                         TTL cache + request coalescing
src/rate-limiter.ts                  sliding-window limiter with a queue
src/http.ts                          HttpClient port + retry/backoff
src/upstream.ts                      shared fetch→cache→rate-limit→retry pipeline used by ESPN and Wikidata
src/team-names.ts                    name → recorded team id resolver, used to link Wikidata careers to real teams
src/guessable-stats.ts               builds the "guess the value" facts G7 draws from
src/data-quality.ts                  DataQuality assessment + game requirement map
src/prefetch.ts                      MatchdayPrefetcher (fixture → lineups → squads → stats)
src/general-dataset.ts               GeneralDataset builder + app-start cache
src/espn/                            schemas.ts (raw shapes, lenient) · normalize.ts (pure mapping) · the provider
src/wikidata/                        SPARQL query building + the career provider
src/api-football/                    schemas.ts (raw shapes) · normalize.ts (pure mapping) · the provider (fallback)
src/fixture/                         recorded-schema.ts · dataset.ts · replay.ts · the provider
src/data-source.ts                   DataSource port + the in-memory implementation (tests, browser bundles)
src/node-data-source.ts              the Node filesystem implementation — the only module that imports node:fs
data/                                recorded sample data (see data/README.md)
```

## Tests

Entirely offline. `npm test` from the repo root; no API key, no network, no real timers — the rate limiter,
backoff and match replay all run on `createManualClock`, and the live adapter is driven through a fake
`HttpClient` fed from `data/raw-samples/`.
