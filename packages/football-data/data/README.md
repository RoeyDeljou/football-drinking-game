# Recorded dataset — a dated real-data snapshot

> **This is a frozen snapshot of real data, not a live feed.**
>
> Every club, player, fixture, lineup, match event and statistic in this directory was fetched from the free
> ESPN public site API and the Wikidata Query Service on **2026-09-16** (`recordedAt` in every file's
> `provenance` block) and normalized by `@fdg/football-data`. The results, scorelines, lineups and statistics
> were real and current on that date — they are **not** kept up to date, and by the time you read this the
> actual matches will have been played, squads will have changed, and season totals will have moved on. Treat
> every number here as "true as of 2026-09-16", never as live.
>
> For actually current data, configure the live wiring instead of `FixtureProvider` — see `../README.md`.

`FixtureProvider` loads this directory and answers every `FootballDataProvider` call from it, so the whole app
runs offline, deterministically, with no API key and no network. The test suite uses nothing else.

## Layout

```
index.json                     names the competition files, the career file and the timelines
competitions/<slug>.json       one file per competition: teams, players, season stats, fixtures, lineups, live states
careers.json                   career histories keyed by player id
timelines/<fixtureId>.json     a full kick-off-to-full-time event timeline for the replay provider
raw-samples/                   raw ESPN + Wikidata + API-Football payloads, used to test the adapters' normalizers
```

Files are written in the **normalized domain shape** (`src/domain.ts`), because they are a recording of what the
providers produce — not a second wire format. `src/fixture/recorded-schema.ts` validates every file on load, so a
hand-edit that breaks the shape fails immediately with a field path.

## How it was built

`data/raw-samples/espn/` and `data/raw-samples/wikidata/` hold the real raw responses this snapshot was built
from (see their own READMEs). The build read those same endpoints for four clubs per competition (plus a
Champions League quartet), ran them through the package's own `normalizeEspn*` functions, and layered in career
history from the real `WikidataCareerProvider` matched against the ESPN lineups — the same code path the live
provider uses, just recorded once instead of called live. Nothing in this directory is invented: it is real
September 2026 football, frozen.

## What is in it

| Competition | Clubs (as recorded) | Players w/ season stats | Fixtures | Lineups | Live/finished states |
|---|---|---|---|---|---|
| Premier League | Man United, Man City, Liverpool, Fulham, Brentford, Chelsea | 77 | 3 (2 finished + 1 scheduled) | 2 | 2 |
| La Liga | Levante, Barcelona, Atlético Madrid, Osasuna, Racing Santander, Athletic Club | 83 | 4 (1 finished, 1 live, 2 scheduled) | 2 | 2 |
| Serie A | Lazio, AC Milan, Napoli, Bologna, Monza, Sassuolo | 86 | 3 (2 finished + 1 scheduled) | 2 | 2 |
| Bundesliga | SV Elversberg, Bayern Munich, Borussia Dortmund, SC Paderborn 07, 1. FC Union Berlin | 78 | 3 (2 finished + 1 scheduled) | 2 | 2 |
| Ligue 1 | Brest, Paris Saint-Germain, Strasbourg, AS Monaco, Lens | 80 | 3 (2 finished + 1 scheduled) | 2 | 2 |
| UEFA Champions League | Liverpool, Atlético Madrid, Paris Saint-Germain, Slovan Bratislava | 64 | 2 (both finished) | 2 | 2 |

Real results captured in this snapshot: Manchester United 0–1 Manchester City, Liverpool 0–0 Fulham, Levante
2–4 Barcelona, Atlético Madrid 1–0 Osasuna (captured live, second half), Lazio 2–2 AC Milan, Napoli 1–0 Bologna,
SV Elversberg 1–2 Bayern Munich, Borussia Dortmund 3–0 SC Paderborn 07, Strasbourg 1–1 AS Monaco, Brest 0–1 Paris
Saint-Germain, Liverpool 2–1 Atlético Madrid (Champions League), Paris Saint-Germain 6–1 Slovan Bratislava
(Champions League).

- **699 player rows across the six competition files** (players appear once per competition they were recorded
  in — the same person plays for the same club in La Liga and the Champions League, for instance), each with
  nationality, date of birth, age, height, position, shirt number and photo URL as ESPN reported them.
- **Season statistics** for 77–86 players per domestic competition and 64 in the Champions League slice, all
  comfortably past the 40-player minimum — appearances, minutes (estimated from starts/sub-appearances, since
  ESPN's roster endpoint does not publish minutes directly — see the note every such row carries), goals,
  assists, shots, shots on target and cards. Pass accuracy, tackles and per-match ratings are not published by
  ESPN's free roster endpoint and are `null`, which is reported through `DataQuality`.
- **Confirmed lineups** for every non-scheduled fixture: 11 starters with real shirt numbers and positions plus
  the real substitutes bench, both sides, both the "finished" and "live" fixture per competition.
- **184 career histories** in `careers.json` (well past the 60-player minimum), resolved on Wikidata by exact
  name + date-of-birth match — never a guess — from the lineup starters of every recorded fixture. 241 lineup
  starters were looked up; 236 matched a single Wikidata footballer entity unambiguously, but only 184 of those
  entities have club-spell statements recorded on Wikidata (the other 52 matched players have none), and 5 players
  had no match at all. The 57 players with no usable career (52 empty + 5 unmatched) simply have no entry; that is
  reported through `DataQuality.hasCareerHistory` rather than papered over. National and youth teams are excluded
  from the club sequence. Every career-step club name is linked back to this dataset's own team id wherever the
  offline `src/team-names.ts` resolver — the same one `CompositeProvider` uses live — can match it unambiguously
  (a club a player passed through that never played one of our recorded fixtures naturally stays unlinked).
- **One full recorded match event timeline**, `timelines/401915445.json` — Paris Saint-Germain 6–1 Slovan
  Bratislava (UEFA Champions League), genuinely kick-off to full time: 89 real events built from ESPN's key events
  plus play-by-play commentary, ending at the real full-time whistle, which is what `MatchReplay` plays back.
- **Market values are absent** (`marketValueEur: null` everywhere): no free source publishes them. `G7` no
  longer needs them — see `../README.md` for the "Guess the Number" redesign.

## Editing

These files are the source of truth for offline runs and for the test suite. Two rules if you touch them by hand:

1. Keep the normalized domain shape. `loadRecordedDataset` validates every file with Zod and reports the exact
   field path on failure, so a mistake surfaces on the first provider call rather than mid-game.
2. Keep the invariants the tests assert: unique squad numbers per club, one goalkeeper per starting XI, events
   referencing real squad members, both XIs at full strength for every non-scheduled fixture.

Adding a competition means adding a row to `competitions/`, listing it in `index.json`, and nothing else — the
competition itself is already declared in `src/competitions.ts`.

## Refreshing the snapshot

To record a fresh dated snapshot: fetch the ESPN and Wikidata endpoints listed in `raw-samples/espn/README.md`
and `raw-samples/wikidata/README.md` for whichever clubs and fixtures you want, run them through
`normalizeEspn*`/`WikidataCareerProvider` exactly as the live provider does, and write the result in this
directory's shape. There is no scripted "refresh" command checked into the repo — the point of this dataset is
that it is a deliberate, reviewed, dated recording, not a rolling cache.
