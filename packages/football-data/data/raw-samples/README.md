# Raw upstream sample payloads

Recorded raw responses from the free data sources, kept in their *raw upstream shape* so each adapter's
normalizer can be tested offline against real-looking (or, for `espn/` and `wikidata/`, genuinely real) payloads
with no network and no key.

- **`espn/`** — real responses from the ESPN public site API, fetched once on 2026-09-16 with a descriptive
  User-Agent and saved verbatim (pretty-printed). See `espn/README.md`.
- **`wikidata/`** — real SPARQL results from the Wikidata Query Service, fetched the same day. See
  `wikidata/README.md`.
- **top-level files** — hand-written reproductions of API-Football v3 (RapidAPI) response envelopes. API-Football
  is the optional fallback provider (free key, 100 requests/day, never required), so its samples are illustrative
  rather than a live recording; they are deliberately messy in the ways the real API is messy, because that is
  the point:

| File | Endpoint | What it exercises |
|---|---|---|
| `fixtures.json` | `GET /fixtures?league=39&season=2025` | normal fixtures, `FT`/`NS`/`1H` statuses, `round` labels |
| `fixtures-partial.json` | `GET /fixtures?id=…` | `venue: null`, `goals` null on a live match, an unsupported league id |
| `lineups.json` | `GET /fixtures/lineups?fixture=…` | grid positions, a missing shirt number, a null `pos` |
| `lineups-incomplete.json` | `GET /fixtures/lineups?fixture=…` | a pre-publication payload with one side only |
| `events.json` | `GET /fixtures/events?fixture=…` | `Goal`/`Card`/`subst`/`Var` type+detail pairs, an event with a null minute |
| `statistics.json` | `GET /fixtures/statistics?fixture=…` | `"52%"` strings, `null` values, a missing statistic type |
| `fixture-players.json` | `GET /fixtures/players?fixture=…` | nested per-player match statistics, a string `rating` |
| `squads.json` | `GET /players/squads?team=42` | squad list with a null player id |
| `players.json` | `GET /players?league=39&season=2025` | bios plus per-competition statistics blocks, `"183 cm"` heights |
| `transfers.json` | `GET /transfers?player=…` | newest-first transfer list used to rebuild a career |
| `error-envelope.json` | any | HTTP 200 carrying a populated `errors` object (rate-limit / plan message) |

Player and team ids here are the real API-Football ids for those clubs where they are well known (Arsenal 42,
Liverpool 40, league 39 = Premier League); player ids and all statistics are invented for these samples.
