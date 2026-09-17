# Raw Wikidata sample payloads

Real SPARQL results from `query.wikidata.org/sparql`, fetched once on **2026-09-16** with the User-Agent
`FootballDrinkingGame/0.1 (+https://github.com/football-drinking-game; one-off sample recording)`. Each file is
exactly the `application/sparql-results+json` body — what `src/wikidata/sparql.ts#sparqlResultsSchema` validates
and `src/wikidata/normalize.ts` consumes. `src/wikidata/normalize.test.ts` reads these, never the network.

| File | Query | What it captures |
|---|---|---|
| `candidates-by-birthdate.json` | `candidatesByBirthDateQuery(...)` — every association footballer (P106=Q937857) born on one of ~35 batched dates of birth (P569) | 1,435 bindings: the real name-collision problem this package's matcher has to solve (many footballers share a birth date) |
| `careers.json` | `careersQuery(...)` — `P54` (member of sports team) statements with `P580`/`P582`/`P1350`/`P1351` qualifiers for a batch of 12 matched entities | 80 bindings covering club spells, national-team spells (to be excluded from the club career) and youth spells |

These were recorded while building `data/careers.json` from the real ESPN lineups in this snapshot — see
`packages/football-data/data/README.md` for how the two sources were combined.
