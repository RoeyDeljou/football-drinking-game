# Raw ESPN sample payloads

Real responses from `site.api.espn.com`, fetched once on **2026-09-16** with the User-Agent
`FootballDrinkingGame/0.1 (+https://github.com/football-drinking-game)` and saved verbatim (pretty-printed, no
edits). `src/espn/normalize.test.ts` validates and normalizes each one; the tests only read these files, never
the network.

| File | Endpoint | What it captures |
|---|---|---|
| `scoreboard-esp.1.json` | `GET /soccer/esp.1/scoreboard` | Two La Liga matches at half time (`STATUS_HALFTIME`) and two `STATUS_SCHEDULED`; scores as strings, all four with a real venue |
| `summary-finished-psg-slovan.json` | `GET /soccer/all/summary?event=401915445` | Paris Saint-Germain 6–1 Slovan Bratislava (UEFA Champions League, finished): 26 key events, 107 commentary plays, two full 23-player rosters with starters/subs/formation |
| `summary-live-atm-osasuna.json` | `GET /soccer/all/summary?event=401882875` | Atlético Madrid v Osasuna mid-second-half (`STATUS_SECOND_HALF`, `52'`): in-progress boxscore and roster stats |
| `teams-eng.1.json` | `GET /soccer/eng.1/teams` | The full Premier League team list |
| `roster-mancity.json` | `GET /soccer/eng.1/teams/382/roster` | Manchester City's 27-player roster with embedded season statistics (appearances, goals, assists, shots, cards) |

These are exactly the shapes `src/espn/schemas.ts` validates leniently and `src/espn/normalize.ts` turns into
domain types — including the messy bits: string scores and jersey numbers, a `null` venue on an unstarted fixture,
`passPct` as a 0–1 fraction, and roster players with no statistics yet this season.
